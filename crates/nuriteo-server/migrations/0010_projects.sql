-- User- or Organization-owned Project metadata. Source Bundles and the
-- working-head pointer are introduced by SAVE-001 once their target table can
-- be protected by a real foreign key.

ALTER TABLE storage_scopes
    ADD CONSTRAINT storage_scopes_user_owner_identity_unique
        UNIQUE (id, owner_user_id),
    ADD CONSTRAINT storage_scopes_organization_owner_identity_unique
        UNIQUE (id, owner_organization_id);

CREATE TABLE projects (
    id uuid PRIMARY KEY,
    owner_user_id uuid,
    owner_organization_id uuid,
    storage_scope_id uuid NOT NULL,
    slug text NOT NULL,
    name text NOT NULL,
    state text NOT NULL DEFAULT 'active',
    created_at timestamptz NOT NULL DEFAULT CURRENT_TIMESTAMP,
    updated_at timestamptz NOT NULL DEFAULT CURRENT_TIMESTAMP,
    archived_at timestamptz,
    lock_version bigint NOT NULL DEFAULT 1,
    CONSTRAINT projects_id_v7_check
        CHECK (
            substring(id::text FROM 15 FOR 1) = '7'
            AND substring(id::text FROM 20 FOR 1) IN ('8', '9', 'a', 'b')
        ),
    CONSTRAINT projects_exactly_one_owner_check
        CHECK (num_nonnulls(owner_user_id, owner_organization_id) = 1),
    CONSTRAINT projects_user_scope_fk
        FOREIGN KEY (storage_scope_id, owner_user_id)
        REFERENCES storage_scopes (id, owner_user_id)
        ON DELETE RESTRICT,
    CONSTRAINT projects_organization_scope_fk
        FOREIGN KEY (storage_scope_id, owner_organization_id)
        REFERENCES storage_scopes (id, owner_organization_id)
        ON DELETE RESTRICT,
    CONSTRAINT projects_slug_check
        CHECK (
            char_length(slug) BETWEEN 1 AND 63
            AND slug ~ '^[a-z0-9]([a-z0-9-]*[a-z0-9])?$'
        ),
    CONSTRAINT projects_name_check
        CHECK (
            name = btrim(name)
            AND name !~ '[[:cntrl:]]'
            AND char_length(name) BETWEEN 1 AND 200
        ),
    CONSTRAINT projects_state_check
        CHECK (state IN ('active', 'archived')),
    CONSTRAINT projects_lifecycle_check
        CHECK (
            (state = 'active' AND archived_at IS NULL)
            OR (state = 'archived' AND archived_at IS NOT NULL)
        ),
    CONSTRAINT projects_timestamps_check
        CHECK (
            updated_at >= created_at
            AND (archived_at IS NULL OR archived_at >= created_at)
            AND (archived_at IS NULL OR updated_at >= archived_at)
        ),
    CONSTRAINT projects_lock_version_check
        CHECK (lock_version BETWEEN 1 AND 9223372036854775806),
    CONSTRAINT projects_user_slug_unique UNIQUE (owner_user_id, slug),
    CONSTRAINT projects_organization_slug_unique UNIQUE (owner_organization_id, slug)
);

CREATE INDEX projects_user_state_idx
    ON projects (owner_user_id, state, slug, id)
    WHERE owner_user_id IS NOT NULL;
CREATE INDEX projects_organization_state_idx
    ON projects (owner_organization_id, state, slug, id)
    WHERE owner_organization_id IS NOT NULL;

CREATE TABLE project_tombstones (
    former_project_id uuid PRIMARY KEY,
    owner_user_id uuid,
    owner_organization_id uuid,
    slug text NOT NULL,
    deleted_at timestamptz NOT NULL DEFAULT CURRENT_TIMESTAMP,
    CONSTRAINT project_tombstones_id_v7_check
        CHECK (
            substring(former_project_id::text FROM 15 FOR 1) = '7'
            AND substring(former_project_id::text FROM 20 FOR 1) IN ('8', '9', 'a', 'b')
        ),
    CONSTRAINT project_tombstones_exactly_one_owner_check
        CHECK (num_nonnulls(owner_user_id, owner_organization_id) = 1),
    CONSTRAINT project_tombstones_owner_user_fk
        FOREIGN KEY (owner_user_id) REFERENCES users (id) ON DELETE RESTRICT,
    CONSTRAINT project_tombstones_owner_organization_fk
        FOREIGN KEY (owner_organization_id) REFERENCES organizations (id) ON DELETE RESTRICT,
    CONSTRAINT project_tombstones_slug_check
        CHECK (
            char_length(slug) BETWEEN 1 AND 63
            AND slug ~ '^[a-z0-9]([a-z0-9-]*[a-z0-9])?$'
        ),
    CONSTRAINT project_tombstones_user_slug_unique UNIQUE (owner_user_id, slug),
    CONSTRAINT project_tombstones_organization_slug_unique
        UNIQUE (owner_organization_id, slug)
);

CREATE OR REPLACE FUNCTION lock_project_slug_namespace(
    candidate_owner_user_id uuid,
    candidate_owner_organization_id uuid,
    candidate_slug text
)
RETURNS void
LANGUAGE plpgsql
AS $$
BEGIN
    PERFORM pg_advisory_xact_lock(
        1347566129,
        hashtext(
            CASE
                WHEN candidate_owner_user_id IS NOT NULL
                    THEN 'user:' || candidate_owner_user_id::text
                ELSE 'organization:' || candidate_owner_organization_id::text
            END || ':project:' || candidate_slug
        )
    );
END;
$$;

CREATE OR REPLACE FUNCTION enforce_project_slug_available()
RETURNS trigger
LANGUAGE plpgsql
AS $$
BEGIN
    PERFORM lock_project_slug_namespace(
        NEW.owner_user_id,
        NEW.owner_organization_id,
        NEW.slug
    );

    IF EXISTS (
        SELECT 1
        FROM project_tombstones tombstone
        WHERE tombstone.owner_user_id IS NOT DISTINCT FROM NEW.owner_user_id
          AND tombstone.owner_organization_id IS NOT DISTINCT FROM NEW.owner_organization_id
          AND tombstone.slug = NEW.slug
    ) THEN
        RAISE EXCEPTION 'project slug is permanently reserved'
            USING ERRCODE = '23505';
    END IF;
    RETURN NEW;
END;
$$;

CREATE TRIGGER projects_slug_reservation
    BEFORE INSERT OR UPDATE OF owner_user_id, owner_organization_id, slug
    ON projects
    FOR EACH ROW
    EXECUTE FUNCTION enforce_project_slug_available();

CREATE OR REPLACE FUNCTION enforce_project_update()
RETURNS trigger
LANGUAGE plpgsql
AS $$
BEGIN
    IF NEW.id IS DISTINCT FROM OLD.id
        OR NEW.created_at IS DISTINCT FROM OLD.created_at
    THEN
        RAISE EXCEPTION 'project immutable fields cannot change'
            USING ERRCODE = '23514';
    END IF;

    IF NEW.lock_version <> OLD.lock_version + 1 THEN
        RAISE EXCEPTION 'project update must advance lock version exactly once'
            USING ERRCODE = '23514';
    END IF;
    RETURN NEW;
END;
$$;

CREATE TRIGGER projects_update_invariants
    BEFORE UPDATE ON projects
    FOR EACH ROW
    EXECUTE FUNCTION enforce_project_update();

CREATE OR REPLACE FUNCTION lock_project_tombstone_slug()
RETURNS trigger
LANGUAGE plpgsql
AS $$
BEGIN
    PERFORM lock_project_slug_namespace(
        NEW.owner_user_id,
        NEW.owner_organization_id,
        NEW.slug
    );
    RETURN NEW;
END;
$$;

CREATE TRIGGER project_tombstones_slug_reservation
    BEFORE INSERT ON project_tombstones
    FOR EACH ROW
    EXECUTE FUNCTION lock_project_tombstone_slug();

CREATE OR REPLACE FUNCTION enforce_project_tombstone_has_no_live_project()
RETURNS trigger
LANGUAGE plpgsql
AS $$
BEGIN
    IF EXISTS (
        SELECT 1
        FROM projects project
        WHERE project.owner_user_id IS NOT DISTINCT FROM NEW.owner_user_id
          AND project.owner_organization_id IS NOT DISTINCT FROM NEW.owner_organization_id
          AND project.slug = NEW.slug
    ) THEN
        RAISE EXCEPTION 'project tombstone conflicts with a live project'
            USING ERRCODE = '23505';
    END IF;
    RETURN NEW;
END;
$$;

CREATE CONSTRAINT TRIGGER project_tombstones_no_live_project
    AFTER INSERT ON project_tombstones
    DEFERRABLE INITIALLY DEFERRED
    FOR EACH ROW
    EXECUTE FUNCTION enforce_project_tombstone_has_no_live_project();

CREATE OR REPLACE FUNCTION reject_project_tombstone_update()
RETURNS trigger
LANGUAGE plpgsql
AS $$
BEGIN
    RAISE EXCEPTION 'project tombstones are immutable'
        USING ERRCODE = '23514';
END;
$$;

CREATE TRIGGER project_tombstones_immutable
    BEFORE UPDATE ON project_tombstones
    FOR EACH ROW
    EXECUTE FUNCTION reject_project_tombstone_update();
