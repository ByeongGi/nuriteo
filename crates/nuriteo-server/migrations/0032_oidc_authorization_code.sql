-- One-time, server-owned OIDC authorization-code + PKCE login attempts.

CREATE TABLE oidc_login_attempts (
    id uuid PRIMARY KEY,
    provider_id uuid NOT NULL,
    provider_config_version bigint NOT NULL,
    provider_secret_version bigint NOT NULL,
    state_hash bytea NOT NULL,
    nonce_hash bytea NOT NULL,
    browser_binding_hash bytea NOT NULL,
    pkce_algorithm text NOT NULL DEFAULT 'aes-256-gcm-v1',
    pkce_key_version integer NOT NULL,
    pkce_nonce bytea NOT NULL,
    pkce_ciphertext bytea NOT NULL,
    redirect_uri text NOT NULL,
    created_at timestamptz NOT NULL DEFAULT CURRENT_TIMESTAMP,
    expires_at timestamptz NOT NULL,
    consumed_at timestamptz,
    authorization_code_hash bytea,
    completed_at timestamptz,
    session_id uuid,
    CONSTRAINT oidc_login_attempts_provider_fk
        FOREIGN KEY (provider_id) REFERENCES oidc_providers(id) ON DELETE RESTRICT,
    CONSTRAINT oidc_login_attempts_session_fk
        FOREIGN KEY (session_id) REFERENCES sessions(id) ON DELETE RESTRICT,
    CONSTRAINT oidc_login_attempts_id_v7_check CHECK (
        (get_byte(uuid_send(id), 6) >> 4) = 7
        AND (get_byte(uuid_send(id), 8) & 192) = 128
    ),
    CONSTRAINT oidc_login_attempts_generation_check CHECK (
        provider_config_version >= 1 AND provider_secret_version >= 1
    ),
    CONSTRAINT oidc_login_attempts_hash_check CHECK (
        octet_length(state_hash) = 32 AND octet_length(nonce_hash) = 32
        AND octet_length(browser_binding_hash) = 32
        AND (authorization_code_hash IS NULL OR octet_length(authorization_code_hash) = 32)
    ),
    CONSTRAINT oidc_login_attempts_pkce_check CHECK (
        pkce_algorithm = 'aes-256-gcm-v1' AND pkce_key_version >= 1
        AND octet_length(pkce_nonce) = 12
        AND octet_length(pkce_ciphertext) BETWEEN 44 AND 256
    ),
    CONSTRAINT oidc_login_attempts_redirect_check CHECK (
        redirect_uri = btrim(redirect_uri) AND redirect_uri !~ '[[:cntrl:]]'
        AND char_length(redirect_uri) BETWEEN 8 AND 2048
    ),
    CONSTRAINT oidc_login_attempts_expiry_check CHECK (
        expires_at > created_at AND expires_at <= created_at + INTERVAL '10 minutes'
    ),
    CONSTRAINT oidc_login_attempts_lifecycle_check CHECK (
        (consumed_at IS NULL AND authorization_code_hash IS NULL
         AND completed_at IS NULL AND session_id IS NULL)
        OR
        (consumed_at IS NOT NULL AND authorization_code_hash IS NOT NULL
         AND completed_at IS NULL AND session_id IS NULL)
        OR
        (consumed_at IS NOT NULL AND authorization_code_hash IS NOT NULL
         AND completed_at IS NOT NULL AND session_id IS NOT NULL
         AND completed_at >= consumed_at)
    )
);

CREATE UNIQUE INDEX oidc_login_attempts_state_hash_unique
    ON oidc_login_attempts(state_hash);
CREATE UNIQUE INDEX oidc_login_attempts_code_hash_unique
    ON oidc_login_attempts(provider_id, authorization_code_hash)
    WHERE authorization_code_hash IS NOT NULL;
CREATE INDEX oidc_login_attempts_expiry_idx
    ON oidc_login_attempts(expires_at, id) WHERE completed_at IS NULL;

CREATE FUNCTION enforce_oidc_login_attempt_insert() RETURNS trigger
LANGUAGE plpgsql AS $$
BEGIN
    IF NEW.consumed_at IS NOT NULL OR NEW.authorization_code_hash IS NOT NULL
       OR NEW.completed_at IS NOT NULL OR NEW.session_id IS NOT NULL THEN
        RAISE EXCEPTION 'OIDC login attempt must start pending';
    END IF;
    RETURN NEW;
END;
$$;

CREATE TRIGGER oidc_login_attempts_insert_guard
BEFORE INSERT ON oidc_login_attempts
FOR EACH ROW EXECUTE FUNCTION enforce_oidc_login_attempt_insert();

CREATE FUNCTION enforce_oidc_login_attempt_update() RETURNS trigger
LANGUAGE plpgsql AS $$
BEGIN
    IF OLD.id <> NEW.id OR OLD.provider_id <> NEW.provider_id
       OR OLD.provider_config_version <> NEW.provider_config_version
       OR OLD.provider_secret_version <> NEW.provider_secret_version
       OR OLD.state_hash <> NEW.state_hash OR OLD.nonce_hash <> NEW.nonce_hash
       OR OLD.browser_binding_hash <> NEW.browser_binding_hash
       OR OLD.pkce_algorithm <> NEW.pkce_algorithm
       OR OLD.pkce_key_version <> NEW.pkce_key_version
       OR OLD.pkce_nonce <> NEW.pkce_nonce
       OR OLD.pkce_ciphertext <> NEW.pkce_ciphertext
       OR OLD.redirect_uri <> NEW.redirect_uri
       OR OLD.created_at <> NEW.created_at OR OLD.expires_at <> NEW.expires_at THEN
        RAISE EXCEPTION 'OIDC login attempt binding is immutable';
    END IF;
    IF OLD.consumed_at IS NULL THEN
        IF NEW.consumed_at IS NULL OR NEW.authorization_code_hash IS NULL
           OR NEW.completed_at IS NOT NULL OR NEW.session_id IS NOT NULL THEN
            RAISE EXCEPTION 'OIDC login attempt must be consumed once';
        END IF;
    ELSIF OLD.completed_at IS NULL THEN
        IF NEW.consumed_at <> OLD.consumed_at
           OR NEW.authorization_code_hash <> OLD.authorization_code_hash
           OR NEW.completed_at IS NULL OR NEW.session_id IS NULL THEN
            RAISE EXCEPTION 'OIDC login attempt completion is invalid';
        END IF;
    ELSE
        RAISE EXCEPTION 'completed OIDC login attempt is immutable';
    END IF;
    RETURN NEW;
END;
$$;

CREATE TRIGGER oidc_login_attempts_update_guard
BEFORE UPDATE ON oidc_login_attempts
FOR EACH ROW EXECUTE FUNCTION enforce_oidc_login_attempt_update();

CREATE FUNCTION protect_oidc_login_attempt_delete() RETURNS trigger
LANGUAGE plpgsql AS $$
BEGIN
    IF OLD.expires_at > transaction_timestamp() - INTERVAL '30 days' THEN
        RAISE EXCEPTION 'OIDC login attempt retention has not elapsed';
    END IF;
    RETURN OLD;
END;
$$;

CREATE TRIGGER oidc_login_attempts_delete_guard
BEFORE DELETE ON oidc_login_attempts
FOR EACH ROW EXECUTE FUNCTION protect_oidc_login_attempt_delete();
