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
    created_at timestamptz NOT NULL DEFAULT CURRENT_TIMESTAMP,
    updated_at timestamptz NOT NULL DEFAULT CURRENT_TIMESTAMP,
    CONSTRAINT save_cleanup_jobs_kind_check
        CHECK (cleanup_kind IN ('single_delete', 'multipart_abort', 'multipart_reconcile')),
    CONSTRAINT save_cleanup_jobs_object_key_check
        CHECK (
            octet_length(object_key) BETWEEN 1 AND 1024
            AND object_key = btrim(object_key)
            AND object_key !~ '[[:cntrl:]]'
            AND object_key !~ '(^/|//|(^|/)\.\.?(/|$))'
        ),
    CONSTRAINT save_cleanup_jobs_multipart_shape_check
        CHECK (
            (cleanup_kind = 'single_delete' AND multipart_upload_id IS NULL)
            OR (
                cleanup_kind = 'multipart_abort'
                AND multipart_upload_id IS NOT NULL
                AND octet_length(multipart_upload_id) BETWEEN 1 AND 1024
                AND multipart_upload_id = btrim(multipart_upload_id)
                AND multipart_upload_id !~ '[[:cntrl:]]'
            )
            OR (cleanup_kind = 'multipart_reconcile' AND multipart_upload_id IS NULL)
        ),
    CONSTRAINT save_cleanup_jobs_status_check
        CHECK (status IN ('queued', 'running', 'retry_wait', 'completed', 'failed')),
    CONSTRAINT save_cleanup_jobs_attempts_check CHECK (attempts BETWEEN 0 AND 16),
    CONSTRAINT save_cleanup_jobs_failure_category_check
        CHECK (
            last_failure_category IS NULL
            OR last_failure_category IN ('timeout', 'retryable', 'permanent', 'unknown')
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
        )
);

CREATE INDEX save_cleanup_jobs_claim_idx
    ON save_cleanup_jobs (eligible_at, retry_at, save_session_id)
    WHERE status IN ('queued', 'retry_wait', 'running');

-- Every multipart create begins with an expiry-delayed reconcile guard. A
-- process can disappear after the backend accepted create but before the
-- response or DB attach was observed. The guard is deleted only by the same
-- transaction that persists `ready`; an explicit unknown result makes it
-- eligible immediately.
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
                WHEN NEW.create_status IN ('unknown', 'cleaned') THEN transaction_timestamp()
                ELSE GREATEST(parent.expires_at, transaction_timestamp())
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

CREATE OR REPLACE FUNCTION enqueue_terminal_save_cleanup()
RETURNS trigger
LANGUAGE plpgsql
AS $$
BEGIN
    IF OLD.state IN ('created', 'uploading', 'verifying')
        AND NEW.state IN ('aborted', 'expired', 'failed')
    THEN
        INSERT INTO save_cleanup_jobs (
            save_session_id, cleanup_kind, object_key, multipart_upload_id, eligible_at
        ) VALUES (
            NEW.id,
            CASE
                WHEN NEW.upload_mode = 'single' THEN 'single_delete'
                WHEN NEW.multipart_upload_id IS NOT NULL THEN 'multipart_abort'
                ELSE 'multipart_reconcile'
            END,
            NEW.staging_object_key,
            NEW.multipart_upload_id,
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
        WHEN session.upload_mode = 'single' THEN 'single_delete'
        WHEN session.multipart_upload_id IS NOT NULL THEN 'multipart_abort'
        ELSE 'multipart_reconcile'
    END,
    session.staging_object_key,
    session.multipart_upload_id,
    CASE
        WHEN session.upload_mode = 'single'
            THEN GREATEST(session.expires_at, transaction_timestamp())
        ELSE transaction_timestamp()
    END
FROM save_sessions session
WHERE session.state IN ('aborted', 'expired', 'failed')
ON CONFLICT (save_session_id) DO NOTHING;

-- Forward upgrades and a process crash before the application records an
-- ambiguous create still need a restart-safe cleanup owner. `creating` waits
-- for session expiry; `unknown` is immediately eligible.
INSERT INTO save_cleanup_jobs (
    save_session_id, cleanup_kind, object_key, eligible_at
)
SELECT
    session.id,
    'multipart_reconcile',
    session.staging_object_key,
    CASE
        WHEN lifecycle.create_status = 'unknown' THEN transaction_timestamp()
        ELSE GREATEST(session.expires_at, transaction_timestamp())
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
