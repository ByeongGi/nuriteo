-- Close the Project deletion gap left by migration 0010. Every deletion now
-- creates or validates the matching immutable tombstone while the same
-- owner/slug advisory namespace is held.

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
    RETURN NEW;
END;
$$;

CREATE OR REPLACE FUNCTION ensure_project_delete_tombstone()
RETURNS trigger
LANGUAGE plpgsql
AS $$
DECLARE
    existing_tombstone project_tombstones%ROWTYPE;
BEGIN
    PERFORM lock_project_slug_namespace(
        OLD.owner_user_id,
        OLD.owner_organization_id,
        OLD.slug
    );

    SELECT *
    INTO existing_tombstone
    FROM project_tombstones
    WHERE former_project_id = OLD.id;

    IF FOUND THEN
        IF existing_tombstone.owner_user_id IS DISTINCT FROM OLD.owner_user_id
            OR existing_tombstone.owner_organization_id IS DISTINCT FROM OLD.owner_organization_id
            OR existing_tombstone.slug IS DISTINCT FROM OLD.slug
        THEN
            RAISE EXCEPTION 'project tombstone does not match the deleted project'
                USING ERRCODE = '23514';
        END IF;
    ELSE
        INSERT INTO project_tombstones (
            former_project_id,
            owner_user_id,
            owner_organization_id,
            slug
        ) VALUES (
            OLD.id,
            OLD.owner_user_id,
            OLD.owner_organization_id,
            OLD.slug
        );
    END IF;

    RETURN OLD;
END;
$$;

CREATE TRIGGER projects_require_delete_tombstone
    BEFORE DELETE ON projects
    FOR EACH ROW
    EXECUTE FUNCTION ensure_project_delete_tombstone();

CREATE OR REPLACE FUNCTION reject_project_truncate()
RETURNS trigger
LANGUAGE plpgsql
AS $$
BEGIN
    RAISE EXCEPTION 'projects cannot be truncated'
        USING ERRCODE = '23514';
END;
$$;

CREATE TRIGGER projects_no_truncate
    BEFORE TRUNCATE ON projects
    FOR EACH STATEMENT
    EXECUTE FUNCTION reject_project_truncate();

CREATE OR REPLACE FUNCTION reject_project_tombstone_delete()
RETURNS trigger
LANGUAGE plpgsql
AS $$
BEGIN
    RAISE EXCEPTION 'project tombstones cannot be deleted'
        USING ERRCODE = '23514';
END;
$$;

CREATE TRIGGER project_tombstones_no_delete
    BEFORE DELETE ON project_tombstones
    FOR EACH ROW
    EXECUTE FUNCTION reject_project_tombstone_delete();

CREATE TRIGGER project_tombstones_no_truncate
    BEFORE TRUNCATE ON project_tombstones
    FOR EACH STATEMENT
    EXECUTE FUNCTION reject_project_tombstone_delete();
