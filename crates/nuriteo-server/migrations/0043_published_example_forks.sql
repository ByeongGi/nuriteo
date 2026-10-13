-- A Published Example fork resolves one already-verified immutable source
-- Bundle, but re-materializes it with the destination Project/scope identity.
-- No browser download/re-upload or source ACL/integration copy is involved.

CREATE TABLE published_example_forks (
    id uuid PRIMARY KEY,
    actor_user_id uuid NOT NULL REFERENCES users (id) ON DELETE RESTRICT,
    idempotency_digest bytea NOT NULL,
    source_public_id text NOT NULL,
    source_example_id uuid NOT NULL,
    source_example_version_id uuid NOT NULL,
    source_version_number bigint NOT NULL,
    requested_version_number bigint,
    source_bundle_id uuid NOT NULL,
    destination_bundle_id uuid NOT NULL UNIQUE,
    destination_project_id uuid NOT NULL UNIQUE,
    destination_owner_user_id uuid,
    destination_owner_organization_id uuid,
    destination_storage_scope_id uuid NOT NULL,
    destination_slug text NOT NULL,
    destination_name text NOT NULL,
    created_at timestamptz NOT NULL DEFAULT CURRENT_TIMESTAMP,
    CONSTRAINT published_example_forks_id_v7_check CHECK (
        substring(id::text FROM 15 FOR 1) = '7'
        AND substring(id::text FROM 20 FOR 1) IN ('8', '9', 'a', 'b')
    ),
    CONSTRAINT published_example_forks_idempotency_digest_check
        CHECK (octet_length(idempotency_digest) = 32),
    CONSTRAINT published_example_forks_public_id_check CHECK (
        char_length(source_public_id) = 43 AND source_public_id ~ '^[A-Za-z0-9_-]{43}$'
    ),
    CONSTRAINT published_example_forks_version_number_check CHECK (
        source_version_number BETWEEN 1 AND 9223372036854775806
        AND (
            requested_version_number IS NULL
            OR requested_version_number BETWEEN 1 AND 9223372036854775806
        )
    ),
    CONSTRAINT published_example_forks_exactly_one_owner_check
        CHECK (num_nonnulls(destination_owner_user_id, destination_owner_organization_id) = 1),
    CONSTRAINT published_example_forks_user_scope_fk
        FOREIGN KEY (destination_storage_scope_id, destination_owner_user_id)
        REFERENCES storage_scopes (id, owner_user_id) ON DELETE RESTRICT,
    CONSTRAINT published_example_forks_organization_scope_fk
        FOREIGN KEY (destination_storage_scope_id, destination_owner_organization_id)
        REFERENCES storage_scopes (id, owner_organization_id) ON DELETE RESTRICT,
    CONSTRAINT published_example_forks_slug_check CHECK (
        char_length(destination_slug) BETWEEN 1 AND 63
        AND destination_slug ~ '^[a-z0-9]([a-z0-9-]*[a-z0-9])?$'
    ),
    CONSTRAINT published_example_forks_name_check CHECK (
        destination_name = btrim(destination_name)
        AND destination_name !~ '[[:cntrl:]]'
        AND char_length(destination_name) BETWEEN 1 AND 200
    ),
    CONSTRAINT published_example_forks_actor_key_unique
        UNIQUE (actor_user_id, idempotency_digest)
);

COMMENT ON COLUMN published_example_forks.destination_project_id IS
    'Snapshot identity without FK: deleting the result does not erase idempotency history or permit duplicate replay.';
COMMENT ON COLUMN published_example_forks.destination_bundle_id IS
    'Snapshot identity without FK: the live admission/head own retention; deletion may later reclaim the Bundle while the idempotency result remains unavailable.';

-- The source identifiers intentionally have no enduring FK to the Published
-- Example. Delete/unpublish of the source must not invalidate an existing
-- fork or prevent deletion of the source Project. The insertion guard below
-- validates and locks the exact immutable source version at creation time.
CREATE FUNCTION enforce_published_example_fork_insert()
RETURNS trigger LANGUAGE plpgsql AS $$
DECLARE
    source_bundle uuid;
    destination_verified boolean;
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

    SELECT EXISTS (
        SELECT 1 FROM bundles bundle
        WHERE bundle.id = NEW.destination_bundle_id
          AND bundle.verification_state = 'verified'
          AND bundle.format = 'project-bundle-v1'
    ) INTO destination_verified;

    IF source_bundle IS NULL OR source_bundle <> NEW.source_bundle_id THEN
        RAISE EXCEPTION 'Published Example fork requires one published immutable version'
            USING ERRCODE = '23514';
    END IF;
    IF NOT destination_verified OR NEW.destination_bundle_id = NEW.source_bundle_id THEN
        RAISE EXCEPTION 'Published Example fork requires one destination-specific verified Bundle'
            USING ERRCODE = '23514';
    END IF;
    RETURN NEW;
END;
$$;

CREATE TRIGGER published_example_forks_source_guard
    BEFORE INSERT ON published_example_forks
    FOR EACH ROW EXECUTE FUNCTION enforce_published_example_fork_insert();

ALTER TABLE project_bundle_admissions
    ALTER COLUMN source_save_session_id DROP NOT NULL,
    ADD COLUMN source_published_example_fork_id uuid UNIQUE,
    ADD CONSTRAINT project_bundle_admissions_fork_source_fk
        FOREIGN KEY (source_published_example_fork_id)
        REFERENCES published_example_forks (id) ON DELETE RESTRICT;

ALTER TABLE project_bundle_admissions
    DROP CONSTRAINT project_bundle_admissions_save_provenance_check,
    ADD CONSTRAINT project_bundle_admissions_provenance_check CHECK (
        (
            source_save_session_id IS NOT NULL
            AND source_published_example_fork_id IS NULL
            AND (save_session_id IS NULL OR save_session_id = source_save_session_id)
        )
        OR (
            source_save_session_id IS NULL
            AND save_session_id IS NULL
            AND source_published_example_fork_id IS NOT NULL
        )
    );

CREATE OR REPLACE FUNCTION enforce_project_bundle_admission_insert()
RETURNS trigger LANGUAGE plpgsql AS $$
DECLARE
    candidate_object_key text;
BEGIN
    IF NEW.source_published_example_fork_id IS NULL THEN
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
    ELSIF NOT EXISTS (
        SELECT 1
        FROM published_example_forks fork
        WHERE fork.id = NEW.source_published_example_fork_id
          AND fork.destination_project_id = NEW.project_id
          AND fork.destination_storage_scope_id = NEW.storage_scope_id
          AND fork.destination_bundle_id = NEW.bundle_id
    ) THEN
        RAISE EXCEPTION 'Project Bundle admission requires its Published Example fork operation'
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

CREATE OR REPLACE FUNCTION reject_project_bundle_admission_update()
RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
    IF OLD.source_save_session_id IS NOT NULL
        AND OLD.save_session_id IS NOT NULL
        AND NEW.save_session_id IS NULL
        AND NEW.source_save_session_id IS NOT DISTINCT FROM OLD.source_save_session_id
        AND NEW.source_published_example_fork_id IS NOT DISTINCT FROM OLD.source_published_example_fork_id
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

CREATE TRIGGER published_example_forks_no_truncate
    BEFORE TRUNCATE ON published_example_forks
    FOR EACH STATEMENT EXECUTE FUNCTION reject_bundle_persistence_truncate();
