-- Immutable Published Examples are deliberately separate from editable Projects.
-- A public id is an opaque 256-bit value and remains reserved after deletion.

CREATE TABLE published_examples (
    id uuid PRIMARY KEY,
    public_id text NOT NULL UNIQUE,
    project_id uuid NOT NULL REFERENCES projects (id) ON DELETE CASCADE,
    publisher_user_id uuid NOT NULL REFERENCES users (id) ON DELETE RESTRICT,
    name text NOT NULL,
    visibility text NOT NULL,
    state text NOT NULL DEFAULT 'draft',
    active_version_id uuid,
    generation bigint NOT NULL DEFAULT 0,
    created_at timestamptz NOT NULL DEFAULT CURRENT_TIMESTAMP,
    updated_at timestamptz NOT NULL DEFAULT CURRENT_TIMESTAMP,
    unpublished_at timestamptz,
    CONSTRAINT published_examples_id_v7_check CHECK (
        substring(id::text FROM 15 FOR 1) = '7'
        AND substring(id::text FROM 20 FOR 1) IN ('8', '9', 'a', 'b')
    ),
    CONSTRAINT published_examples_public_id_check CHECK (
        char_length(public_id) = 43 AND public_id ~ '^[A-Za-z0-9_-]{43}$'
    ),
    CONSTRAINT published_examples_name_check CHECK (
        name = btrim(name) AND name !~ '[[:cntrl:]]'
        AND char_length(name) BETWEEN 1 AND 200
    ),
    CONSTRAINT published_examples_visibility_check
        CHECK (visibility IN ('unlisted', 'public')),
    CONSTRAINT published_examples_state_check
        CHECK (state IN ('draft', 'published', 'unpublished')),
    CONSTRAINT published_examples_lifecycle_check CHECK (
        (state = 'draft' AND active_version_id IS NULL AND unpublished_at IS NULL)
        OR (state = 'published' AND active_version_id IS NOT NULL AND unpublished_at IS NULL)
        OR (state = 'unpublished' AND active_version_id IS NOT NULL AND unpublished_at IS NOT NULL)
    ),
    CONSTRAINT published_examples_generation_check
        CHECK (generation BETWEEN 0 AND 9223372036854775806),
    CONSTRAINT published_examples_timestamps_check CHECK (
        updated_at >= created_at
        AND (unpublished_at IS NULL OR unpublished_at >= created_at)
        AND (unpublished_at IS NULL OR updated_at >= unpublished_at)
    ),
    CONSTRAINT published_examples_example_project_unique UNIQUE (id, project_id)
);

ALTER TABLE project_bundle_refs
    ADD CONSTRAINT project_bundle_refs_id_project_unique UNIQUE (id, project_id);

CREATE TABLE published_example_versions (
    id uuid PRIMARY KEY,
    example_id uuid NOT NULL,
    project_id uuid NOT NULL,
    project_version_id uuid NOT NULL,
    version_number bigint NOT NULL,
    created_by_user_id uuid NOT NULL REFERENCES users (id) ON DELETE RESTRICT,
    created_at timestamptz NOT NULL DEFAULT CURRENT_TIMESTAMP,
    CONSTRAINT published_example_versions_id_v7_check CHECK (
        substring(id::text FROM 15 FOR 1) = '7'
        AND substring(id::text FROM 20 FOR 1) IN ('8', '9', 'a', 'b')
    ),
    CONSTRAINT published_example_versions_example_project_fk
        FOREIGN KEY (example_id, project_id)
        REFERENCES published_examples (id, project_id) ON DELETE CASCADE,
    CONSTRAINT published_example_versions_project_version_fk
        FOREIGN KEY (project_version_id, project_id)
        REFERENCES project_bundle_refs (id, project_id) ON DELETE CASCADE,
    CONSTRAINT published_example_versions_number_check
        CHECK (version_number BETWEEN 1 AND 9223372036854775806),
    CONSTRAINT published_example_versions_example_number_unique
        UNIQUE (example_id, version_number),
    CONSTRAINT published_example_versions_example_id_unique
        UNIQUE (example_id, id)
);

ALTER TABLE published_examples
    ADD CONSTRAINT published_examples_active_version_fk
    FOREIGN KEY (id, active_version_id)
    REFERENCES published_example_versions (example_id, id)
    DEFERRABLE INITIALLY DEFERRED;

CREATE TABLE published_example_tombstones (
    former_example_id uuid PRIMARY KEY,
    public_id text NOT NULL UNIQUE,
    deleted_at timestamptz NOT NULL DEFAULT CURRENT_TIMESTAMP,
    CONSTRAINT published_example_tombstones_id_v7_check CHECK (
        substring(former_example_id::text FROM 15 FOR 1) = '7'
        AND substring(former_example_id::text FROM 20 FOR 1) IN ('8', '9', 'a', 'b')
    ),
    CONSTRAINT published_example_tombstones_public_id_check CHECK (
        char_length(public_id) = 43 AND public_id ~ '^[A-Za-z0-9_-]{43}$'
    )
);

CREATE INDEX published_examples_project_idx
    ON published_examples (project_id, created_at DESC, id DESC);
CREATE INDEX published_examples_public_catalog_idx
    ON published_examples (created_at DESC, id DESC)
    WHERE state = 'published' AND visibility = 'public';
CREATE INDEX published_example_versions_project_version_idx
    ON published_example_versions (project_id, project_version_id);

CREATE FUNCTION enforce_published_example_public_id_available()
RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
    PERFORM pg_advisory_xact_lock(1886741357, hashtext(NEW.public_id));
    IF EXISTS (
        SELECT 1 FROM published_example_tombstones
        WHERE public_id = NEW.public_id
    ) THEN
        RAISE EXCEPTION 'published example public id is permanently reserved'
            USING ERRCODE = '23505';
    END IF;
    RETURN NEW;
END;
$$;

CREATE TRIGGER published_examples_public_id_reservation
    BEFORE INSERT ON published_examples
    FOR EACH ROW EXECUTE FUNCTION enforce_published_example_public_id_available();

CREATE FUNCTION enforce_published_example_update()
RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
    IF NEW.id IS DISTINCT FROM OLD.id
        OR NEW.public_id IS DISTINCT FROM OLD.public_id
        OR NEW.project_id IS DISTINCT FROM OLD.project_id
        OR NEW.publisher_user_id IS DISTINCT FROM OLD.publisher_user_id
        OR NEW.name IS DISTINCT FROM OLD.name
        OR NEW.created_at IS DISTINCT FROM OLD.created_at
    THEN
        RAISE EXCEPTION 'published example immutable fields cannot change'
            USING ERRCODE = '23514';
    END IF;
    IF NEW.generation <> OLD.generation + 1 OR NEW.updated_at < OLD.updated_at THEN
        RAISE EXCEPTION 'published example update must advance generation exactly once'
            USING ERRCODE = '23514';
    END IF;
    RETURN NEW;
END;
$$;

CREATE TRIGGER published_examples_update_guard
    BEFORE UPDATE ON published_examples
    FOR EACH ROW EXECUTE FUNCTION enforce_published_example_update();

CREATE FUNCTION tombstone_published_example()
RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
    INSERT INTO published_example_tombstones (former_example_id, public_id, deleted_at)
    VALUES (OLD.id, OLD.public_id, transaction_timestamp());
    PERFORM set_config('nuriteo.published_example_delete_id', OLD.id::text, true);
    RETURN OLD;
END;
$$;

CREATE TRIGGER published_examples_tombstone
    BEFORE DELETE ON published_examples
    FOR EACH ROW EXECUTE FUNCTION tombstone_published_example();

CREATE FUNCTION enforce_published_example_version_immutable()
RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
    IF TG_OP = 'DELETE'
       AND (
           current_setting('nuriteo.published_example_delete_id', true) = OLD.example_id::text
           OR (
               pg_trigger_depth() > 1
               AND NOT EXISTS (SELECT 1 FROM projects WHERE id = OLD.project_id)
           )
       )
    THEN
        RETURN OLD;
    END IF;
    RAISE EXCEPTION 'published example versions are immutable'
        USING ERRCODE = '23514';
END;
$$;

CREATE TRIGGER published_example_versions_immutable
    BEFORE UPDATE OR DELETE ON published_example_versions
    FOR EACH ROW EXECUTE FUNCTION enforce_published_example_version_immutable();

CREATE TRIGGER published_examples_no_truncate
    BEFORE TRUNCATE ON published_examples
    FOR EACH STATEMENT EXECUTE FUNCTION reject_bundle_persistence_truncate();
CREATE TRIGGER published_example_versions_no_truncate
    BEFORE TRUNCATE ON published_example_versions
    FOR EACH STATEMENT EXECUTE FUNCTION reject_bundle_persistence_truncate();
CREATE TRIGGER published_example_tombstones_no_truncate
    BEFORE TRUNCATE ON published_example_tombstones
    FOR EACH STATEMENT EXECUTE FUNCTION reject_bundle_persistence_truncate();
