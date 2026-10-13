-- Local-account TOTP enrollment persistence. TOTP seeds are encrypted by the
-- application master-key envelope; recovery codes are stored only as Argon2id
-- PHC strings and are deleted when consumed or superseded.

CREATE TABLE mfa_totp_credentials (
    id uuid PRIMARY KEY,
    user_id uuid NOT NULL,
    state text NOT NULL,
    secret_version bigint NOT NULL DEFAULT 1,
    algorithm text NOT NULL,
    key_version integer NOT NULL,
    nonce bytea NOT NULL,
    ciphertext bytea NOT NULL,
    created_at timestamptz NOT NULL DEFAULT CURRENT_TIMESTAMP,
    updated_at timestamptz NOT NULL DEFAULT CURRENT_TIMESTAMP,
    activated_at timestamptz,
    terminal_at timestamptz,
    CONSTRAINT mfa_totp_credentials_user_fk
        FOREIGN KEY (user_id) REFERENCES users (id) ON DELETE RESTRICT,
    CONSTRAINT mfa_totp_credentials_uuid_v7_check CHECK (
        (get_byte(uuid_send(id), 6) >> 4) = 7
        AND (get_byte(uuid_send(id), 8) & 192) = 128
    ),
    CONSTRAINT mfa_totp_credentials_state_check
        CHECK (state IN ('pending', 'active', 'disabled', 'replaced')),
    CONSTRAINT mfa_totp_credentials_secret_check CHECK (
        secret_version >= 1
        AND algorithm = 'aes-256-gcm-v1'
        AND key_version >= 1
        AND octet_length(nonce) = 12
        AND octet_length(ciphertext) BETWEEN 17 AND 1040
    ),
    CONSTRAINT mfa_totp_credentials_nonce_unique UNIQUE (key_version, nonce),
    CONSTRAINT mfa_totp_credentials_lifecycle_check CHECK (
        (state = 'pending' AND activated_at IS NULL AND terminal_at IS NULL)
        OR (state = 'active' AND activated_at IS NOT NULL AND terminal_at IS NULL)
        OR (state = 'disabled' AND activated_at IS NOT NULL AND terminal_at IS NOT NULL)
        OR (state = 'replaced' AND terminal_at IS NOT NULL)
    ),
    CONSTRAINT mfa_totp_credentials_timestamps_check CHECK (
        updated_at >= created_at
        AND (activated_at IS NULL OR activated_at >= created_at)
        AND (terminal_at IS NULL OR terminal_at >= created_at)
        AND (terminal_at IS NULL OR activated_at IS NULL OR terminal_at >= activated_at)
    )
);

CREATE UNIQUE INDEX mfa_totp_one_pending_per_user_idx
    ON mfa_totp_credentials (user_id) WHERE state = 'pending';
CREATE UNIQUE INDEX mfa_totp_one_active_per_user_idx
    ON mfa_totp_credentials (user_id) WHERE state = 'active';
CREATE INDEX mfa_totp_user_history_idx
    ON mfa_totp_credentials (user_id, created_at DESC, id DESC);

CREATE FUNCTION enforce_mfa_totp_credential_insert() RETURNS trigger
LANGUAGE plpgsql AS $$
BEGIN
    IF NEW.state <> 'pending'
       OR NEW.activated_at IS NOT NULL
       OR NEW.terminal_at IS NOT NULL THEN
        RAISE EXCEPTION 'MFA TOTP credential must be inserted as pending';
    END IF;
    RETURN NEW;
END;
$$;

CREATE TRIGGER mfa_totp_credentials_insert_guard
BEFORE INSERT ON mfa_totp_credentials
FOR EACH ROW EXECUTE FUNCTION enforce_mfa_totp_credential_insert();

CREATE FUNCTION enforce_mfa_totp_credential_update() RETURNS trigger
LANGUAGE plpgsql AS $$
BEGIN
    IF OLD.id <> NEW.id
       OR OLD.user_id <> NEW.user_id
       OR OLD.secret_version <> NEW.secret_version
       OR OLD.algorithm <> NEW.algorithm
       OR OLD.created_at <> NEW.created_at THEN
        RAISE EXCEPTION 'MFA TOTP credential immutable fields cannot change';
    END IF;
    IF NEW.updated_at < OLD.updated_at THEN
        RAISE EXCEPTION 'MFA TOTP credential timestamp cannot move backwards';
    END IF;
    IF OLD.state = 'active' AND NEW.state IN ('disabled', 'replaced')
       AND EXISTS(SELECT 1 FROM mfa_recovery_codes WHERE credential_id = OLD.id) THEN
        RAISE EXCEPTION 'MFA recovery codes must be revoked before terminal transition';
    END IF;
    IF OLD.state = NEW.state
       AND OLD.activated_at IS NOT DISTINCT FROM NEW.activated_at
       AND OLD.terminal_at IS NOT DISTINCT FROM NEW.terminal_at
       AND OLD.key_version <> NEW.key_version
       AND OLD.nonce <> NEW.nonce
       AND OLD.ciphertext <> NEW.ciphertext THEN
        RETURN NEW;
    END IF;
    IF OLD.key_version <> NEW.key_version
       OR OLD.nonce <> NEW.nonce
       OR OLD.ciphertext <> NEW.ciphertext THEN
        RAISE EXCEPTION 'MFA TOTP ciphertext may change only during key rotation';
    END IF;
    IF NOT (
        (OLD.state = 'pending' AND NEW.state = 'active'
            AND OLD.activated_at IS NULL AND NEW.activated_at IS NOT NULL
            AND OLD.terminal_at IS NULL AND NEW.terminal_at IS NULL)
        OR (OLD.state = 'pending' AND NEW.state = 'replaced'
            AND OLD.activated_at IS NULL AND NEW.activated_at IS NULL
            AND OLD.terminal_at IS NULL AND NEW.terminal_at IS NOT NULL)
        OR (OLD.state = 'active' AND NEW.state IN ('disabled', 'replaced')
            AND OLD.activated_at = NEW.activated_at
            AND OLD.terminal_at IS NULL AND NEW.terminal_at IS NOT NULL)
    ) THEN
        RAISE EXCEPTION 'invalid MFA TOTP credential lifecycle transition';
    END IF;
    RETURN NEW;
END;
$$;

CREATE TRIGGER mfa_totp_credentials_update_guard
BEFORE UPDATE ON mfa_totp_credentials
FOR EACH ROW EXECUTE FUNCTION enforce_mfa_totp_credential_update();

CREATE FUNCTION protect_mfa_totp_credential_history() RETURNS trigger
LANGUAGE plpgsql AS $$
BEGIN
    RAISE EXCEPTION 'MFA TOTP credential history cannot be deleted';
END;
$$;

CREATE TRIGGER mfa_totp_credentials_delete_guard
BEFORE DELETE ON mfa_totp_credentials
FOR EACH ROW EXECUTE FUNCTION protect_mfa_totp_credential_history();

CREATE TABLE mfa_recovery_codes (
    id uuid PRIMARY KEY,
    credential_id uuid NOT NULL,
    user_id uuid NOT NULL,
    slot smallint NOT NULL,
    code_hash text NOT NULL,
    created_at timestamptz NOT NULL DEFAULT CURRENT_TIMESTAMP,
    CONSTRAINT mfa_recovery_codes_credential_fk
        FOREIGN KEY (credential_id) REFERENCES mfa_totp_credentials (id) ON DELETE RESTRICT,
    CONSTRAINT mfa_recovery_codes_user_fk
        FOREIGN KEY (user_id) REFERENCES users (id) ON DELETE RESTRICT,
    CONSTRAINT mfa_recovery_codes_uuid_v7_check CHECK (
        (get_byte(uuid_send(id), 6) >> 4) = 7
        AND (get_byte(uuid_send(id), 8) & 192) = 128
    ),
    CONSTRAINT mfa_recovery_codes_hash_check CHECK (
        code_hash LIKE '$argon2id$%'
        AND char_length(code_hash) BETWEEN 64 AND 512
    ),
    CONSTRAINT mfa_recovery_codes_slot_check CHECK (slot BETWEEN 1 AND 20),
    CONSTRAINT mfa_recovery_codes_slot_unique UNIQUE (credential_id, slot)
);

CREATE INDEX mfa_recovery_codes_credential_idx
    ON mfa_recovery_codes (credential_id, id);
CREATE INDEX mfa_recovery_codes_user_idx
    ON mfa_recovery_codes (user_id, id);

CREATE FUNCTION enforce_mfa_recovery_code_insert() RETURNS trigger
LANGUAGE plpgsql AS $$
BEGIN
    PERFORM 1 FROM mfa_totp_credentials credential
        WHERE credential.id = NEW.credential_id
          AND credential.user_id = NEW.user_id
          AND credential.state = 'active'
        FOR UPDATE;
    IF NOT FOUND THEN
        RAISE EXCEPTION 'MFA recovery code requires an active matching credential';
    END IF;
    RETURN NEW;
END;
$$;

CREATE TRIGGER mfa_recovery_codes_insert_guard
BEFORE INSERT ON mfa_recovery_codes
FOR EACH ROW EXECUTE FUNCTION enforce_mfa_recovery_code_insert();

CREATE FUNCTION reject_mfa_recovery_code_update() RETURNS trigger
LANGUAGE plpgsql AS $$
BEGIN
    RAISE EXCEPTION 'MFA recovery codes are immutable';
END;
$$;

CREATE TRIGGER mfa_recovery_codes_update_guard
BEFORE UPDATE ON mfa_recovery_codes
FOR EACH ROW EXECUTE FUNCTION reject_mfa_recovery_code_update();

CREATE VIEW mfa_totp_metadata AS
SELECT id, user_id, state, secret_version, key_version,
       created_at, updated_at, activated_at, terminal_at
FROM mfa_totp_credentials;
