-- Verified immutable Project Bundle metadata and the persistence control plane
-- for bounded Save sessions. Untrusted staging payloads remain represented by
-- save_sessions until verification succeeds; they never reserve a global
-- Bundle checksum or become a Project reference.

ALTER TABLE projects
    ADD CONSTRAINT projects_storage_identity_unique
        UNIQUE (id, storage_scope_id),
    ADD COLUMN working_head_bundle_id uuid;

CREATE TABLE bundles (
    id uuid PRIMARY KEY,
    sha256 bytea NOT NULL,
    object_key text NOT NULL,
    physical_bytes bigint NOT NULL,
    logical_bytes bigint NOT NULL,
    file_count integer NOT NULL,
    format text NOT NULL,
    verification_state text NOT NULL DEFAULT 'verified',
    verified_at timestamptz NOT NULL,
    created_at timestamptz NOT NULL DEFAULT CURRENT_TIMESTAMP,
    CONSTRAINT bundles_id_v7_check
        CHECK (
            substring(id::text FROM 15 FOR 1) = '7'
            AND substring(id::text FROM 20 FOR 1) IN ('8', '9', 'a', 'b')
        ),
    CONSTRAINT bundles_sha256_check CHECK (octet_length(sha256) = 32),
    CONSTRAINT bundles_sha256_unique UNIQUE (sha256),
    CONSTRAINT bundles_object_key_check
        CHECK (
            octet_length(object_key) BETWEEN 1 AND 1024
            AND object_key = btrim(object_key)
            AND object_key !~ '[[:cntrl:]]'
            AND object_key !~ '(^/|//|(^|/)\.\.?(/|$))'
        ),
    CONSTRAINT bundles_object_key_unique UNIQUE (object_key),
    CONSTRAINT bundles_physical_bytes_check
        CHECK (physical_bytes BETWEEN 1 AND 2147483648),
    CONSTRAINT bundles_logical_bytes_check
        CHECK (logical_bytes BETWEEN 0 AND 268435456),
    CONSTRAINT bundles_file_count_check CHECK (file_count BETWEEN 0 AND 2500),
    CONSTRAINT bundles_format_check CHECK (format = 'project-bundle-v1'),
    CONSTRAINT bundles_verified_only_check CHECK (verification_state = 'verified'),
    CONSTRAINT bundles_timestamps_check
        CHECK (verified_at >= created_at)
);

CREATE OR REPLACE FUNCTION reject_bundle_update()
RETURNS trigger
LANGUAGE plpgsql
AS $$
BEGIN
    RAISE EXCEPTION 'verified Bundle metadata is immutable'
        USING ERRCODE = '23514';
END;
$$;

CREATE TRIGGER bundles_immutable
    BEFORE UPDATE ON bundles
    FOR EACH ROW
    EXECUTE FUNCTION reject_bundle_update();

CREATE TABLE save_sessions (
    id uuid PRIMARY KEY,
    project_id uuid NOT NULL,
    storage_scope_id uuid NOT NULL,
    actor_user_id uuid NOT NULL,
    expected_project_version bigint NOT NULL,
    expected_bundle_sha256 bytea NOT NULL,
    expected_physical_bytes bigint NOT NULL,
    expected_logical_bytes bigint NOT NULL,
    expected_file_count integer NOT NULL,
    staging_object_key text NOT NULL,
    upload_mode text NOT NULL,
    multipart_upload_id text,
    state text NOT NULL DEFAULT 'created',
    committed_bundle_id uuid,
    committed_bundle_purged_at timestamptz,
    created_at timestamptz NOT NULL DEFAULT CURRENT_TIMESTAMP,
    updated_at timestamptz NOT NULL DEFAULT CURRENT_TIMESTAMP,
    expires_at timestamptz NOT NULL,
    terminal_at timestamptz,
    CONSTRAINT save_sessions_id_v7_check
        CHECK (
            substring(id::text FROM 15 FOR 1) = '7'
            AND substring(id::text FROM 20 FOR 1) IN ('8', '9', 'a', 'b')
        ),
    CONSTRAINT save_sessions_project_scope_fk
        FOREIGN KEY (project_id, storage_scope_id)
        REFERENCES projects (id, storage_scope_id)
        ON DELETE CASCADE,
    CONSTRAINT save_sessions_actor_fk
        FOREIGN KEY (actor_user_id) REFERENCES users (id) ON DELETE RESTRICT,
    CONSTRAINT save_sessions_expected_project_version_check
        CHECK (expected_project_version BETWEEN 1 AND 9223372036854775806),
    CONSTRAINT save_sessions_expected_sha256_check
        CHECK (octet_length(expected_bundle_sha256) = 32),
    CONSTRAINT save_sessions_expected_physical_bytes_check
        CHECK (expected_physical_bytes BETWEEN 1 AND 2147483648),
    CONSTRAINT save_sessions_expected_logical_bytes_check
        CHECK (expected_logical_bytes BETWEEN 0 AND 268435456),
    CONSTRAINT save_sessions_expected_file_count_check
        CHECK (expected_file_count BETWEEN 0 AND 2500),
    CONSTRAINT save_sessions_staging_object_key_check
        CHECK (
            octet_length(staging_object_key) BETWEEN 1 AND 1024
            AND staging_object_key = btrim(staging_object_key)
            AND staging_object_key !~ '[[:cntrl:]]'
            AND staging_object_key !~ '(^/|//|(^|/)\.\.?(/|$))'
        ),
    CONSTRAINT save_sessions_staging_object_key_unique UNIQUE (staging_object_key),
    CONSTRAINT save_sessions_upload_mode_check CHECK (upload_mode IN ('single', 'multipart')),
    CONSTRAINT save_sessions_multipart_upload_id_check
        CHECK (
            (upload_mode = 'single' AND multipart_upload_id IS NULL)
            OR (
                upload_mode = 'multipart'
                AND (
                    multipart_upload_id IS NULL
                    OR (
                        octet_length(multipart_upload_id) BETWEEN 1 AND 1024
                        AND multipart_upload_id = btrim(multipart_upload_id)
                        AND multipart_upload_id !~ '[[:cntrl:]]'
                    )
                )
            )
        ),
    CONSTRAINT save_sessions_multipart_upload_id_unique UNIQUE (multipart_upload_id),
    CONSTRAINT save_sessions_state_check
        CHECK (state IN (
            'created', 'uploading', 'verifying',
            'committed', 'aborted', 'expired', 'failed'
        )),
    CONSTRAINT save_sessions_committed_bundle_fk
        FOREIGN KEY (committed_bundle_id) REFERENCES bundles (id) ON DELETE RESTRICT,
    CONSTRAINT save_sessions_terminal_check
        CHECK (
            (
                state IN ('created', 'uploading', 'verifying')
                AND terminal_at IS NULL
                AND committed_bundle_id IS NULL
                AND committed_bundle_purged_at IS NULL
            )
            OR (
                state = 'committed'
                AND terminal_at IS NOT NULL
                AND (
                    (committed_bundle_id IS NOT NULL AND committed_bundle_purged_at IS NULL)
                    OR (committed_bundle_id IS NULL AND committed_bundle_purged_at IS NOT NULL)
                )
            )
            OR (
                state IN ('aborted', 'expired', 'failed')
                AND terminal_at IS NOT NULL
                AND committed_bundle_id IS NULL
                AND committed_bundle_purged_at IS NULL
            )
        ),
    CONSTRAINT save_sessions_timestamps_check
        CHECK (
            updated_at >= created_at
            AND expires_at > created_at
            AND (terminal_at IS NULL OR terminal_at >= created_at)
            AND (terminal_at IS NULL OR updated_at >= terminal_at)
            AND (
                committed_bundle_purged_at IS NULL
                OR committed_bundle_purged_at >= terminal_at
            )
            AND (
                committed_bundle_purged_at IS NULL
                OR updated_at >= committed_bundle_purged_at
            )
        ),
    CONSTRAINT save_sessions_identity_unique UNIQUE (id, storage_scope_id),
    CONSTRAINT save_sessions_project_bundle_identity_unique
        UNIQUE (id, project_id, storage_scope_id, committed_bundle_id)
);

CREATE UNIQUE INDEX save_sessions_one_active_per_project_idx
    ON save_sessions (project_id)
    WHERE state IN ('created', 'uploading', 'verifying');
CREATE INDEX save_sessions_expiry_idx
    ON save_sessions (expires_at, id)
    WHERE state IN ('created', 'uploading', 'verifying');
CREATE INDEX save_sessions_scope_state_idx
    ON save_sessions (storage_scope_id, state, id);

CREATE TABLE storage_reservations (
    save_session_id uuid PRIMARY KEY,
    storage_scope_id uuid NOT NULL,
    reserved_bytes bigint NOT NULL,
    created_at timestamptz NOT NULL DEFAULT CURRENT_TIMESTAMP,
    expires_at timestamptz NOT NULL,
    CONSTRAINT storage_reservations_session_scope_fk
        FOREIGN KEY (save_session_id, storage_scope_id)
        REFERENCES save_sessions (id, storage_scope_id)
        ON DELETE CASCADE,
    CONSTRAINT storage_reservations_scope_fk
        FOREIGN KEY (storage_scope_id) REFERENCES storage_scopes (id) ON DELETE RESTRICT,
    CONSTRAINT storage_reservations_bytes_check
        CHECK (reserved_bytes BETWEEN 1 AND 2147483648),
    CONSTRAINT storage_reservations_timestamps_check
        CHECK (expires_at > created_at)
);

CREATE INDEX storage_reservations_scope_idx
    ON storage_reservations (storage_scope_id, expires_at, save_session_id);

-- A global verified Bundle may be physically deduplicated across Projects, but
-- each Project must first admit it through its own committed Save session.
-- Working Head and history references use this relation as their provenance FK.
CREATE TABLE project_bundle_admissions (
    project_id uuid NOT NULL,
    storage_scope_id uuid NOT NULL,
    bundle_id uuid NOT NULL,
    source_save_session_id uuid NOT NULL UNIQUE,
    save_session_id uuid UNIQUE,
    created_at timestamptz NOT NULL DEFAULT CURRENT_TIMESTAMP,
    PRIMARY KEY (project_id, bundle_id),
    CONSTRAINT project_bundle_admissions_project_scope_fk
        FOREIGN KEY (project_id, storage_scope_id)
        REFERENCES projects (id, storage_scope_id)
        ON DELETE CASCADE,
    CONSTRAINT project_bundle_admissions_bundle_fk
        FOREIGN KEY (bundle_id) REFERENCES bundles (id) ON DELETE RESTRICT,
    CONSTRAINT project_bundle_admissions_committed_save_fk
        FOREIGN KEY (save_session_id, project_id, storage_scope_id, bundle_id)
        REFERENCES save_sessions (
            id, project_id, storage_scope_id, committed_bundle_id
        )
        ON DELETE SET NULL (save_session_id),
    CONSTRAINT project_bundle_admissions_save_provenance_check
        CHECK (
            save_session_id IS NULL
            OR save_session_id = source_save_session_id
        ),
    CONSTRAINT project_bundle_admissions_scope_identity_unique
        UNIQUE (project_id, storage_scope_id, bundle_id)
);

CREATE INDEX project_bundle_admissions_scope_bundle_idx
    ON project_bundle_admissions (storage_scope_id, bundle_id, project_id);

CREATE TABLE multipart_parts (
    save_session_id uuid NOT NULL,
    part_number smallint NOT NULL,
    expected_bytes bigint NOT NULL,
    expected_sha256 bytea NOT NULL,
    state text NOT NULL DEFAULT 'pending',
    object_etag text,
    created_at timestamptz NOT NULL DEFAULT CURRENT_TIMESTAMP,
    updated_at timestamptz NOT NULL DEFAULT CURRENT_TIMESTAMP,
    uploaded_at timestamptz,
    PRIMARY KEY (save_session_id, part_number),
    CONSTRAINT multipart_parts_session_fk
        FOREIGN KEY (save_session_id) REFERENCES save_sessions (id) ON DELETE CASCADE,
    CONSTRAINT multipart_parts_number_check CHECK (part_number BETWEEN 1 AND 128),
    CONSTRAINT multipart_parts_expected_bytes_check
        CHECK (expected_bytes BETWEEN 1 AND 67108864),
    CONSTRAINT multipart_parts_expected_sha256_check
        CHECK (octet_length(expected_sha256) = 32),
    CONSTRAINT multipart_parts_state_check CHECK (state IN ('pending', 'uploaded')),
    CONSTRAINT multipart_parts_upload_check
        CHECK (
            (state = 'pending' AND object_etag IS NULL AND uploaded_at IS NULL)
            OR (
                state = 'uploaded'
                AND object_etag IS NOT NULL
                AND octet_length(object_etag) BETWEEN 1 AND 512
                AND object_etag = btrim(object_etag)
                AND object_etag !~ '[[:cntrl:]]'
                AND uploaded_at IS NOT NULL
            )
        ),
    CONSTRAINT multipart_parts_timestamps_check
        CHECK (
            updated_at >= created_at
            AND (uploaded_at IS NULL OR uploaded_at >= created_at)
            AND (uploaded_at IS NULL OR updated_at >= uploaded_at)
        )
);

CREATE TABLE project_bundle_refs (
    id uuid PRIMARY KEY,
    project_id uuid NOT NULL,
    storage_scope_id uuid NOT NULL,
    bundle_id uuid NOT NULL,
    kind text NOT NULL,
    recovery_position smallint,
    version_name text,
    actor_user_id uuid NOT NULL,
    created_at timestamptz NOT NULL DEFAULT CURRENT_TIMESTAMP,
    CONSTRAINT project_bundle_refs_id_v7_check
        CHECK (
            substring(id::text FROM 15 FOR 1) = '7'
            AND substring(id::text FROM 20 FOR 1) IN ('8', '9', 'a', 'b')
        ),
    CONSTRAINT project_bundle_refs_project_scope_fk
        FOREIGN KEY (project_id, storage_scope_id)
        REFERENCES projects (id, storage_scope_id)
        ON DELETE CASCADE,
    CONSTRAINT project_bundle_refs_bundle_fk
        FOREIGN KEY (bundle_id) REFERENCES bundles (id) ON DELETE RESTRICT,
    CONSTRAINT project_bundle_refs_admission_fk
        FOREIGN KEY (project_id, storage_scope_id, bundle_id)
        REFERENCES project_bundle_admissions (project_id, storage_scope_id, bundle_id)
        ON DELETE RESTRICT,
    CONSTRAINT project_bundle_refs_actor_fk
        FOREIGN KEY (actor_user_id) REFERENCES users (id) ON DELETE RESTRICT,
    CONSTRAINT project_bundle_refs_kind_check CHECK (kind IN ('recovery', 'version')),
    CONSTRAINT project_bundle_refs_shape_check
        CHECK (
            (
                kind = 'recovery'
                AND recovery_position BETWEEN 1 AND 3
                AND version_name IS NULL
            )
            OR (
                kind = 'version'
                AND recovery_position IS NULL
                AND version_name IS NOT NULL
                AND version_name = btrim(version_name)
                AND version_name !~ '[[:cntrl:]]'
                AND char_length(version_name) BETWEEN 1 AND 200
            )
        )
);

CREATE UNIQUE INDEX project_bundle_refs_recovery_slot_unique
    ON project_bundle_refs (project_id, recovery_position)
    WHERE kind = 'recovery';
CREATE UNIQUE INDEX project_bundle_refs_version_name_unique
    ON project_bundle_refs (project_id, version_name)
    WHERE kind = 'version';
CREATE INDEX project_bundle_refs_bundle_idx
    ON project_bundle_refs (bundle_id, project_id);
CREATE INDEX project_bundle_refs_scope_bundle_idx
    ON project_bundle_refs (storage_scope_id, bundle_id);
CREATE INDEX project_bundle_refs_project_created_idx
    ON project_bundle_refs (project_id, created_at DESC, id DESC);

CREATE TABLE gc_candidates (
    object_key text PRIMARY KEY,
    expected_sha256 bytea NOT NULL,
    expected_bytes bigint NOT NULL,
    reason text NOT NULL,
    status text NOT NULL DEFAULT 'queued',
    attempts integer NOT NULL DEFAULT 0,
    eligible_at timestamptz NOT NULL,
    retry_at timestamptz,
    started_at timestamptz,
    completed_at timestamptz,
    created_at timestamptz NOT NULL DEFAULT CURRENT_TIMESTAMP,
    updated_at timestamptz NOT NULL DEFAULT CURRENT_TIMESTAMP,
    CONSTRAINT gc_candidates_object_key_check
        CHECK (
            octet_length(object_key) BETWEEN 1 AND 1024
            AND object_key = btrim(object_key)
            AND object_key !~ '[[:cntrl:]]'
            AND object_key !~ '(^/|//|(^|/)\.\.?(/|$))'
        ),
    CONSTRAINT gc_candidates_sha256_check CHECK (octet_length(expected_sha256) = 32),
    CONSTRAINT gc_candidates_bytes_check CHECK (expected_bytes BETWEEN 1 AND 2147483648),
    CONSTRAINT gc_candidates_reason_check
        CHECK (reason IN (
            'working_head_replaced', 'reference_removed', 'project_deleted',
            'save_abandoned', 'verification_failed'
        )),
    CONSTRAINT gc_candidates_status_check
        CHECK (status IN ('queued', 'running', 'retry_wait', 'completed', 'failed')),
    CONSTRAINT gc_candidates_attempts_check CHECK (attempts BETWEEN 0 AND 1000000),
    CONSTRAINT gc_candidates_state_shape_check
        CHECK (
            (status = 'queued' AND retry_at IS NULL AND started_at IS NULL AND completed_at IS NULL)
            OR (
                status = 'running'
                AND retry_at IS NULL
                AND started_at IS NOT NULL
                AND completed_at IS NULL
            )
            OR (
                status = 'retry_wait'
                AND retry_at IS NOT NULL
                AND started_at IS NOT NULL
                AND completed_at IS NULL
            )
            OR (
                status = 'failed'
                AND retry_at IS NULL
                AND started_at IS NOT NULL
                AND completed_at IS NULL
            )
            OR (
                status = 'completed'
                AND retry_at IS NULL
                AND started_at IS NOT NULL
                AND completed_at IS NOT NULL
            )
        ),
    CONSTRAINT gc_candidates_timestamps_check
        CHECK (
            updated_at >= created_at
            AND eligible_at >= created_at
            AND (retry_at IS NULL OR retry_at >= created_at)
            AND (started_at IS NULL OR started_at >= created_at)
            AND (completed_at IS NULL OR completed_at >= started_at)
            AND (completed_at IS NULL OR updated_at >= completed_at)
        )
);

CREATE INDEX gc_candidates_work_idx
    ON gc_candidates (status, eligible_at, retry_at, object_key);

CREATE OR REPLACE FUNCTION reject_bundle_persistence_truncate()
RETURNS trigger
LANGUAGE plpgsql
AS $$
BEGIN
    RAISE EXCEPTION 'Bundle persistence relations cannot be truncated'
        USING ERRCODE = '23514';
END;
$$;

CREATE TRIGGER bundles_no_truncate
    BEFORE TRUNCATE ON bundles
    FOR EACH STATEMENT EXECUTE FUNCTION reject_bundle_persistence_truncate();
CREATE TRIGGER save_sessions_no_truncate
    BEFORE TRUNCATE ON save_sessions
    FOR EACH STATEMENT EXECUTE FUNCTION reject_bundle_persistence_truncate();
CREATE TRIGGER storage_reservations_no_truncate
    BEFORE TRUNCATE ON storage_reservations
    FOR EACH STATEMENT EXECUTE FUNCTION reject_bundle_persistence_truncate();
CREATE TRIGGER project_bundle_admissions_no_truncate
    BEFORE TRUNCATE ON project_bundle_admissions
    FOR EACH STATEMENT EXECUTE FUNCTION reject_bundle_persistence_truncate();
CREATE TRIGGER multipart_parts_no_truncate
    BEFORE TRUNCATE ON multipart_parts
    FOR EACH STATEMENT EXECUTE FUNCTION reject_bundle_persistence_truncate();
CREATE TRIGGER project_bundle_refs_no_truncate
    BEFORE TRUNCATE ON project_bundle_refs
    FOR EACH STATEMENT EXECUTE FUNCTION reject_bundle_persistence_truncate();
CREATE TRIGGER gc_candidates_no_truncate
    BEFORE TRUNCATE ON gc_candidates
    FOR EACH STATEMENT EXECUTE FUNCTION reject_bundle_persistence_truncate();

-- Object lifecycle operations share an advisory namespace. Hash collisions may
-- serialize unrelated keys but cannot weaken reference/deletion safety.
CREATE OR REPLACE FUNCTION lock_bundle_object_lifecycle(candidate_object_key text)
RETURNS void
LANGUAGE plpgsql
AS $$
BEGIN
    PERFORM pg_advisory_xact_lock(1347566129, hashtext('bundle-object:' || candidate_object_key));
END;
$$;

-- A Working Head replacement touches both the incoming and outgoing objects.
-- Acquire their actual advisory keys in ascending order so concurrent A↔B
-- swaps cannot each retain one key while waiting for the other.
CREATE OR REPLACE FUNCTION lock_bundle_object_lifecycles(
    first_object_key text,
    second_object_key text
)
RETURNS void
LANGUAGE plpgsql
AS $$
DECLARE
    first_lock_key integer;
    second_lock_key integer;
BEGIN
    first_lock_key := CASE WHEN first_object_key IS NULL THEN NULL
        ELSE hashtext('bundle-object:' || first_object_key) END;
    second_lock_key := CASE WHEN second_object_key IS NULL THEN NULL
        ELSE hashtext('bundle-object:' || second_object_key) END;

    IF first_lock_key IS NULL THEN
        PERFORM pg_advisory_xact_lock(1347566129, second_lock_key);
    ELSIF second_lock_key IS NULL THEN
        PERFORM pg_advisory_xact_lock(1347566129, first_lock_key);
    ELSIF first_lock_key <= second_lock_key THEN
        PERFORM pg_advisory_xact_lock(1347566129, first_lock_key);
        IF first_lock_key <> second_lock_key THEN
            PERFORM pg_advisory_xact_lock(1347566129, second_lock_key);
        END IF;
    ELSE
        PERFORM pg_advisory_xact_lock(1347566129, second_lock_key);
        PERFORM pg_advisory_xact_lock(1347566129, first_lock_key);
    END IF;
END;
$$;

-- Canonical Save commit/admission/head operations lock in one global order:
-- Project row first, then the current/incoming object advisory keys sorted.
-- GC never takes a Project row lock, so it cannot form the reverse edge.
CREATE OR REPLACE FUNCTION lock_project_bundle_transition(
    candidate_project_id uuid,
    candidate_bundle_id uuid
)
RETURNS void
LANGUAGE plpgsql
AS $$
DECLARE
    current_object_key text;
    incoming_object_key text;
BEGIN
    SELECT bundle.object_key INTO incoming_object_key
    FROM bundles bundle
    WHERE bundle.id = candidate_bundle_id;
    IF incoming_object_key IS NULL THEN
        RAISE EXCEPTION 'incoming Bundle is unavailable'
            USING ERRCODE = '23514';
    END IF;

    SELECT current_bundle.object_key INTO current_object_key
    FROM projects project
    LEFT JOIN bundles current_bundle ON current_bundle.id = project.working_head_bundle_id
    WHERE project.id = candidate_project_id
    FOR UPDATE OF project;
    IF NOT FOUND THEN
        RAISE EXCEPTION 'Project is unavailable for Bundle transition'
            USING ERRCODE = '23514';
    END IF;

    PERFORM lock_bundle_object_lifecycles(current_object_key, incoming_object_key);
END;
$$;

CREATE OR REPLACE FUNCTION assert_bundle_referenceable(
    candidate_project_id uuid,
    candidate_storage_scope_id uuid,
    candidate_bundle_id uuid
)
RETURNS void
LANGUAGE plpgsql
AS $$
DECLARE
    candidate_object_key text;
BEGIN
    SELECT bundle.object_key
    INTO candidate_object_key
    FROM bundles bundle
    WHERE bundle.id = candidate_bundle_id
      AND bundle.verification_state = 'verified';

    IF candidate_object_key IS NULL THEN
        RAISE EXCEPTION 'Bundle is not verified or unavailable'
            USING ERRCODE = '23514';
    END IF;

    IF NOT EXISTS (
        SELECT 1
        FROM project_bundle_admissions admission
        WHERE admission.project_id = candidate_project_id
          AND admission.storage_scope_id = candidate_storage_scope_id
          AND admission.bundle_id = candidate_bundle_id
    ) THEN
        RAISE EXCEPTION 'Bundle was not admitted for this Project'
            USING ERRCODE = '23514';
    END IF;

    PERFORM lock_bundle_object_lifecycle(candidate_object_key);

    IF EXISTS (
        SELECT 1
        FROM gc_candidates candidate
        WHERE candidate.object_key = candidate_object_key
          AND candidate.status IN ('running', 'completed')
    ) THEN
        RAISE EXCEPTION 'Bundle object is not referenceable'
            USING ERRCODE = '23514';
    END IF;
END;
$$;

CREATE OR REPLACE FUNCTION enforce_project_working_head()
RETURNS trigger
LANGUAGE plpgsql
AS $$
BEGIN
    IF NEW.working_head_bundle_id IS NOT NULL
        AND (
            TG_OP = 'INSERT'
            OR NEW.working_head_bundle_id IS DISTINCT FROM OLD.working_head_bundle_id
        )
    THEN
        PERFORM lock_project_bundle_transition(NEW.id, NEW.working_head_bundle_id);
        PERFORM assert_bundle_referenceable(
            NEW.id,
            NEW.storage_scope_id,
            NEW.working_head_bundle_id
        );
    END IF;
    RETURN NEW;
END;
$$;

CREATE TRIGGER projects_working_head_verified
    BEFORE INSERT OR UPDATE OF working_head_bundle_id ON projects
    FOR EACH ROW
    EXECUTE FUNCTION enforce_project_working_head();

ALTER TABLE projects
    ADD CONSTRAINT projects_working_head_bundle_fk
        FOREIGN KEY (working_head_bundle_id) REFERENCES bundles (id) ON DELETE RESTRICT,
    ADD CONSTRAINT projects_working_head_admission_fk
        FOREIGN KEY (id, storage_scope_id, working_head_bundle_id)
        REFERENCES project_bundle_admissions (project_id, storage_scope_id, bundle_id)
        DEFERRABLE INITIALLY DEFERRED;

CREATE OR REPLACE FUNCTION enforce_project_bundle_ref_insert()
RETURNS trigger
LANGUAGE plpgsql
AS $$
BEGIN
    PERFORM assert_bundle_referenceable(
        NEW.project_id,
        NEW.storage_scope_id,
        NEW.bundle_id
    );
    RETURN NEW;
END;
$$;

CREATE TRIGGER project_bundle_refs_verified
    BEFORE INSERT ON project_bundle_refs
    FOR EACH ROW
    EXECUTE FUNCTION enforce_project_bundle_ref_insert();

CREATE OR REPLACE FUNCTION reject_project_bundle_ref_update()
RETURNS trigger
LANGUAGE plpgsql
AS $$
BEGIN
    RAISE EXCEPTION 'Project Bundle reference identity is immutable'
        USING ERRCODE = '23514';
END;
$$;

CREATE TRIGGER project_bundle_refs_immutable
    BEFORE UPDATE ON project_bundle_refs
    FOR EACH ROW
    EXECUTE FUNCTION reject_project_bundle_ref_update();

CREATE OR REPLACE FUNCTION enforce_save_session_update()
RETURNS trigger
LANGUAGE plpgsql
AS $$
DECLARE
    committed_bundle bundles%ROWTYPE;
BEGIN
    IF NEW.id IS DISTINCT FROM OLD.id
        OR NEW.project_id IS DISTINCT FROM OLD.project_id
        OR NEW.storage_scope_id IS DISTINCT FROM OLD.storage_scope_id
        OR NEW.actor_user_id IS DISTINCT FROM OLD.actor_user_id
        OR NEW.expected_project_version IS DISTINCT FROM OLD.expected_project_version
        OR NEW.expected_bundle_sha256 IS DISTINCT FROM OLD.expected_bundle_sha256
        OR NEW.expected_physical_bytes IS DISTINCT FROM OLD.expected_physical_bytes
        OR NEW.expected_logical_bytes IS DISTINCT FROM OLD.expected_logical_bytes
        OR NEW.expected_file_count IS DISTINCT FROM OLD.expected_file_count
        OR NEW.staging_object_key IS DISTINCT FROM OLD.staging_object_key
        OR NEW.upload_mode IS DISTINCT FROM OLD.upload_mode
        OR NEW.created_at IS DISTINCT FROM OLD.created_at
        OR NEW.expires_at IS DISTINCT FROM OLD.expires_at
    THEN
        RAISE EXCEPTION 'Save session identity and expected payload are immutable'
            USING ERRCODE = '23514';
    END IF;

    IF OLD.state IN ('committed', 'aborted', 'expired', 'failed') THEN
        IF OLD.state = 'committed'
            AND OLD.committed_bundle_id IS NOT NULL
            AND NEW.state = OLD.state
            AND NEW.committed_bundle_id IS NULL
            AND NEW.committed_bundle_purged_at IS NOT DISTINCT FROM OLD.committed_bundle_purged_at
            AND NEW.terminal_at IS NOT DISTINCT FROM OLD.terminal_at
            AND NEW.multipart_upload_id IS NOT DISTINCT FROM OLD.multipart_upload_id
            AND EXISTS (
                SELECT 1
                FROM bundles bundle
                JOIN gc_candidates candidate ON candidate.object_key = bundle.object_key
                WHERE bundle.id = OLD.committed_bundle_id
                  AND candidate.status = 'completed'
                  AND candidate.expected_sha256 = bundle.sha256
                  AND candidate.expected_bytes = bundle.physical_bytes
            )
            AND NOT EXISTS (
                SELECT 1 FROM project_bundle_admissions admission
                WHERE admission.bundle_id = OLD.committed_bundle_id
            )
            AND NOT EXISTS (
                SELECT 1 FROM projects project
                WHERE project.working_head_bundle_id = OLD.committed_bundle_id
            )
            AND NOT EXISTS (
                SELECT 1 FROM project_bundle_refs reference
                WHERE reference.bundle_id = OLD.committed_bundle_id
            )
        THEN
            NEW.committed_bundle_purged_at := transaction_timestamp();
            NEW.updated_at := transaction_timestamp();
            RETURN NEW;
        END IF;
        RAISE EXCEPTION 'terminal Save session is immutable'
            USING ERRCODE = '23514';
    END IF;

    IF OLD.expires_at <= transaction_timestamp() AND NEW.state <> 'expired' THEN
        RAISE EXCEPTION 'expired Save session may only become expired'
            USING ERRCODE = '23514';
    END IF;

    IF NEW.updated_at < OLD.updated_at THEN
        RAISE EXCEPTION 'Save session update timestamp cannot move backwards'
            USING ERRCODE = '23514';
    END IF;

    IF NOT (
        NEW.state = OLD.state
        OR (OLD.state = 'created' AND NEW.state IN ('uploading', 'aborted', 'expired', 'failed'))
        OR (OLD.state = 'uploading' AND NEW.state IN ('verifying', 'aborted', 'expired', 'failed'))
        OR (OLD.state = 'verifying' AND NEW.state IN ('committed', 'aborted', 'expired', 'failed'))
    ) THEN
        RAISE EXCEPTION 'invalid Save session state transition'
            USING ERRCODE = '23514';
    END IF;

    IF OLD.multipart_upload_id IS NOT NULL
        AND NEW.multipart_upload_id IS DISTINCT FROM OLD.multipart_upload_id
    THEN
        RAISE EXCEPTION 'multipart upload identity is immutable once assigned'
            USING ERRCODE = '23514';
    END IF;

    IF NEW.multipart_upload_id IS DISTINCT FROM OLD.multipart_upload_id
        AND (NEW.upload_mode <> 'multipart' OR NEW.state NOT IN ('created', 'uploading'))
    THEN
        RAISE EXCEPTION 'multipart upload identity may only be assigned while uploading'
            USING ERRCODE = '23514';
    END IF;

    IF NEW.state IN ('committed', 'aborted', 'expired', 'failed')
        AND NEW.multipart_upload_id IS DISTINCT FROM OLD.multipart_upload_id
    THEN
        RAISE EXCEPTION 'terminal transition cannot change multipart identity'
            USING ERRCODE = '23514';
    END IF;

    IF NEW.state = 'committed' THEN
        SELECT * INTO committed_bundle
        FROM bundles bundle
        WHERE bundle.id = NEW.committed_bundle_id;
        IF NOT FOUND
            OR committed_bundle.sha256 IS DISTINCT FROM NEW.expected_bundle_sha256
            OR committed_bundle.physical_bytes IS DISTINCT FROM NEW.expected_physical_bytes
            OR committed_bundle.logical_bytes IS DISTINCT FROM NEW.expected_logical_bytes
            OR committed_bundle.file_count IS DISTINCT FROM NEW.expected_file_count
            OR committed_bundle.verification_state <> 'verified'
        THEN
            RAISE EXCEPTION 'committed Bundle does not match the verified Save payload'
                USING ERRCODE = '23514';
        END IF;
        PERFORM lock_project_bundle_transition(NEW.project_id, NEW.committed_bundle_id);
        IF EXISTS (
            SELECT 1 FROM gc_candidates candidate
            WHERE candidate.object_key = committed_bundle.object_key
              AND candidate.status IN ('running', 'completed')
        ) THEN
            RAISE EXCEPTION 'committed Bundle object is fenced by GC'
                USING ERRCODE = '23514';
        END IF;
        -- Project admission is inserted after this committed transition and
        -- before Working Head/history mutation in the same transaction.
    END IF;

    RETURN NEW;
END;
$$;

CREATE OR REPLACE FUNCTION enforce_project_bundle_admission_insert()
RETURNS trigger
LANGUAGE plpgsql
AS $$
DECLARE
    candidate_object_key text;
BEGIN
    IF NOT EXISTS (
        SELECT 1
        FROM save_sessions session
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

    SELECT bundle.object_key INTO candidate_object_key
    FROM bundles bundle
    WHERE bundle.id = NEW.bundle_id;
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

CREATE TRIGGER project_bundle_admissions_committed_save
    BEFORE INSERT ON project_bundle_admissions
    FOR EACH ROW
    EXECUTE FUNCTION enforce_project_bundle_admission_insert();

CREATE OR REPLACE FUNCTION reject_project_bundle_admission_update()
RETURNS trigger
LANGUAGE plpgsql
AS $$
BEGIN
    IF OLD.save_session_id IS NOT NULL
        AND NEW.save_session_id IS NULL
        AND NEW.source_save_session_id IS NOT DISTINCT FROM OLD.source_save_session_id
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

CREATE TRIGGER project_bundle_admissions_immutable
    BEFORE UPDATE ON project_bundle_admissions
    FOR EACH ROW
    EXECUTE FUNCTION reject_project_bundle_admission_update();

CREATE OR REPLACE FUNCTION enforce_save_session_insert()
RETURNS trigger
LANGUAGE plpgsql
AS $$
BEGIN
    IF NEW.state <> 'created'
        OR NEW.committed_bundle_id IS NOT NULL
        OR NEW.committed_bundle_purged_at IS NOT NULL
        OR NEW.terminal_at IS NOT NULL
    THEN
        RAISE EXCEPTION 'Save session must begin in created state'
            USING ERRCODE = '23514';
    END IF;

    IF NOT EXISTS (
        SELECT 1
        FROM projects project
        JOIN users actor ON actor.id = NEW.actor_user_id
        WHERE project.id = NEW.project_id
          AND project.storage_scope_id = NEW.storage_scope_id
          AND project.state = 'active'
          AND project.lock_version = NEW.expected_project_version
          AND actor.status = 'active'
    ) THEN
        RAISE EXCEPTION 'Save session Project, actor, or expected version is unavailable'
            USING ERRCODE = '23514';
    END IF;

    PERFORM lock_bundle_object_lifecycle(NEW.staging_object_key);
    IF EXISTS (
        SELECT 1 FROM bundles bundle
        WHERE bundle.object_key = NEW.staging_object_key
    ) OR EXISTS (
        SELECT 1 FROM gc_candidates candidate
        WHERE candidate.object_key = NEW.staging_object_key
          AND candidate.status IN ('running', 'completed')
    ) THEN
        RAISE EXCEPTION 'staging object identity is unavailable'
            USING ERRCODE = '23514';
    END IF;
    RETURN NEW;
END;
$$;

CREATE TRIGGER save_sessions_insert_invariants
    BEFORE INSERT ON save_sessions
    FOR EACH ROW
    EXECUTE FUNCTION enforce_save_session_insert();

CREATE TRIGGER save_sessions_update_invariants
    BEFORE UPDATE ON save_sessions
    FOR EACH ROW
    EXECUTE FUNCTION enforce_save_session_update();

CREATE OR REPLACE FUNCTION release_terminal_save_reservation()
RETURNS trigger
LANGUAGE plpgsql
AS $$
BEGIN
    IF OLD.state IN ('created', 'uploading', 'verifying')
        AND NEW.state IN ('committed', 'aborted', 'expired', 'failed')
    THEN
        DELETE FROM storage_reservations
        WHERE save_session_id = NEW.id;
    END IF;
    RETURN NEW;
END;
$$;

CREATE TRIGGER save_sessions_terminal_reservation_release
    AFTER UPDATE OF state ON save_sessions
    FOR EACH ROW
    EXECUTE FUNCTION release_terminal_save_reservation();

CREATE OR REPLACE FUNCTION enforce_save_session_delete()
RETURNS trigger
LANGUAGE plpgsql
AS $$
BEGIN
    IF OLD.state IN ('created', 'uploading', 'verifying') THEN
        RAISE EXCEPTION 'active Save session cannot be deleted; transition it to a terminal state'
            USING ERRCODE = '23514';
    END IF;
    RETURN OLD;
END;
$$;

CREATE TRIGGER save_sessions_safe_delete
    BEFORE DELETE ON save_sessions
    FOR EACH ROW
    EXECUTE FUNCTION enforce_save_session_delete();

CREATE OR REPLACE FUNCTION enforce_storage_reservation_insert()
RETURNS trigger
LANGUAGE plpgsql
AS $$
DECLARE
    target save_sessions%ROWTYPE;
BEGIN
    SELECT * INTO target
    FROM save_sessions session
    WHERE session.id = NEW.save_session_id
      AND session.storage_scope_id = NEW.storage_scope_id
    FOR KEY SHARE;
    IF NOT FOUND
        OR target.state NOT IN ('created', 'uploading', 'verifying')
        OR target.expires_at <= transaction_timestamp()
        OR NEW.reserved_bytes <> target.expected_physical_bytes
        OR NEW.expires_at <> target.expires_at
    THEN
        RAISE EXCEPTION 'storage reservation does not match an active Save session'
            USING ERRCODE = '23514';
    END IF;
    RETURN NEW;
END;
$$;

CREATE TRIGGER storage_reservations_active_session
    BEFORE INSERT ON storage_reservations
    FOR EACH ROW
    EXECUTE FUNCTION enforce_storage_reservation_insert();

CREATE OR REPLACE FUNCTION reject_storage_reservation_update()
RETURNS trigger
LANGUAGE plpgsql
AS $$
BEGIN
    RAISE EXCEPTION 'storage reservations are immutable'
        USING ERRCODE = '23514';
END;
$$;

CREATE TRIGGER storage_reservations_immutable
    BEFORE UPDATE ON storage_reservations
    FOR EACH ROW
    EXECUTE FUNCTION reject_storage_reservation_update();

CREATE OR REPLACE FUNCTION enforce_storage_reservation_delete()
RETURNS trigger
LANGUAGE plpgsql
AS $$
DECLARE
    parent_state text;
BEGIN
    SELECT session.state INTO parent_state
    FROM save_sessions session
    WHERE session.id = OLD.save_session_id;

    -- A missing parent is only reachable through the FK's ON DELETE CASCADE;
    -- active parent deletion is rejected by save_sessions_safe_delete first.
    IF FOUND AND parent_state IN ('created', 'uploading', 'verifying') THEN
        RAISE EXCEPTION 'active storage reservation is released only by a terminal Save transition'
            USING ERRCODE = '23514';
    END IF;
    RETURN OLD;
END;
$$;

CREATE TRIGGER storage_reservations_safe_delete
    BEFORE DELETE ON storage_reservations
    FOR EACH ROW
    EXECUTE FUNCTION enforce_storage_reservation_delete();

CREATE OR REPLACE FUNCTION enforce_multipart_part_write()
RETURNS trigger
LANGUAGE plpgsql
AS $$
DECLARE
    target save_sessions%ROWTYPE;
BEGIN
    SELECT * INTO target
    FROM save_sessions session
    WHERE session.id = NEW.save_session_id
    FOR KEY SHARE;
    IF NOT FOUND
        OR target.upload_mode <> 'multipart'
        OR target.state NOT IN ('created', 'uploading')
        OR target.expires_at <= transaction_timestamp()
    THEN
        RAISE EXCEPTION 'multipart part requires an active multipart Save session'
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

CREATE TRIGGER multipart_parts_write_invariants
    BEFORE INSERT OR UPDATE ON multipart_parts
    FOR EACH ROW
    EXECUTE FUNCTION enforce_multipart_part_write();

CREATE OR REPLACE FUNCTION enforce_gc_candidate_update()
RETURNS trigger
LANGUAGE plpgsql
AS $$
DECLARE
    bundle_row bundles%ROWTYPE;
BEGIN
    IF NEW.object_key IS DISTINCT FROM OLD.object_key
        OR NEW.expected_sha256 IS DISTINCT FROM OLD.expected_sha256
        OR NEW.expected_bytes IS DISTINCT FROM OLD.expected_bytes
        OR NEW.reason IS DISTINCT FROM OLD.reason
        OR NEW.created_at IS DISTINCT FROM OLD.created_at
    THEN
        RAISE EXCEPTION 'GC candidate object identity is immutable'
            USING ERRCODE = '23514';
    END IF;

    IF OLD.status = 'completed' THEN
        RAISE EXCEPTION 'completed GC candidate is immutable'
            USING ERRCODE = '23514';
    END IF;

    IF NEW.updated_at < OLD.updated_at THEN
        RAISE EXCEPTION 'GC candidate update timestamp cannot move backwards'
            USING ERRCODE = '23514';
    END IF;

    IF NOT (
        NEW.status = OLD.status
        OR (OLD.status IN ('queued', 'retry_wait', 'failed') AND NEW.status = 'running')
        OR (OLD.status = 'running' AND NEW.status IN ('queued', 'retry_wait', 'completed', 'failed'))
    ) THEN
        RAISE EXCEPTION 'invalid GC candidate state transition'
            USING ERRCODE = '23514';
    END IF;

    IF NEW.status = OLD.status AND (
        NEW.attempts IS DISTINCT FROM OLD.attempts
        OR NEW.retry_at IS DISTINCT FROM OLD.retry_at
        OR NEW.started_at IS DISTINCT FROM OLD.started_at
        OR NEW.completed_at IS DISTINCT FROM OLD.completed_at
    ) THEN
        RAISE EXCEPTION 'GC candidate state metadata cannot change without a transition'
            USING ERRCODE = '23514';
    END IF;

    IF NEW.status <> 'running'
        AND NEW.attempts IS DISTINCT FROM OLD.attempts
    THEN
        RAISE EXCEPTION 'GC attempts advance only when entering running state'
            USING ERRCODE = '23514';
    END IF;

    IF OLD.status = 'running'
        AND NEW.eligible_at IS DISTINCT FROM OLD.eligible_at
    THEN
        RAISE EXCEPTION 'running GC eligibility is immutable'
            USING ERRCODE = '23514';
    END IF;

    IF NEW.status = 'running' AND OLD.status <> 'running' THEN
        IF NEW.eligible_at > transaction_timestamp()
            OR (OLD.status = 'retry_wait' AND OLD.retry_at > transaction_timestamp())
            OR NEW.attempts <> OLD.attempts + 1
        THEN
            RAISE EXCEPTION 'GC candidate is not eligible for a bounded attempt'
                USING ERRCODE = '23514';
        END IF;

        PERFORM lock_bundle_object_lifecycle(NEW.object_key);

        SELECT * INTO bundle_row
        FROM bundles bundle
        WHERE bundle.object_key = NEW.object_key;
        IF FOUND AND (
            bundle_row.sha256 IS DISTINCT FROM NEW.expected_sha256
            OR bundle_row.physical_bytes IS DISTINCT FROM NEW.expected_bytes
        ) THEN
            RAISE EXCEPTION 'GC candidate metadata does not match Bundle identity'
                USING ERRCODE = '23514';
        END IF;

        IF EXISTS (
            SELECT 1 FROM projects project
            JOIN bundles bundle ON bundle.id = project.working_head_bundle_id
            WHERE bundle.object_key = NEW.object_key
        ) OR EXISTS (
            SELECT 1 FROM project_bundle_refs reference
            JOIN bundles bundle ON bundle.id = reference.bundle_id
            WHERE bundle.object_key = NEW.object_key
        ) OR EXISTS (
            SELECT 1 FROM save_sessions session
            WHERE session.staging_object_key = NEW.object_key
              AND session.state IN ('created', 'uploading', 'verifying')
        ) THEN
            RAISE EXCEPTION 'GC candidate still has a live or active reference'
                USING ERRCODE = '23514';
        END IF;
    END IF;

    IF NEW.status = 'completed' THEN
        PERFORM lock_bundle_object_lifecycle(NEW.object_key);
        IF EXISTS (
            SELECT 1 FROM projects project
            JOIN bundles bundle ON bundle.id = project.working_head_bundle_id
            WHERE bundle.object_key = NEW.object_key
        ) OR EXISTS (
            SELECT 1 FROM project_bundle_refs reference
            JOIN bundles bundle ON bundle.id = reference.bundle_id
            WHERE bundle.object_key = NEW.object_key
        ) THEN
            RAISE EXCEPTION 'GC completion requires a final live-reference check'
                USING ERRCODE = '23514';
        END IF;
    END IF;
    RETURN NEW;
END;
$$;

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

CREATE TRIGGER gc_candidates_update_invariants
    BEFORE UPDATE ON gc_candidates
    FOR EACH ROW
    EXECUTE FUNCTION enforce_gc_candidate_update();

CREATE TRIGGER gc_candidates_insert_invariants
    BEFORE INSERT ON gc_candidates
    FOR EACH ROW
    EXECUTE FUNCTION enforce_gc_candidate_insert();

CREATE OR REPLACE FUNCTION enforce_gc_candidate_delete()
RETURNS trigger
LANGUAGE plpgsql
AS $$
BEGIN
    IF OLD.status = 'running' THEN
        RAISE EXCEPTION 'running GC candidate cannot be removed'
            USING ERRCODE = '23514';
    END IF;
    IF OLD.status = 'completed' AND (
        EXISTS (
            SELECT 1 FROM bundles bundle
            WHERE bundle.object_key = OLD.object_key
        )
        OR EXISTS (
            SELECT 1 FROM save_sessions session
            WHERE session.staging_object_key = OLD.object_key
        )
    ) THEN
        RAISE EXCEPTION 'completed GC tombstone remains until object metadata is removed'
            USING ERRCODE = '23514';
    END IF;
    RETURN OLD;
END;
$$;

CREATE TRIGGER gc_candidates_safe_delete
    BEFORE DELETE ON gc_candidates
    FOR EACH ROW
    EXECUTE FUNCTION enforce_gc_candidate_delete();

CREATE OR REPLACE FUNCTION enqueue_bundle_gc_candidate(
    candidate_bundle_id uuid,
    candidate_reason text,
    candidate_eligible_at timestamptz
)
RETURNS void
LANGUAGE plpgsql
AS $$
BEGIN
    INSERT INTO gc_candidates (
        object_key,
        expected_sha256,
        expected_bytes,
        reason,
        eligible_at
    )
    SELECT
        bundle.object_key,
        bundle.sha256,
        bundle.physical_bytes,
        candidate_reason,
        candidate_eligible_at
    FROM bundles bundle
    WHERE bundle.id = candidate_bundle_id
    ON CONFLICT (object_key) DO NOTHING;
END;
$$;

CREATE OR REPLACE FUNCTION enqueue_replaced_working_head()
RETURNS trigger
LANGUAGE plpgsql
AS $$
BEGIN
    IF OLD.working_head_bundle_id IS NOT NULL
        AND OLD.working_head_bundle_id IS DISTINCT FROM NEW.working_head_bundle_id
    THEN
        PERFORM enqueue_bundle_gc_candidate(
            OLD.working_head_bundle_id,
            'working_head_replaced',
            transaction_timestamp() + INTERVAL '24 hours'
        );
    END IF;
    RETURN NEW;
END;
$$;

CREATE TRIGGER projects_replaced_head_gc_candidate
    AFTER UPDATE OF working_head_bundle_id ON projects
    FOR EACH ROW
    EXECUTE FUNCTION enqueue_replaced_working_head();

CREATE OR REPLACE FUNCTION enqueue_deleted_project_head()
RETURNS trigger
LANGUAGE plpgsql
AS $$
BEGIN
    IF OLD.working_head_bundle_id IS NOT NULL THEN
        PERFORM enqueue_bundle_gc_candidate(
            OLD.working_head_bundle_id,
            'project_deleted',
            transaction_timestamp() + INTERVAL '24 hours'
        );
    END IF;
    RETURN OLD;
END;
$$;

CREATE TRIGGER projects_deleted_head_gc_candidate
    AFTER DELETE ON projects
    FOR EACH ROW
    EXECUTE FUNCTION enqueue_deleted_project_head();

CREATE OR REPLACE FUNCTION enqueue_deleted_bundle_ref()
RETURNS trigger
LANGUAGE plpgsql
AS $$
BEGIN
    PERFORM enqueue_bundle_gc_candidate(
        OLD.bundle_id,
        'reference_removed',
        transaction_timestamp() + INTERVAL '24 hours'
    );
    RETURN OLD;
END;
$$;

CREATE TRIGGER project_bundle_refs_deleted_gc_candidate
    AFTER DELETE ON project_bundle_refs
    FOR EACH ROW
    EXECUTE FUNCTION enqueue_deleted_bundle_ref();

CREATE OR REPLACE FUNCTION enforce_verified_bundle_insert()
RETURNS trigger
LANGUAGE plpgsql
AS $$
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
    ) THEN
        RAISE EXCEPTION 'verified Bundle requires a matching verifying Save session'
            USING ERRCODE = '23514';
    END IF;
    RETURN NEW;
END;
$$;

CREATE TRIGGER bundles_verified_source
    BEFORE INSERT ON bundles
    FOR EACH ROW
    EXECUTE FUNCTION enforce_verified_bundle_insert();

CREATE OR REPLACE FUNCTION enforce_verified_bundle_delete()
RETURNS trigger
LANGUAGE plpgsql
AS $$
BEGIN
    PERFORM lock_bundle_object_lifecycle(OLD.object_key);
    IF NOT EXISTS (
        SELECT 1 FROM gc_candidates candidate
        WHERE candidate.object_key = OLD.object_key
          AND candidate.expected_sha256 = OLD.sha256
          AND candidate.expected_bytes = OLD.physical_bytes
          AND candidate.status = 'completed'
    ) OR EXISTS (
        SELECT 1 FROM projects project
        WHERE project.working_head_bundle_id = OLD.id
    ) OR EXISTS (
        SELECT 1 FROM project_bundle_refs reference
        WHERE reference.bundle_id = OLD.id
    ) OR EXISTS (
        SELECT 1 FROM project_bundle_admissions admission
        WHERE admission.bundle_id = OLD.id
    ) THEN
        RAISE EXCEPTION 'verified Bundle metadata deletion requires completed safe GC cleanup'
            USING ERRCODE = '23514';
    END IF;
    RETURN OLD;
END;
$$;

CREATE TRIGGER bundles_safe_delete
    BEFORE DELETE ON bundles
    FOR EACH ROW
    EXECUTE FUNCTION enforce_verified_bundle_delete();
