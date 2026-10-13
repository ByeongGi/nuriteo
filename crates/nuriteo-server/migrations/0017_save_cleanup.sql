-- Persisted cleanup ownership for abandoned Save staging objects and incomplete
-- multipart uploads. Jobs deliberately retain no FK to save_sessions: Project
-- deletion may cascade the source row, but must not erase the orphan cleanup.

CREATE TABLE save_cleanup_jobs (
    save_session_id uuid PRIMARY KEY,
    cleanup_kind text NOT NULL,
    object_key text NOT NULL,
    multipart_upload_id text,
    status text NOT NULL DEFAULT 'queued',
    attempts smallint NOT NULL DEFAULT 0,
    eligible_at timestamptz NOT NULL DEFAULT CURRENT_TIMESTAMP,
    retry_at timestamptz,
    lease_owner uuid,
    lease_expires_at timestamptz,
    started_at timestamptz,
    completed_at timestamptz,
    last_failure_category text,
    absence_observed_at timestamptz,
    absence_count smallint NOT NULL DEFAULT 0,
    created_at timestamptz NOT NULL DEFAULT CURRENT_TIMESTAMP,
    updated_at timestamptz NOT NULL DEFAULT CURRENT_TIMESTAMP,
    CONSTRAINT save_cleanup_jobs_kind_check
        CHECK (cleanup_kind IN (
            'object_delete', 'multipart_abort', 'multipart_reconcile',
            'multipart_complete_reconcile'
        )),
    CONSTRAINT save_cleanup_jobs_object_key_check
        CHECK (
            octet_length(object_key) BETWEEN 1 AND 1024
            AND object_key = btrim(object_key)
            AND object_key !~ '[[:cntrl:]]'
            AND object_key !~ '(^/|//|(^|/)\.\.?(/|$))'
        ),
    CONSTRAINT save_cleanup_jobs_multipart_shape_check
        CHECK (
            (cleanup_kind = 'object_delete' AND multipart_upload_id IS NULL)
            OR (
                cleanup_kind = 'multipart_abort'
                AND multipart_upload_id IS NOT NULL
                AND octet_length(multipart_upload_id) BETWEEN 1 AND 1024
                AND multipart_upload_id = btrim(multipart_upload_id)
                AND multipart_upload_id !~ '[[:cntrl:]]'
            )
            OR (cleanup_kind = 'multipart_reconcile' AND multipart_upload_id IS NULL)
            OR (
                cleanup_kind = 'multipart_complete_reconcile'
                AND multipart_upload_id IS NOT NULL
                AND octet_length(multipart_upload_id) BETWEEN 1 AND 1024
                AND multipart_upload_id = btrim(multipart_upload_id)
                AND multipart_upload_id !~ '[[:cntrl:]]'
            )
        ),
    CONSTRAINT save_cleanup_jobs_status_check
        CHECK (status IN ('queued', 'running', 'retry_wait', 'completed', 'failed')),
    CONSTRAINT save_cleanup_jobs_attempts_check CHECK (attempts BETWEEN 0 AND 16),
    CONSTRAINT save_cleanup_jobs_failure_category_check
        CHECK (
            last_failure_category IS NULL
            OR last_failure_category IN ('timeout', 'retryable', 'permanent', 'unknown', 'absent')
        ),
    CONSTRAINT save_cleanup_jobs_absence_check CHECK (
        (absence_count = 0 AND absence_observed_at IS NULL)
        OR (absence_count = 1 AND absence_observed_at IS NOT NULL)
    ),
    CONSTRAINT save_cleanup_jobs_state_shape_check
        CHECK (
            (
                status = 'queued'
                AND retry_at IS NULL AND lease_owner IS NULL
                AND lease_expires_at IS NULL AND completed_at IS NULL
                AND last_failure_category IS NULL
            )
            OR (
                status = 'running'
                AND retry_at IS NULL AND lease_owner IS NOT NULL
                AND lease_expires_at IS NOT NULL AND started_at IS NOT NULL
                AND completed_at IS NULL
            )
            OR (
                status = 'retry_wait'
                AND retry_at IS NOT NULL AND lease_owner IS NULL
                AND lease_expires_at IS NULL AND started_at IS NOT NULL
                AND completed_at IS NULL AND last_failure_category IS NOT NULL
            )
            OR (
                status = 'failed'
                AND retry_at IS NULL AND lease_owner IS NULL
                AND lease_expires_at IS NULL AND started_at IS NOT NULL
                AND completed_at IS NULL AND last_failure_category IS NOT NULL
            )
            OR (
                status = 'completed'
                AND retry_at IS NULL AND lease_owner IS NULL
                AND lease_expires_at IS NULL AND started_at IS NOT NULL
                AND completed_at IS NOT NULL AND last_failure_category IS NULL
            )
        ),
    CONSTRAINT save_cleanup_jobs_timestamps_check
        CHECK (
            updated_at >= created_at
            AND eligible_at >= created_at
            AND (retry_at IS NULL OR retry_at >= created_at)
            AND (started_at IS NULL OR started_at >= created_at)
            AND (lease_expires_at IS NULL OR lease_expires_at > started_at)
            AND (completed_at IS NULL OR completed_at >= started_at)
            AND (completed_at IS NULL OR updated_at >= completed_at)
            AND (absence_observed_at IS NULL OR absence_observed_at >= created_at)
        )
);

CREATE INDEX save_cleanup_jobs_claim_idx
    ON save_cleanup_jobs (eligible_at, retry_at, save_session_id)
    WHERE status IN ('queued', 'retry_wait', 'running');

-- Forward-only extension of the 0016 lifecycle machine. The already-applied
-- migration is never edited; 0017 adds only reconciliation transitions.
CREATE OR REPLACE FUNCTION enforce_multipart_lifecycle_write()
RETURNS trigger
LANGUAGE plpgsql
AS $$
DECLARE
    parent save_sessions%ROWTYPE;
BEGIN
    SELECT * INTO parent FROM save_sessions session
    WHERE session.id = NEW.save_session_id FOR KEY SHARE;
    IF NOT FOUND OR parent.upload_mode <> 'multipart' THEN
        RAISE EXCEPTION 'multipart lifecycle requires a multipart Save session'
            USING ERRCODE = '23514';
    END IF;
    IF TG_OP = 'INSERT' THEN
        IF parent.state <> 'created' OR parent.multipart_upload_id IS NOT NULL
            OR NEW.create_status <> 'creating' OR NEW.complete_status <> 'pending'
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
        OR (OLD.create_status='creating' AND OLD.complete_status='pending'
            AND NEW.complete_status='pending'
            AND NEW.create_status IN ('ready','unknown','cleaned'))
        OR (OLD.create_status='unknown' AND OLD.complete_status='pending'
            AND NEW.create_status='cleaned' AND NEW.complete_status='pending')
        OR (OLD.create_status='ready' AND NEW.create_status='ready'
            AND OLD.complete_status='pending' AND NEW.complete_status='completing')
        OR (OLD.create_status='ready' AND NEW.create_status='ready'
            AND OLD.complete_status='completing'
            AND NEW.complete_status IN ('completed','unknown'))
        OR (OLD.create_status='ready' AND NEW.create_status='ready'
            AND OLD.complete_status='unknown' AND NEW.complete_status='completed')
        OR (OLD.create_status='ready' AND OLD.complete_status='pending'
            AND NEW.create_status='cleaned' AND NEW.complete_status='pending')
        OR (OLD.create_status='ready'
            AND OLD.complete_status IN ('completing','unknown')
            AND NEW.create_status='cleaned'
            AND NEW.complete_status=OLD.complete_status)
    ) THEN
        RAISE EXCEPTION 'invalid multipart lifecycle transition'
            USING ERRCODE = '23514';
    END IF;
    IF NEW.create_status='ready'
        AND (parent.multipart_upload_id IS NULL OR parent.state NOT IN ('uploading','verifying'))
    THEN
        RAISE EXCEPTION 'ready multipart lifecycle requires an assigned backend upload'
            USING ERRCODE = '23514';
    END IF;
    IF NEW.complete_status='completed' AND parent.state <> 'verifying' THEN
        RAISE EXCEPTION 'completed multipart lifecycle requires a verifying Save session'
            USING ERRCODE = '23514';
    END IF;
    NEW.updated_at := transaction_timestamp();
    RETURN NEW;
END;
$$;

CREATE OR REPLACE FUNCTION fence_unknown_multipart_terminal_transition()
RETURNS trigger
LANGUAGE plpgsql
AS $$
DECLARE
    lifecycle multipart_lifecycles%ROWTYPE;
BEGIN
    IF OLD.upload_mode='multipart'
        AND OLD.state IN ('created','uploading','verifying')
        AND NEW.state IN ('committed','aborted','expired','failed')
    THEN
        SELECT * INTO lifecycle FROM multipart_lifecycles value
        WHERE value.save_session_id=OLD.id;
        IF NOT FOUND OR lifecycle.create_status IN ('creating','unknown')
            OR (lifecycle.complete_status IN ('completing','unknown')
                AND lifecycle.create_status <> 'cleaned')
        THEN
            RAISE EXCEPTION 'ambiguous multipart operation requires reconciliation before terminal release'
                USING ERRCODE = '23514';
        END IF;
    END IF;
    RETURN NEW;
END;
$$;

-- Every multipart create begins with an expiry-delayed reconcile guard. A
-- process can disappear after the backend accepted create but before the
-- response or DB attach was observed. The guard is deleted only by the same
-- transaction that persists `ready`; ambiguous work waits for both session
-- expiry and the operation quarantine.
CREATE OR REPLACE FUNCTION maintain_multipart_create_cleanup_guard()
RETURNS trigger
LANGUAGE plpgsql
AS $$
DECLARE
    parent save_sessions%ROWTYPE;
BEGIN
    SELECT * INTO parent
    FROM save_sessions session
    WHERE session.id = NEW.save_session_id;

    IF NOT FOUND THEN
        RETURN NEW;
    END IF;

    IF NEW.create_status IN ('creating', 'unknown', 'cleaned') THEN
        INSERT INTO save_cleanup_jobs (
            save_session_id, cleanup_kind, object_key, eligible_at
        ) VALUES (
            parent.id,
            'multipart_reconcile',
            parent.staging_object_key,
            CASE
                WHEN NEW.create_status = 'cleaned' THEN transaction_timestamp()
                ELSE GREATEST(
                    parent.expires_at,
                    transaction_timestamp() + interval '2 minutes'
                )
            END
        )
        ON CONFLICT (save_session_id) DO UPDATE
        SET eligible_at = LEAST(save_cleanup_jobs.eligible_at, EXCLUDED.eligible_at),
            updated_at = transaction_timestamp()
        WHERE save_cleanup_jobs.cleanup_kind = 'multipart_reconcile'
          AND save_cleanup_jobs.status = 'queued';
    ELSIF OLD.create_status = 'creating' AND NEW.create_status = 'ready' THEN
        DELETE FROM save_cleanup_jobs
        WHERE save_session_id = NEW.save_session_id
          AND cleanup_kind = 'multipart_reconcile'
          AND status = 'queued';
    END IF;
    RETURN NEW;
END;
$$;

CREATE TRIGGER multipart_lifecycle_cleanup_guard_insert
    AFTER INSERT ON multipart_lifecycles
    FOR EACH ROW
    EXECUTE FUNCTION maintain_multipart_create_cleanup_guard();

CREATE TRIGGER multipart_lifecycle_cleanup_guard_update
    AFTER UPDATE OF create_status ON multipart_lifecycles
    FOR EACH ROW
    EXECUTE FUNCTION maintain_multipart_create_cleanup_guard();

CREATE OR REPLACE FUNCTION maintain_multipart_complete_cleanup_guard()
RETURNS trigger
LANGUAGE plpgsql
AS $$
DECLARE
    parent save_sessions%ROWTYPE;
BEGIN
    SELECT * INTO parent FROM save_sessions session
    WHERE session.id = NEW.save_session_id;
    IF NOT FOUND THEN
        RETURN NEW;
    END IF;
    IF NEW.complete_status IN ('completing', 'unknown') THEN
        INSERT INTO save_cleanup_jobs (
            save_session_id,cleanup_kind,object_key,multipart_upload_id,eligible_at
        ) VALUES (
            parent.id,'multipart_complete_reconcile',parent.staging_object_key,
            parent.multipart_upload_id,GREATEST(
                parent.expires_at,
                transaction_timestamp() + interval '2 minutes'
            )
        ) ON CONFLICT (save_session_id) DO NOTHING;
    ELSIF NEW.complete_status = 'completed' THEN
        DELETE FROM save_cleanup_jobs
        WHERE save_session_id=NEW.save_session_id
          AND cleanup_kind='multipart_complete_reconcile'
          AND status='queued';
    END IF;
    RETURN NEW;
END;
$$;

CREATE TRIGGER multipart_complete_cleanup_guard_update
    AFTER UPDATE OF complete_status ON multipart_lifecycles
    FOR EACH ROW EXECUTE FUNCTION maintain_multipart_complete_cleanup_guard();

CREATE OR REPLACE FUNCTION enqueue_terminal_save_cleanup()
RETURNS trigger
LANGUAGE plpgsql
AS $$
DECLARE
    completed_multipart boolean;
BEGIN
    IF OLD.state IN ('created', 'uploading', 'verifying')
        AND NEW.state IN ('aborted', 'expired', 'failed')
    THEN
        SELECT EXISTS (
            SELECT 1 FROM multipart_lifecycles lifecycle
            WHERE lifecycle.save_session_id=NEW.id
              AND lifecycle.create_status='ready'
              AND lifecycle.complete_status='completed'
        ) INTO completed_multipart;
        INSERT INTO save_cleanup_jobs (
            save_session_id, cleanup_kind, object_key, multipart_upload_id, eligible_at
        ) VALUES (
            NEW.id,
            CASE
                WHEN NEW.upload_mode = 'single' OR completed_multipart THEN 'object_delete'
                WHEN NEW.multipart_upload_id IS NOT NULL THEN 'multipart_abort'
                ELSE 'multipart_reconcile'
            END,
            NEW.staging_object_key,
            CASE
                WHEN NEW.upload_mode = 'single' OR completed_multipart THEN NULL
                ELSE NEW.multipart_upload_id
            END,
            CASE
                -- A presigned single-PUT bearer cannot be revoked. Deleting
                -- before it expires would allow a late upload to recreate an
                -- object after the job had been marked completed.
                WHEN NEW.upload_mode = 'single'
                    THEN GREATEST(NEW.expires_at, transaction_timestamp())
                ELSE transaction_timestamp()
            END
        )
        ON CONFLICT (save_session_id) DO NOTHING;
    END IF;
    RETURN NEW;
END;
$$;

CREATE TRIGGER save_sessions_terminal_cleanup_enqueue
    AFTER UPDATE OF state ON save_sessions
    FOR EACH ROW
    EXECUTE FUNCTION enqueue_terminal_save_cleanup();

-- Forward upgrades may already contain terminal SAVE-003 sessions. Backfill
-- them with the same rules as the trigger; ON CONFLICT also makes a repaired
-- or retried migration step harmless.
INSERT INTO save_cleanup_jobs (
    save_session_id, cleanup_kind, object_key, multipart_upload_id, eligible_at
)
SELECT
    session.id,
    CASE
        WHEN session.upload_mode = 'single'
             OR lifecycle.complete_status='completed' THEN 'object_delete'
        WHEN session.multipart_upload_id IS NOT NULL THEN 'multipart_abort'
        ELSE 'multipart_reconcile'
    END,
    session.staging_object_key,
    CASE
        WHEN session.upload_mode = 'single'
             OR lifecycle.complete_status='completed' THEN NULL
        ELSE session.multipart_upload_id
    END,
    CASE
        WHEN session.upload_mode = 'single'
            THEN GREATEST(session.expires_at, transaction_timestamp())
        ELSE transaction_timestamp()
    END
FROM save_sessions session
LEFT JOIN multipart_lifecycles lifecycle ON lifecycle.save_session_id=session.id
WHERE session.state IN ('aborted', 'expired', 'failed')
ON CONFLICT (save_session_id) DO NOTHING;

INSERT INTO save_cleanup_jobs (
    save_session_id,cleanup_kind,object_key,multipart_upload_id,eligible_at
)
SELECT session.id,'multipart_complete_reconcile',session.staging_object_key,
       session.multipart_upload_id,GREATEST(
           session.expires_at,
           transaction_timestamp() + interval '2 minutes'
       )
FROM save_sessions session
JOIN multipart_lifecycles lifecycle ON lifecycle.save_session_id=session.id
WHERE session.state IN ('uploading','verifying')
  AND session.multipart_upload_id IS NOT NULL
  AND lifecycle.create_status='ready'
  AND lifecycle.complete_status IN ('completing','unknown')
ON CONFLICT (save_session_id) DO NOTHING;

-- Forward upgrades and a process crash before the application records an
-- ambiguous create still need a restart-safe cleanup owner. Both states wait
-- until the session has expired and the operation quarantine has elapsed.
INSERT INTO save_cleanup_jobs (
    save_session_id, cleanup_kind, object_key, eligible_at
)
SELECT
    session.id,
    'multipart_reconcile',
    session.staging_object_key,
    CASE
        WHEN lifecycle.create_status = 'cleaned' THEN transaction_timestamp()
        ELSE GREATEST(
            session.expires_at,
            transaction_timestamp() + interval '2 minutes'
        )
    END
FROM save_sessions session
JOIN multipart_lifecycles lifecycle ON lifecycle.save_session_id = session.id
WHERE session.state = 'created'
  AND session.multipart_upload_id IS NULL
  AND lifecycle.create_status IN ('creating', 'unknown')
ON CONFLICT (save_session_id) DO NOTHING;

CREATE TRIGGER save_cleanup_jobs_no_truncate
    BEFORE TRUNCATE ON save_cleanup_jobs
    FOR EACH STATEMENT EXECUTE FUNCTION reject_bundle_persistence_truncate();

CREATE OR REPLACE FUNCTION enforce_save_cleanup_job_write()
RETURNS trigger
LANGUAGE plpgsql
AS $$
BEGIN
    IF NEW.save_session_id IS DISTINCT FROM OLD.save_session_id
        OR NEW.cleanup_kind IS DISTINCT FROM OLD.cleanup_kind
        OR NEW.object_key IS DISTINCT FROM OLD.object_key
        OR NEW.multipart_upload_id IS DISTINCT FROM OLD.multipart_upload_id
        OR NEW.created_at IS DISTINCT FROM OLD.created_at
        OR NEW.attempts < OLD.attempts
        OR NEW.attempts > OLD.attempts + 1
        OR NEW.absence_count < OLD.absence_count
        OR NEW.absence_count > OLD.absence_count + 1
        OR NEW.updated_at < OLD.updated_at
    THEN
        RAISE EXCEPTION 'cleanup job identity and progress are immutable'
            USING ERRCODE = '23514';
    END IF;

    IF NEW.eligible_at IS DISTINCT FROM OLD.eligible_at
        AND NOT (OLD.status = 'queued' AND NEW.status = 'queued' AND NEW.eligible_at <= OLD.eligible_at)
    THEN
        RAISE EXCEPTION 'cleanup eligibility may only move earlier while queued'
            USING ERRCODE = '23514';
    END IF;

    IF OLD.status='running' AND NEW.status='running'
        AND OLD.lease_expires_at > transaction_timestamp()
        AND NEW.lease_owner IS DISTINCT FROM OLD.lease_owner
    THEN
        RAISE EXCEPTION 'an unexpired cleanup lease owner cannot be replaced'
            USING ERRCODE = '23514';
    END IF;

    IF NOT (
        (NEW.status = OLD.status AND NEW.status IN ('queued', 'running', 'retry_wait'))
        OR (OLD.status IN ('queued', 'retry_wait', 'running') AND NEW.status = 'running')
        OR (OLD.status = 'running' AND NEW.status IN ('retry_wait', 'completed', 'failed'))
    ) THEN
        RAISE EXCEPTION 'invalid cleanup job state transition'
            USING ERRCODE = '23514';
    END IF;
    RETURN NEW;
END;
$$;

CREATE TRIGGER save_cleanup_jobs_write_invariants
    BEFORE UPDATE ON save_cleanup_jobs
    FOR EACH ROW EXECUTE FUNCTION enforce_save_cleanup_job_write();

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
    )
    THEN
        RAISE EXCEPTION 'cleanup jobs may only be removed after multipart attach wins'
            USING ERRCODE = '23514';
    END IF;
    RETURN OLD;
END;
$$;

CREATE TRIGGER save_cleanup_jobs_delete_invariants
    BEFORE DELETE ON save_cleanup_jobs
    FOR EACH ROW EXECUTE FUNCTION enforce_save_cleanup_job_delete();
