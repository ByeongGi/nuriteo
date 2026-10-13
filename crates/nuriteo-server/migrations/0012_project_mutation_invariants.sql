-- Pre-release tightening for the Project schema. Migrations 0010 through 0012
-- ship together in the first supported schema; this migration is not a repair
-- path for a previously supported version 10 installation.

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

    IF NEW.owner_user_id IS DISTINCT FROM OLD.owner_user_id
        OR NEW.owner_organization_id IS DISTINCT FROM OLD.owner_organization_id
        OR NEW.storage_scope_id IS DISTINCT FROM OLD.storage_scope_id
        OR NEW.slug IS DISTINCT FROM OLD.slug
    THEN
        RAISE EXCEPTION 'project owner, scope, and slug require managed lifecycle mutation'
            USING ERRCODE = '23514';
    END IF;

    IF NEW.lock_version <> OLD.lock_version + 1 THEN
        RAISE EXCEPTION 'project update must advance lock version exactly once'
            USING ERRCODE = '23514';
    END IF;
    RETURN NEW;
END;
$$;

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

    IF NOT EXISTS (
        SELECT 1
        FROM projects project
        WHERE project.id = NEW.former_project_id
          AND project.owner_user_id IS NOT DISTINCT FROM NEW.owner_user_id
          AND project.owner_organization_id IS NOT DISTINCT FROM NEW.owner_organization_id
          AND project.slug = NEW.slug
    ) THEN
        RAISE EXCEPTION 'project tombstone must match the live project identity'
            USING ERRCODE = '23514';
    END IF;

    NEW.deleted_at := transaction_timestamp();
    RETURN NEW;
END;
$$;
