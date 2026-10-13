-- MFA-002 TOTP replay and bounded failure state. One row belongs to one
-- immutable credential generation so replacing an enrollment cannot transfer
-- accepted counters or lockout history to another encrypted seed.

CREATE TABLE mfa_challenge_states (
    credential_id uuid PRIMARY KEY,
    user_id uuid NOT NULL,
    last_accepted_counter bigint,
    failure_count smallint NOT NULL DEFAULT 0,
    failure_window_started_at timestamptz,
    locked_until timestamptz,
    created_at timestamptz NOT NULL DEFAULT CURRENT_TIMESTAMP,
    updated_at timestamptz NOT NULL DEFAULT CURRENT_TIMESTAMP,
    CONSTRAINT mfa_challenge_states_credential_fk
        FOREIGN KEY (credential_id) REFERENCES mfa_totp_credentials (id) ON DELETE RESTRICT,
    CONSTRAINT mfa_challenge_states_user_fk
        FOREIGN KEY (user_id) REFERENCES users (id) ON DELETE RESTRICT,
    CONSTRAINT mfa_challenge_states_counter_check
        CHECK (last_accepted_counter IS NULL OR last_accepted_counter >= 0),
    CONSTRAINT mfa_challenge_states_failure_check CHECK (
        failure_count BETWEEN 0 AND 5
        AND ((failure_count = 0 AND failure_window_started_at IS NULL AND locked_until IS NULL)
             OR (failure_count > 0 AND failure_window_started_at IS NOT NULL))
        AND (locked_until IS NULL OR locked_until > failure_window_started_at)
    ),
    CONSTRAINT mfa_challenge_states_timestamps_check CHECK (
        updated_at >= created_at
        AND (failure_window_started_at IS NULL OR failure_window_started_at >= created_at)
    )
);

CREATE INDEX mfa_challenge_states_user_idx
    ON mfa_challenge_states (user_id, credential_id);
CREATE INDEX mfa_challenge_states_lock_idx
    ON mfa_challenge_states (locked_until) WHERE locked_until IS NOT NULL;

CREATE FUNCTION enforce_mfa_challenge_state_binding() RETURNS trigger
LANGUAGE plpgsql AS $$
BEGIN
    IF NOT EXISTS (
        SELECT 1 FROM mfa_totp_credentials credential
        WHERE credential.id = NEW.credential_id
          AND credential.user_id = NEW.user_id
          AND credential.state IN ('pending', 'active')
    ) THEN
        RAISE EXCEPTION 'MFA challenge state requires a matching usable credential';
    END IF;
    IF TG_OP = 'UPDATE' THEN
        IF OLD.credential_id <> NEW.credential_id
           OR OLD.user_id <> NEW.user_id
           OR OLD.created_at <> NEW.created_at THEN
            RAISE EXCEPTION 'MFA challenge state identity cannot change';
        END IF;
        IF NEW.updated_at < OLD.updated_at
           OR (OLD.last_accepted_counter IS NOT NULL
               AND (NEW.last_accepted_counter IS NULL
                    OR NEW.last_accepted_counter < OLD.last_accepted_counter)) THEN
            RAISE EXCEPTION 'MFA challenge state cannot move backwards';
        END IF;
    END IF;
    RETURN NEW;
END;
$$;

CREATE TRIGGER mfa_challenge_states_binding_guard
BEFORE INSERT OR UPDATE ON mfa_challenge_states
FOR EACH ROW EXECUTE FUNCTION enforce_mfa_challenge_state_binding();

CREATE FUNCTION protect_mfa_challenge_state_history() RETURNS trigger
LANGUAGE plpgsql AS $$
BEGIN
    RAISE EXCEPTION 'MFA challenge state history cannot be deleted';
END;
$$;

CREATE TRIGGER mfa_challenge_states_delete_guard
BEFORE DELETE ON mfa_challenge_states
FOR EACH ROW EXECUTE FUNCTION protect_mfa_challenge_state_history();
