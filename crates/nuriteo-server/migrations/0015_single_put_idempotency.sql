-- Durable, exact idempotency identity for Save session creation. The service
-- stores only an HMAC-SHA-256 digest; raw client keys never enter PostgreSQL or
-- the object-key namespace.

ALTER TABLE save_sessions
    ADD COLUMN idempotency_digest bytea;

-- Existing pre-SAVE-003 rows receive a deterministic migration-only identity.
-- They cannot be addressed by the service HMAC and therefore cannot collide
-- with a production request.
UPDATE save_sessions
SET idempotency_digest = decode(md5(id::text) || md5('legacy:' || id::text), 'hex');

ALTER TABLE save_sessions
    ALTER COLUMN idempotency_digest SET DEFAULT
        decode(md5(gen_random_uuid()::text) || md5(gen_random_uuid()::text), 'hex'),
    ALTER COLUMN idempotency_digest SET NOT NULL,
    ADD CONSTRAINT save_sessions_idempotency_digest_check
        CHECK (octet_length(idempotency_digest) = 32),
    ADD CONSTRAINT save_sessions_idempotency_identity_unique
        UNIQUE (project_id, actor_user_id, idempotency_digest);

-- Extend the immutable request identity introduced by migration 0014.
CREATE OR REPLACE FUNCTION enforce_save_session_idempotency_immutable()
RETURNS trigger
LANGUAGE plpgsql
AS $$
BEGIN
    IF NEW.idempotency_digest IS DISTINCT FROM OLD.idempotency_digest THEN
        RAISE EXCEPTION 'Save session idempotency identity is immutable'
            USING ERRCODE = '23514';
    END IF;
    RETURN NEW;
END;
$$;

CREATE TRIGGER save_sessions_idempotency_immutable
    BEFORE UPDATE OF idempotency_digest ON save_sessions
    FOR EACH ROW
    EXECUTE FUNCTION enforce_save_session_idempotency_immutable();

CREATE TABLE save_idempotency_config (
    singleton boolean PRIMARY KEY DEFAULT TRUE,
    key_fingerprint bytea NOT NULL,
    created_at timestamptz NOT NULL DEFAULT CURRENT_TIMESTAMP,
    CONSTRAINT save_idempotency_config_singleton_check CHECK (singleton),
    CONSTRAINT save_idempotency_config_fingerprint_check
        CHECK (octet_length(key_fingerprint) = 32)
);

CREATE OR REPLACE FUNCTION reject_save_idempotency_config_mutation()
RETURNS trigger
LANGUAGE plpgsql
AS $$
BEGIN
    RAISE EXCEPTION 'Save idempotency key identity is immutable'
        USING ERRCODE = '23514';
END;
$$;

CREATE TRIGGER save_idempotency_config_no_update
    BEFORE UPDATE OR DELETE ON save_idempotency_config
    FOR EACH ROW EXECUTE FUNCTION reject_save_idempotency_config_mutation();
CREATE TRIGGER save_idempotency_config_no_truncate
    BEFORE TRUNCATE ON save_idempotency_config
    FOR EACH STATEMENT EXECUTE FUNCTION reject_save_idempotency_config_mutation();
