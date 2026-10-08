-- Git import/pull materializes a verified canonical Bundle without pretending
-- that the server-side operation was a browser Save session.

-- This durable ledger is intentionally independent from Project foreign keys:
-- an uploaded object must remain discoverable for cleanup even if finalization
-- rolls back or the destination Project is concurrently deleted.
CREATE TABLE canonical_bundle_materializations (
    id uuid PRIMARY KEY,
    project_id uuid NOT NULL,
    storage_scope_id uuid NOT NULL,
    sha256 bytea NOT NULL,
    object_key text NOT NULL,
    physical_bytes bigint NOT NULL,
    logical_bytes bigint NOT NULL,
    file_count integer NOT NULL,
    multipart_upload_id text,
    state text NOT NULL DEFAULT 'pending',
    created_at timestamptz NOT NULL DEFAULT CURRENT_TIMESTAMP,
    updated_at timestamptz NOT NULL DEFAULT CURRENT_TIMESTAMP,
    CONSTRAINT canonical_bundle_materializations_id_v7_check CHECK (
        substring(id::text FROM 15 FOR 1) = '7'
        AND substring(id::text FROM 20 FOR 1) IN ('8', '9', 'a', 'b')
    ),
    CONSTRAINT canonical_bundle_materializations_sha_check CHECK (octet_length(sha256) = 32),
    CONSTRAINT canonical_bundle_materializations_key_check CHECK (
        octet_length(object_key) BETWEEN 1 AND 1024
        AND object_key = btrim(object_key)
        AND object_key !~ '[[:cntrl:]]'
        AND object_key !~ '(^/|//|(^|/)\.\.?(/|$))'
    ),
    CONSTRAINT canonical_bundle_materializations_bytes_check CHECK (
        physical_bytes BETWEEN 1 AND 2147483648
    ),
    CONSTRAINT canonical_bundle_materializations_logical_check CHECK (
        logical_bytes BETWEEN 0 AND 268435456
    ),
    CONSTRAINT canonical_bundle_materializations_file_count_check CHECK (
        file_count BETWEEN 0 AND 2500
    ),
    CONSTRAINT canonical_bundle_materializations_upload_id_check CHECK (
        multipart_upload_id IS NULL OR (
            octet_length(multipart_upload_id) BETWEEN 1 AND 2048
            AND multipart_upload_id = btrim(multipart_upload_id)
            AND multipart_upload_id !~ '[[:cntrl:]]'
        )
    ),
    CONSTRAINT canonical_bundle_materializations_state_check CHECK (
        state IN ('pending', 'uploaded', 'finalized', 'cleanup_pending')
    ),
    CONSTRAINT canonical_bundle_materializations_retry_unique
        UNIQUE (project_id, storage_scope_id, sha256)
);

CREATE INDEX canonical_bundle_materializations_cleanup_idx
    ON canonical_bundle_materializations (state, updated_at)
    WHERE state IN ('pending', 'uploaded', 'cleanup_pending');

-- Extend the existing GC provenance guard: canonical server-side
-- materializations have no Save session, but their durable ledger carries the
-- same exact object identity needed to authorize verification-failure cleanup.
CREATE OR REPLACE FUNCTION enforce_gc_candidate_insert()
RETURNS trigger
LANGUAGE plpgsql
AS $$
BEGIN
    IF NEW.status <> 'queued'
        OR NEW.attempts <> 0
        OR NEW.retry_at IS NOT NULL
        OR NEW.started_at IS NOT NULL
        OR NEW.completed_at IS NOT NULL
    THEN
        RAISE EXCEPTION 'GC candidate must begin queued without attempts'
            USING ERRCODE = '23514';
    END IF;

    PERFORM lock_bundle_object_lifecycle(NEW.object_key);
    IF NEW.reason IN ('working_head_replaced', 'reference_removed', 'project_deleted') THEN
        IF NOT EXISTS (
            SELECT 1 FROM bundles bundle
            WHERE bundle.object_key = NEW.object_key
              AND bundle.sha256 = NEW.expected_sha256
              AND bundle.physical_bytes = NEW.expected_bytes
        ) THEN
            RAISE EXCEPTION 'Bundle GC candidate metadata does not match a verified Bundle'
                USING ERRCODE = '23514';
        END IF;
    ELSIF NEW.reason = 'verification_failed' THEN
        IF NOT EXISTS (
            SELECT 1 FROM save_sessions session
            WHERE session.staging_object_key = NEW.object_key
              AND session.expected_bundle_sha256 = NEW.expected_sha256
              AND session.expected_physical_bytes = NEW.expected_bytes
              AND session.state IN ('aborted', 'expired', 'failed')
        ) AND NOT EXISTS (
            SELECT 1 FROM canonical_bundle_materializations materialization
            WHERE materialization.object_key = NEW.object_key
              AND materialization.sha256 = NEW.expected_sha256
              AND materialization.physical_bytes = NEW.expected_bytes
              AND materialization.state IN ('pending', 'uploaded', 'cleanup_pending')
        ) THEN
            RAISE EXCEPTION 'verification GC candidate requires exact durable provenance'
                USING ERRCODE = '23514';
        END IF;
    ELSE
        IF NOT EXISTS (
            SELECT 1 FROM save_sessions session
            WHERE session.staging_object_key = NEW.object_key
              AND session.expected_bundle_sha256 = NEW.expected_sha256
              AND session.expected_physical_bytes = NEW.expected_bytes
              AND session.state IN ('aborted', 'expired', 'failed')
        ) THEN
            RAISE EXCEPTION 'staging GC candidate requires a terminal matching Save session'
                USING ERRCODE = '23514';
        END IF;
    END IF;
    RETURN NEW;
END;
$$;

ALTER TABLE published_example_forks
    ADD COLUMN canonical_materialization_id uuid NOT NULL UNIQUE,
    ADD CONSTRAINT published_example_forks_canonical_source_fk
        FOREIGN KEY (canonical_materialization_id)
        REFERENCES canonical_bundle_materializations (id) ON DELETE RESTRICT;

-- Migration 0043 validates the immutable publication source. Extend that
-- guard now that the durable materialization ledger exists so a fork cannot
-- attest an unrelated verified Bundle as destination-specific.
CREATE OR REPLACE FUNCTION enforce_published_example_fork_insert()
RETURNS trigger LANGUAGE plpgsql AS $$
DECLARE
    source_bundle uuid;
BEGIN
    SELECT reference.bundle_id INTO source_bundle
    FROM published_examples example
    JOIN published_example_versions version
      ON version.example_id = example.id
    JOIN project_bundle_refs reference
      ON reference.id = version.project_version_id
     AND reference.project_id = version.project_id
     AND reference.kind = 'version'
    WHERE example.id = NEW.source_example_id
      AND example.public_id = NEW.source_public_id
      AND example.state = 'published'
      AND version.id = NEW.source_example_version_id
      AND version.version_number = NEW.source_version_number
      AND (
          (NEW.requested_version_number IS NULL AND example.active_version_id = version.id)
          OR NEW.requested_version_number = version.version_number
      )
    FOR SHARE OF example, version, reference;

    IF source_bundle IS NULL OR source_bundle <> NEW.source_bundle_id THEN
        RAISE EXCEPTION 'Published Example fork requires one published immutable version'
            USING ERRCODE = '23514';
    END IF;
    IF NEW.destination_bundle_id = NEW.source_bundle_id OR NOT EXISTS (
        SELECT 1
        FROM canonical_bundle_materializations materialization
        JOIN bundles bundle
          ON bundle.id = NEW.destination_bundle_id
         AND bundle.sha256 = materialization.sha256
         AND bundle.object_key = materialization.object_key
         AND bundle.physical_bytes = materialization.physical_bytes
         AND bundle.logical_bytes = materialization.logical_bytes
         AND bundle.file_count = materialization.file_count
         AND bundle.verification_state = 'verified'
         AND bundle.format = 'project-bundle-v1'
        WHERE materialization.id = NEW.canonical_materialization_id
          AND materialization.project_id = NEW.destination_project_id
          AND materialization.storage_scope_id = NEW.destination_storage_scope_id
          AND materialization.state = 'uploaded'
    ) THEN
        RAISE EXCEPTION 'Published Example fork requires its exact destination materialization'
            USING ERRCODE = '23514';
    END IF;
    RETURN NEW;
END;
$$;

CREATE OR REPLACE FUNCTION enforce_verified_bundle_insert()
RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
    PERFORM lock_bundle_object_lifecycle(NEW.object_key);
    IF EXISTS (
        SELECT 1 FROM gc_candidates candidate
        WHERE candidate.object_key = NEW.object_key
          AND candidate.status IN ('running', 'completed')
    ) THEN
        RAISE EXCEPTION 'verified Bundle object is being deleted or was deleted'
            USING ERRCODE = '23514';
    END IF;

    IF NOT EXISTS (
        SELECT 1 FROM save_sessions session
        WHERE session.staging_object_key = NEW.object_key
          AND session.expected_bundle_sha256 = NEW.sha256
          AND session.expected_physical_bytes = NEW.physical_bytes
          AND session.expected_logical_bytes = NEW.logical_bytes
          AND session.expected_file_count = NEW.file_count
          AND session.state = 'verifying'
          AND session.expires_at > transaction_timestamp()
    ) AND NOT EXISTS (
        SELECT 1 FROM canonical_bundle_materializations materialization
        WHERE materialization.object_key = NEW.object_key
          AND materialization.sha256 = NEW.sha256
          AND materialization.physical_bytes = NEW.physical_bytes
          AND materialization.logical_bytes = NEW.logical_bytes
          AND materialization.file_count = NEW.file_count
          AND materialization.state IN ('uploaded', 'finalized')
    ) THEN
        RAISE EXCEPTION 'verified Bundle requires a verified materialization source'
            USING ERRCODE = '23514';
    END IF;
    RETURN NEW;
END;
$$;

CREATE TABLE git_working_head_materializations (
    id uuid PRIMARY KEY,
    project_id uuid NOT NULL,
    storage_scope_id uuid NOT NULL,
    bundle_id uuid NOT NULL,
    canonical_materialization_id uuid NOT NULL,
    actor_user_id uuid NOT NULL REFERENCES users (id) ON DELETE RESTRICT,
    remote_head_sha text NOT NULL,
    created_at timestamptz NOT NULL DEFAULT CURRENT_TIMESTAMP,
    CONSTRAINT git_working_head_materializations_id_v7_check CHECK (
        substring(id::text FROM 15 FOR 1) = '7'
        AND substring(id::text FROM 20 FOR 1) IN ('8', '9', 'a', 'b')
    ),
    CONSTRAINT git_working_head_materializations_project_scope_fk
        FOREIGN KEY (project_id, storage_scope_id)
        REFERENCES projects (id, storage_scope_id) ON DELETE CASCADE,
    CONSTRAINT git_working_head_materializations_bundle_fk
        FOREIGN KEY (bundle_id) REFERENCES bundles (id) ON DELETE RESTRICT,
    CONSTRAINT git_working_head_materializations_canonical_source_fk
        FOREIGN KEY (canonical_materialization_id)
        REFERENCES canonical_bundle_materializations (id) ON DELETE RESTRICT,
    CONSTRAINT git_working_head_materializations_sha_check CHECK (
        remote_head_sha ~ '^([0-9a-f]{40}|[0-9a-f]{64})$'
    ),
    CONSTRAINT git_working_head_materializations_identity_unique
        UNIQUE (id, project_id, storage_scope_id, bundle_id)
);

CREATE FUNCTION enforce_git_working_head_materialization_insert()
RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
    IF NOT EXISTS (
        SELECT 1
        FROM canonical_bundle_materializations materialization
        JOIN bundles bundle
          ON bundle.id = NEW.bundle_id
         AND bundle.sha256 = materialization.sha256
         AND bundle.object_key = materialization.object_key
         AND bundle.physical_bytes = materialization.physical_bytes
         AND bundle.logical_bytes = materialization.logical_bytes
         AND bundle.file_count = materialization.file_count
        WHERE materialization.id = NEW.canonical_materialization_id
          AND materialization.project_id = NEW.project_id
          AND materialization.storage_scope_id = NEW.storage_scope_id
          AND materialization.state IN ('uploaded', 'finalized')
    ) THEN
        RAISE EXCEPTION 'Git Working Head requires its exact canonical materialization'
            USING ERRCODE = '23514';
    END IF;
    RETURN NEW;
END;
$$;

CREATE TRIGGER git_working_head_materializations_source_guard
    BEFORE INSERT ON git_working_head_materializations
    FOR EACH ROW EXECUTE FUNCTION enforce_git_working_head_materialization_insert();

ALTER TABLE project_bundle_admissions
    ADD COLUMN source_git_materialization_id uuid UNIQUE,
    ADD CONSTRAINT project_bundle_admissions_git_source_fk
        FOREIGN KEY (source_git_materialization_id)
        REFERENCES git_working_head_materializations (id) ON DELETE RESTRICT;

ALTER TABLE project_bundle_admissions
    DROP CONSTRAINT project_bundle_admissions_provenance_check,
    ADD CONSTRAINT project_bundle_admissions_provenance_check CHECK (
        num_nonnulls(
            source_save_session_id,
            source_published_example_fork_id,
            source_git_materialization_id
        ) = 1
        AND (
            source_save_session_id IS NULL
            OR (save_session_id IS NULL OR save_session_id = source_save_session_id)
        )
        AND (source_save_session_id IS NOT NULL OR save_session_id IS NULL)
    );

CREATE OR REPLACE FUNCTION enforce_project_bundle_admission_insert()
RETURNS trigger LANGUAGE plpgsql AS $$
DECLARE
    candidate_object_key text;
BEGIN
    IF NEW.source_save_session_id IS NOT NULL THEN
        IF NOT EXISTS (
            SELECT 1 FROM save_sessions session
            WHERE session.id = NEW.source_save_session_id
              AND session.project_id = NEW.project_id
              AND session.storage_scope_id = NEW.storage_scope_id
              AND session.committed_bundle_id = NEW.bundle_id
              AND session.state = 'committed'
              AND NEW.save_session_id = NEW.source_save_session_id
        ) THEN
            RAISE EXCEPTION 'Project Bundle admission requires its committed Save session'
                USING ERRCODE = '23514';
        END IF;
    ELSIF NEW.source_published_example_fork_id IS NOT NULL THEN
        IF NOT EXISTS (
            SELECT 1 FROM published_example_forks fork
            WHERE fork.id = NEW.source_published_example_fork_id
              AND fork.destination_project_id = NEW.project_id
              AND fork.destination_storage_scope_id = NEW.storage_scope_id
              AND fork.destination_bundle_id = NEW.bundle_id
        ) THEN
            RAISE EXCEPTION 'Project Bundle admission requires its Published Example fork operation'
                USING ERRCODE = '23514';
        END IF;
    ELSIF NOT EXISTS (
        SELECT 1 FROM git_working_head_materializations materialization
        WHERE materialization.id = NEW.source_git_materialization_id
          AND materialization.project_id = NEW.project_id
          AND materialization.storage_scope_id = NEW.storage_scope_id
          AND materialization.bundle_id = NEW.bundle_id
    ) THEN
        RAISE EXCEPTION 'Project Bundle admission requires its Git materialization'
            USING ERRCODE = '23514';
    END IF;

    SELECT bundle.object_key INTO candidate_object_key
    FROM bundles bundle WHERE bundle.id = NEW.bundle_id;
    IF candidate_object_key IS NULL THEN
        RAISE EXCEPTION 'Project Bundle admission requires a verified Bundle'
            USING ERRCODE = '23514';
    END IF;
    PERFORM lock_project_bundle_transition(NEW.project_id, NEW.bundle_id);
    IF EXISTS (
        SELECT 1 FROM gc_candidates candidate
        WHERE candidate.object_key = candidate_object_key
          AND candidate.status IN ('running', 'completed')
    ) THEN
        RAISE EXCEPTION 'Project Bundle admission is fenced by GC'
            USING ERRCODE = '23514';
    END IF;
    RETURN NEW;
END;
$$;

CREATE OR REPLACE FUNCTION reject_project_bundle_admission_update()
RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
    IF OLD.source_save_session_id IS NOT NULL
        AND OLD.save_session_id IS NOT NULL
        AND NEW.save_session_id IS NULL
        AND NEW.source_save_session_id IS NOT DISTINCT FROM OLD.source_save_session_id
        AND NEW.source_published_example_fork_id IS NOT DISTINCT FROM OLD.source_published_example_fork_id
        AND NEW.source_git_materialization_id IS NOT DISTINCT FROM OLD.source_git_materialization_id
        AND NEW.project_id IS NOT DISTINCT FROM OLD.project_id
        AND NEW.storage_scope_id IS NOT DISTINCT FROM OLD.storage_scope_id
        AND NEW.bundle_id IS NOT DISTINCT FROM OLD.bundle_id
        AND NEW.created_at IS NOT DISTINCT FROM OLD.created_at
    THEN
        RETURN NEW;
    END IF;
    RAISE EXCEPTION 'Project Bundle admission is immutable'
        USING ERRCODE = '23514';
END;
$$;

CREATE TRIGGER git_working_head_materializations_no_truncate
    BEFORE TRUNCATE ON git_working_head_materializations
    FOR EACH STATEMENT EXECUTE FUNCTION reject_bundle_persistence_truncate();

CREATE TRIGGER canonical_bundle_materializations_no_truncate
    BEFORE TRUNCATE ON canonical_bundle_materializations
    FOR EACH STATEMENT EXECUTE FUNCTION reject_bundle_persistence_truncate();
