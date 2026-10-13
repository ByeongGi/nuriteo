-- Direct User roles for Organization-owned Projects. Team-derived roles are
-- intentionally deferred; membership alone grants no Project access.

ALTER TABLE projects
    ADD CONSTRAINT projects_organization_identity_unique
        UNIQUE (id, owner_organization_id);

CREATE TABLE project_user_roles (
    project_id uuid NOT NULL,
    organization_id uuid NOT NULL,
    user_id uuid NOT NULL,
    role text NOT NULL,
    created_at timestamptz NOT NULL DEFAULT CURRENT_TIMESTAMP,
    updated_at timestamptz NOT NULL DEFAULT CURRENT_TIMESTAMP,
    lock_version bigint NOT NULL DEFAULT 1,
    PRIMARY KEY (project_id, user_id),
    CONSTRAINT project_user_roles_project_id_v7_check
        CHECK (
            substring(project_id::text FROM 15 FOR 1) = '7'
            AND substring(project_id::text FROM 20 FOR 1) IN ('8', '9', 'a', 'b')
        ),
    CONSTRAINT project_user_roles_organization_id_v7_check
        CHECK (
            substring(organization_id::text FROM 15 FOR 1) = '7'
            AND substring(organization_id::text FROM 20 FOR 1) IN ('8', '9', 'a', 'b')
        ),
    CONSTRAINT project_user_roles_user_id_v7_check
        CHECK (
            substring(user_id::text FROM 15 FOR 1) = '7'
            AND substring(user_id::text FROM 20 FOR 1) IN ('8', '9', 'a', 'b')
        ),
    CONSTRAINT project_user_roles_project_owner_fk
        FOREIGN KEY (project_id, organization_id)
        REFERENCES projects (id, owner_organization_id)
        ON DELETE CASCADE,
    CONSTRAINT project_user_roles_membership_fk
        FOREIGN KEY (organization_id, user_id)
        REFERENCES organization_memberships (organization_id, user_id)
        ON DELETE CASCADE,
    CONSTRAINT project_user_roles_role_check
        CHECK (role IN ('read', 'write', 'admin')),
    CONSTRAINT project_user_roles_timestamps_check
        CHECK (updated_at >= created_at),
    CONSTRAINT project_user_roles_lock_version_check
        CHECK (lock_version BETWEEN 1 AND 9223372036854775806)
);

CREATE INDEX project_user_roles_user_idx
    ON project_user_roles (user_id, project_id);
CREATE INDEX project_user_roles_organization_idx
    ON project_user_roles (organization_id, project_id, user_id);

CREATE OR REPLACE FUNCTION enforce_project_user_role_target()
RETURNS trigger
LANGUAGE plpgsql
AS $$
BEGIN
    IF NOT EXISTS (
        SELECT 1
        FROM projects project
        JOIN organizations organization
          ON organization.id = project.owner_organization_id
        JOIN organization_memberships membership
          ON membership.organization_id = organization.id
         AND membership.user_id = NEW.user_id
        JOIN users member ON member.id = membership.user_id
        WHERE project.id = NEW.project_id
          AND project.owner_organization_id = NEW.organization_id
          AND project.owner_user_id IS NULL
          AND project.state = 'active'
          AND organization.status = 'active'
          AND member.status = 'active'
    ) THEN
        RAISE EXCEPTION 'project role target is unavailable'
            USING ERRCODE = '23514';
    END IF;
    RETURN NEW;
END;
$$;

CREATE TRIGGER project_user_roles_target
    BEFORE INSERT OR UPDATE ON project_user_roles
    FOR EACH ROW
    EXECUTE FUNCTION enforce_project_user_role_target();

CREATE OR REPLACE FUNCTION enforce_project_user_role_update()
RETURNS trigger
LANGUAGE plpgsql
AS $$
BEGIN
    IF NEW.project_id IS DISTINCT FROM OLD.project_id
        OR NEW.organization_id IS DISTINCT FROM OLD.organization_id
        OR NEW.user_id IS DISTINCT FROM OLD.user_id
        OR NEW.created_at IS DISTINCT FROM OLD.created_at
    THEN
        RAISE EXCEPTION 'project role identity fields cannot change'
            USING ERRCODE = '23514';
    END IF;

    IF NEW.lock_version <> OLD.lock_version + 1 THEN
        RAISE EXCEPTION 'project role update must advance lock version exactly once'
            USING ERRCODE = '23514';
    END IF;
    RETURN NEW;
END;
$$;

CREATE TRIGGER project_user_roles_update_invariants
    BEFORE UPDATE ON project_user_roles
    FOR EACH ROW
    EXECUTE FUNCTION enforce_project_user_role_update();
