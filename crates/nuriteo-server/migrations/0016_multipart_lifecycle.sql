-- Durable multipart policy and response-loss fences. A marker is committed
-- before each non-idempotent object-store operation so a lost response never
-- causes the service to create or complete an upload a second time.

CREATE TABLE multipart_lifecycles (
    save_session_id uuid PRIMARY KEY,
    part_size_bytes bigint NOT NULL,
    part_count smallint NOT NULL,
    create_status text NOT NULL DEFAULT 'creating',
    complete_status text NOT NULL DEFAULT 'pending',
    created_at timestamptz NOT NULL DEFAULT CURRENT_TIMESTAMP,
    updated_at timestamptz NOT NULL DEFAULT CURRENT_TIMESTAMP,
    CONSTRAINT multipart_lifecycles_session_fk
        FOREIGN KEY (save_session_id) REFERENCES save_sessions (id) ON DELETE CASCADE,
    CONSTRAINT multipart_lifecycles_part_size_check
        CHECK (part_size_bytes BETWEEN 8388608 AND 67108864),
    CONSTRAINT multipart_lifecycles_part_count_check CHECK (part_count BETWEEN 1 AND 128),
    CONSTRAINT multipart_lifecycles_create_status_check
        CHECK (create_status IN ('creating', 'ready', 'unknown', 'cleaned')),
    CONSTRAINT multipart_lifecycles_complete_status_check
        CHECK (complete_status IN ('pending', 'completing', 'completed', 'unknown')),
    CONSTRAINT multipart_lifecycles_status_check
        CHECK (
            (create_status = 'creating' AND complete_status = 'pending')
            OR create_status IN ('unknown', 'cleaned')
            OR (
                create_status = 'ready'
                AND complete_status IN ('pending', 'completing', 'completed', 'unknown')
            )
        ),
    CONSTRAINT multipart_lifecycles_timestamps_check CHECK (updated_at >= created_at)
);

CREATE OR REPLACE FUNCTION reject_multipart_lifecycle_truncate()
RETURNS trigger
LANGUAGE plpgsql
AS $$
BEGIN
    RAISE EXCEPTION 'multipart lifecycle truncation is forbidden'
        USING ERRCODE = '23514';
END;
$$;

CREATE TRIGGER multipart_lifecycles_no_truncate
    BEFORE TRUNCATE ON multipart_lifecycles
    FOR EACH STATEMENT EXECUTE FUNCTION reject_multipart_lifecycle_truncate();

CREATE OR REPLACE FUNCTION enforce_multipart_lifecycle_write()
RETURNS trigger
LANGUAGE plpgsql
AS $$
DECLARE
    parent save_sessions%ROWTYPE;
BEGIN
    SELECT * INTO parent
    FROM save_sessions session
    WHERE session.id = NEW.save_session_id
    FOR KEY SHARE;

    IF NOT FOUND OR parent.upload_mode <> 'multipart' THEN
        RAISE EXCEPTION 'multipart lifecycle requires a multipart Save session'
            USING ERRCODE = '23514';
    END IF;

    IF TG_OP = 'INSERT' THEN
        IF parent.state <> 'created'
            OR parent.multipart_upload_id IS NOT NULL
            OR NEW.create_status <> 'creating'
            OR NEW.complete_status <> 'pending'
        THEN
            RAISE EXCEPTION 'multipart lifecycle must begin before backend create'
                USING ERRCODE = '23514';
        END IF;
        RETURN NEW;
    END IF;

    IF NEW.save_session_id IS DISTINCT FROM OLD.save_session_id
        OR NEW.part_size_bytes IS DISTINCT FROM OLD.part_size_bytes
        OR NEW.part_count IS DISTINCT FROM OLD.part_count
        OR NEW.created_at IS DISTINCT FROM OLD.created_at
        OR NEW.updated_at < OLD.updated_at
    THEN
        RAISE EXCEPTION 'multipart lifecycle identity and plan are immutable'
            USING ERRCODE = '23514';
    END IF;

    IF NOT (
        (NEW.create_status = OLD.create_status AND NEW.complete_status = OLD.complete_status)
        OR (
            OLD.create_status = 'creating'
            AND OLD.complete_status = 'pending'
            AND NEW.complete_status = 'pending'
            AND NEW.create_status IN ('ready', 'unknown', 'cleaned')
        )
        OR (
            OLD.create_status = 'unknown'
            AND OLD.complete_status = 'pending'
            AND NEW.create_status = 'cleaned'
            AND NEW.complete_status = 'pending'
        )
        OR (
            OLD.create_status = 'ready'
            AND NEW.create_status = 'ready'
            AND OLD.complete_status = 'pending'
            AND NEW.complete_status = 'completing'
        )
        OR (
            OLD.create_status = 'ready'
            AND NEW.create_status = 'ready'
            AND OLD.complete_status = 'completing'
            AND NEW.complete_status IN ('completed', 'unknown')
        )
        OR (
            OLD.create_status = 'ready'
            AND OLD.complete_status = 'pending'
            AND NEW.create_status = 'cleaned'
            AND NEW.complete_status = 'pending'
        )
    ) THEN
        RAISE EXCEPTION 'invalid multipart lifecycle transition'
            USING ERRCODE = '23514';
    END IF;

    IF NEW.create_status = 'ready'
        AND (parent.multipart_upload_id IS NULL OR parent.state NOT IN ('uploading', 'verifying'))
    THEN
        RAISE EXCEPTION 'ready multipart lifecycle requires an assigned backend upload'
            USING ERRCODE = '23514';
    END IF;

    IF NEW.complete_status = 'completed' AND parent.state <> 'verifying' THEN
        RAISE EXCEPTION 'completed multipart lifecycle requires a verifying Save session'
            USING ERRCODE = '23514';
    END IF;

    NEW.updated_at := transaction_timestamp();
    RETURN NEW;
END;
$$;

CREATE TRIGGER multipart_lifecycles_write_invariants
    BEFORE INSERT OR UPDATE ON multipart_lifecycles
    FOR EACH ROW EXECUTE FUNCTION enforce_multipart_lifecycle_write();

CREATE OR REPLACE FUNCTION fence_unknown_multipart_terminal_transition()
RETURNS trigger
LANGUAGE plpgsql
AS $$
DECLARE
    lifecycle multipart_lifecycles%ROWTYPE;
BEGIN
    IF OLD.upload_mode = 'multipart'
        AND OLD.state IN ('created', 'uploading', 'verifying')
        AND NEW.state IN ('committed', 'aborted', 'expired', 'failed')
    THEN
        SELECT * INTO lifecycle
        FROM multipart_lifecycles value
        WHERE value.save_session_id = OLD.id;
        IF NOT FOUND
            OR lifecycle.create_status IN ('creating', 'unknown')
            OR lifecycle.complete_status IN ('completing', 'unknown')
        THEN
            RAISE EXCEPTION 'ambiguous multipart operation requires reconciliation before terminal release'
                USING ERRCODE = '23514';
        END IF;
    END IF;
    RETURN NEW;
END;
$$;

CREATE TRIGGER save_sessions_multipart_unknown_fence
    BEFORE UPDATE OF state ON save_sessions
    FOR EACH ROW EXECUTE FUNCTION fence_unknown_multipart_terminal_transition();

CREATE OR REPLACE FUNCTION enforce_multipart_part_write()
RETURNS trigger
LANGUAGE plpgsql
AS $$
DECLARE
    target save_sessions%ROWTYPE;
    lifecycle multipart_lifecycles%ROWTYPE;
BEGIN
    SELECT * INTO target
    FROM save_sessions session
    WHERE session.id = NEW.save_session_id
    FOR KEY SHARE;
    SELECT * INTO lifecycle
    FROM multipart_lifecycles value
    WHERE value.save_session_id = NEW.save_session_id
    FOR KEY SHARE;
    IF NOT FOUND
        OR target.upload_mode <> 'multipart'
        OR target.state NOT IN ('created', 'uploading')
        OR target.expires_at <= transaction_timestamp()
        OR NEW.part_number > lifecycle.part_count
        OR NEW.expected_bytes > lifecycle.part_size_bytes
        OR (NEW.part_number < lifecycle.part_count AND NEW.expected_bytes <> lifecycle.part_size_bytes)
    THEN
        RAISE EXCEPTION 'multipart part requires the persisted active multipart plan'
            USING ERRCODE = '23514';
    END IF;

    IF TG_OP = 'UPDATE' THEN
        IF NEW.save_session_id IS DISTINCT FROM OLD.save_session_id
            OR NEW.part_number IS DISTINCT FROM OLD.part_number
            OR NEW.expected_bytes IS DISTINCT FROM OLD.expected_bytes
            OR NEW.expected_sha256 IS DISTINCT FROM OLD.expected_sha256
            OR NEW.created_at IS DISTINCT FROM OLD.created_at
            OR OLD.state = 'uploaded'
            OR NOT (NEW.state = OLD.state OR (OLD.state = 'pending' AND NEW.state = 'uploaded'))
        THEN
            RAISE EXCEPTION 'multipart part identity or terminal state cannot change'
                USING ERRCODE = '23514';
        END IF;
    END IF;
    RETURN NEW;
END;
$$;
