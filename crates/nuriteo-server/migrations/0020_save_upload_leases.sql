-- Persisted relay upload leases linearize non-replayable object-store writes
-- against Save session state transitions without holding a database
-- transaction across network I/O.

CREATE TABLE save_upload_leases (
    save_session_id uuid NOT NULL REFERENCES save_sessions(id) ON DELETE CASCADE,
    part_number smallint NOT NULL,
    generation bigint NOT NULL,
    lease_token uuid NOT NULL,
    lease_expires_at timestamptz NOT NULL,
    released_at timestamptz,
    created_at timestamptz NOT NULL DEFAULT CURRENT_TIMESTAMP,
    updated_at timestamptz NOT NULL DEFAULT CURRENT_TIMESTAMP,
    PRIMARY KEY (save_session_id, part_number),
    CONSTRAINT save_upload_leases_part_check CHECK (part_number BETWEEN 0 AND 128),
    CONSTRAINT save_upload_leases_generation_check
        CHECK (generation BETWEEN 1 AND 9223372036854775806),
    CONSTRAINT save_upload_leases_token_v7_check
        CHECK (
            substring(lease_token::text FROM 15 FOR 1) = '7'
            AND substring(lease_token::text FROM 20 FOR 1) IN ('8', '9', 'a', 'b')
        ),
    CONSTRAINT save_upload_leases_time_check CHECK (
        updated_at >= created_at
        AND lease_expires_at > created_at
        AND (released_at IS NULL OR released_at >= created_at)
        AND (released_at IS NULL OR updated_at >= released_at)
    )
);

CREATE UNIQUE INDEX save_upload_leases_token_unique
    ON save_upload_leases (lease_token);
CREATE INDEX save_upload_leases_expiry_idx
    ON save_upload_leases (lease_expires_at, save_session_id, part_number);

CREATE OR REPLACE FUNCTION enforce_save_upload_lease_write()
RETURNS trigger
LANGUAGE plpgsql
AS $$
DECLARE
    parent save_sessions%ROWTYPE;
    planned_parts smallint;
BEGIN
    SELECT * INTO parent
    FROM save_sessions session
    WHERE session.id = NEW.save_session_id
    FOR KEY SHARE;

    IF NOT FOUND OR parent.state NOT IN ('created', 'uploading') THEN
        RAISE EXCEPTION 'relay upload lease requires an active non-expiring Save session'
            USING ERRCODE = '23514';
    END IF;

    IF parent.upload_mode = 'single' THEN
        IF NEW.part_number <> 0 THEN
            RAISE EXCEPTION 'single relay upload lease requires part zero'
                USING ERRCODE = '23514';
        END IF;
    ELSE
        SELECT lifecycle.part_count INTO planned_parts
        FROM multipart_lifecycles lifecycle
        WHERE lifecycle.save_session_id = parent.id;
        IF planned_parts IS NULL
            OR NEW.part_number < 1
            OR NEW.part_number > planned_parts
        THEN
            RAISE EXCEPTION 'multipart relay upload lease requires a planned part'
                USING ERRCODE = '23514';
        END IF;
    END IF;

    IF TG_OP = 'UPDATE' THEN
        IF NEW.save_session_id IS DISTINCT FROM OLD.save_session_id
            OR NEW.part_number IS DISTINCT FROM OLD.part_number
            OR NEW.created_at IS DISTINCT FROM OLD.created_at
        THEN
            RAISE EXCEPTION 'relay upload lease identity is immutable'
                USING ERRCODE = '23514';
        END IF;
        IF OLD.released_at IS NULL
            AND NEW.released_at IS NOT NULL
            AND NEW.generation = OLD.generation
            AND NEW.lease_token = OLD.lease_token
            AND NEW.lease_expires_at = OLD.lease_expires_at
        THEN
            NEW.updated_at := transaction_timestamp();
            RETURN NEW;
        END IF;
        IF (OLD.released_at IS NOT NULL OR OLD.lease_expires_at <= clock_timestamp())
            AND NEW.released_at IS NULL
            AND NEW.generation = OLD.generation + 1
            AND parent.expires_at > NEW.lease_expires_at
        THEN
            NEW.updated_at := transaction_timestamp();
            RETURN NEW;
        END IF;
        RAISE EXCEPTION 'relay upload lease replacement requires a released or expired generation'
            USING ERRCODE = '23514';
    END IF;
    IF parent.expires_at <= NEW.lease_expires_at THEN
        RAISE EXCEPTION 'relay upload lease must end before its Save session'
            USING ERRCODE = '23514';
    END IF;
    RETURN NEW;
END;
$$;

CREATE TRIGGER save_upload_leases_write_invariants
    BEFORE INSERT OR UPDATE ON save_upload_leases
    FOR EACH ROW EXECUTE FUNCTION enforce_save_upload_lease_write();

CREATE OR REPLACE FUNCTION reject_save_upload_lease_truncate()
RETURNS trigger
LANGUAGE plpgsql
AS $$
BEGIN
    RAISE EXCEPTION 'save_upload_leases cannot be truncated'
        USING ERRCODE = '23514';
END;
$$;

CREATE TRIGGER save_upload_leases_no_truncate
    BEFORE TRUNCATE ON save_upload_leases
    FOR EACH STATEMENT EXECUTE FUNCTION reject_save_upload_lease_truncate();

CREATE OR REPLACE FUNCTION enforce_save_upload_lease_delete()
RETURNS trigger
LANGUAGE plpgsql
AS $$
BEGIN
    -- The FK cascade runs only after save_sessions_safe_delete has accepted a
    -- terminal parent. At that point PostgreSQL no longer exposes the parent
    -- row to this nested child trigger. Every direct row DELETE, including a
    -- released generation under an active or terminal parent, remains denied.
    IF pg_trigger_depth() > 1
        AND NOT EXISTS (
            SELECT 1 FROM save_sessions session
            WHERE session.id = OLD.save_session_id
        )
    THEN
        RETURN OLD;
    END IF;
    RAISE EXCEPTION 'relay upload lease generations are deleted only by terminal session cascade'
        USING ERRCODE = '23514';
END;
$$;

CREATE TRIGGER save_upload_leases_safe_delete
    BEFORE DELETE ON save_upload_leases
    FOR EACH ROW EXECUTE FUNCTION enforce_save_upload_lease_delete();

CREATE OR REPLACE FUNCTION fence_save_session_state_during_relay_upload()
RETURNS trigger
LANGUAGE plpgsql
AS $$
BEGIN
    IF NEW.state IS DISTINCT FROM OLD.state
        AND EXISTS (
            SELECT 1 FROM save_upload_leases lease
            WHERE lease.save_session_id = OLD.id
              AND lease.lease_expires_at > clock_timestamp()
              AND lease.released_at IS NULL
        )
    THEN
        RAISE EXCEPTION 'active relay upload lease fences Save session state transition'
            USING ERRCODE = '23514';
    END IF;
    RETURN NEW;
END;
$$;

CREATE TRIGGER save_sessions_relay_upload_lease_fence
    BEFORE UPDATE OF state ON save_sessions
    FOR EACH ROW EXECUTE FUNCTION fence_save_session_state_during_relay_upload();

-- A relay can disappear after the object store accepted a write but before
-- the database finalizer observes it. Keep a session-expiry-delayed cleanup
-- owner while any relay generation is unreleased. Normal finalization removes
-- the guard only after the last lease is released; a crash or lost generation
-- therefore remains restart-safe without racing an active request.
CREATE OR REPLACE FUNCTION enforce_save_cleanup_job_delete()
RETURNS trigger
LANGUAGE plpgsql
AS $$
BEGIN
    IF OLD.status <> 'completed' AND NOT (
        (OLD.cleanup_kind = 'multipart_reconcile' AND EXISTS (
            SELECT 1
            FROM save_sessions session
            JOIN multipart_lifecycles lifecycle ON lifecycle.save_session_id = session.id
            WHERE session.id = OLD.save_session_id
              AND session.state = 'uploading'
              AND lifecycle.create_status = 'ready'
              AND session.staging_object_key = OLD.object_key
        ))
        OR
        (OLD.cleanup_kind = 'multipart_complete_reconcile' AND EXISTS (
            SELECT 1
            FROM save_sessions session
            JOIN multipart_lifecycles lifecycle ON lifecycle.save_session_id = session.id
            WHERE session.id = OLD.save_session_id
              AND session.state = 'verifying'
              AND lifecycle.complete_status = 'completed'
              AND session.staging_object_key = OLD.object_key
        ))
        OR
        (OLD.cleanup_kind IN ('object_delete', 'multipart_abort') AND EXISTS (
            SELECT 1
            FROM save_sessions session
            WHERE session.id = OLD.save_session_id
              AND session.state IN ('created', 'uploading')
              AND session.staging_object_key = OLD.object_key
              AND NOT EXISTS (
                  SELECT 1 FROM save_upload_leases lease
                  WHERE lease.save_session_id = session.id
                    AND lease.released_at IS NULL
              )
        ))
    )
    THEN
        RAISE EXCEPTION 'cleanup jobs may only be removed after their operation is resolved'
            USING ERRCODE = '23514';
    END IF;
    RETURN OLD;
END;
$$;
