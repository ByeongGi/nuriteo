-- Organization-scoped, non-nested Teams. Teams group existing Organization
-- members and grant access to Organization-owned Projects; they never own a
-- Project themselves.

CREATE TABLE teams (
    id uuid PRIMARY KEY,
    organization_id uuid NOT NULL,
    slug text NOT NULL,
    display_name text NOT NULL,
    created_at timestamptz NOT NULL DEFAULT CURRENT_TIMESTAMP,
    updated_at timestamptz NOT NULL DEFAULT CURRENT_TIMESTAMP,
    lock_version bigint NOT NULL DEFAULT 1,
    CONSTRAINT teams_id_v7_check
        CHECK (
            substring(id::text FROM 15 FOR 1) = '7'
            AND substring(id::text FROM 20 FOR 1) IN ('8', '9', 'a', 'b')
        ),
    CONSTRAINT teams_organization_fk
        FOREIGN KEY (organization_id) REFERENCES organizations (id) ON DELETE RESTRICT,
    CONSTRAINT teams_slug_check
        CHECK (
            char_length(slug) BETWEEN 1 AND 63
            AND slug ~ '^[a-z0-9]([a-z0-9-]*[a-z0-9])?$'
        ),
    CONSTRAINT teams_display_name_check
        CHECK (
            display_name = btrim(display_name)
            AND display_name !~ '[[:cntrl:]]'
            AND char_length(display_name) BETWEEN 1 AND 200
        ),
    CONSTRAINT teams_timestamps_check
        CHECK (updated_at >= created_at),
    CONSTRAINT teams_lock_version_check
        CHECK (lock_version BETWEEN 1 AND 9223372036854775806),
    CONSTRAINT teams_organization_slug_unique UNIQUE (organization_id, slug),
    CONSTRAINT teams_organization_identity_unique UNIQUE (id, organization_id)
);

CREATE INDEX teams_organization_idx
    ON teams (organization_id, slug, id);

CREATE OR REPLACE FUNCTION enforce_team_target()
RETURNS trigger
LANGUAGE plpgsql
AS $$
BEGIN
    IF NOT EXISTS (
        SELECT 1
        FROM organizations organization
        WHERE organization.id = NEW.organization_id
          AND organization.status = 'active'
    ) THEN
        RAISE EXCEPTION 'team organization is unavailable'
            USING ERRCODE = '23514',
                  CONSTRAINT = 'teams_active_organization';
    END IF;
    RETURN NEW;
END;
$$;

CREATE TRIGGER teams_target
    BEFORE INSERT OR UPDATE ON teams
    FOR EACH ROW
    EXECUTE FUNCTION enforce_team_target();

CREATE OR REPLACE FUNCTION enforce_team_update()
RETURNS trigger
LANGUAGE plpgsql
AS $$
BEGIN
    IF NEW.id IS DISTINCT FROM OLD.id
        OR NEW.organization_id IS DISTINCT FROM OLD.organization_id
        OR NEW.slug IS DISTINCT FROM OLD.slug
        OR NEW.created_at IS DISTINCT FROM OLD.created_at
    THEN
        RAISE EXCEPTION 'team identity fields cannot change'
            USING ERRCODE = '23514';
    END IF;

    IF NEW.lock_version <> OLD.lock_version + 1 THEN
        RAISE EXCEPTION 'team update must advance lock version exactly once'
            USING ERRCODE = '23514';
    END IF;
    RETURN NEW;
END;
$$;

CREATE TRIGGER teams_update_invariants
    BEFORE UPDATE ON teams
    FOR EACH ROW
    EXECUTE FUNCTION enforce_team_update();

CREATE TABLE team_memberships (
    team_id uuid NOT NULL,
    organization_id uuid NOT NULL,
    user_id uuid NOT NULL,
    role text NOT NULL,
    created_at timestamptz NOT NULL DEFAULT CURRENT_TIMESTAMP,
    updated_at timestamptz NOT NULL DEFAULT CURRENT_TIMESTAMP,
    lock_version bigint NOT NULL DEFAULT 1,
    PRIMARY KEY (team_id, user_id),
    CONSTRAINT team_memberships_team_fk
        FOREIGN KEY (team_id, organization_id)
        REFERENCES teams (id, organization_id)
        ON DELETE CASCADE,
    CONSTRAINT team_memberships_organization_membership_fk
        FOREIGN KEY (organization_id, user_id)
        REFERENCES organization_memberships (organization_id, user_id)
        ON DELETE CASCADE,
    CONSTRAINT team_memberships_role_check
        CHECK (role IN ('maintainer', 'member')),
    CONSTRAINT team_memberships_timestamps_check
        CHECK (updated_at >= created_at),
    CONSTRAINT team_memberships_lock_version_check
        CHECK (lock_version BETWEEN 1 AND 9223372036854775806)
);

CREATE INDEX team_memberships_user_idx
    ON team_memberships (user_id, organization_id, team_id);
CREATE INDEX team_memberships_organization_idx
    ON team_memberships (organization_id, team_id, user_id);
CREATE INDEX team_memberships_maintainer_idx
    ON team_memberships (team_id, user_id)
    WHERE role = 'maintainer';

CREATE OR REPLACE FUNCTION enforce_team_membership_target()
RETURNS trigger
LANGUAGE plpgsql
AS $$
BEGIN
    IF NOT EXISTS (
        SELECT 1
        FROM teams team
        JOIN organizations organization
          ON organization.id = team.organization_id
        JOIN organization_memberships membership
          ON membership.organization_id = team.organization_id
         AND membership.user_id = NEW.user_id
        JOIN users member
          ON member.id = membership.user_id
        WHERE team.id = NEW.team_id
          AND team.organization_id = NEW.organization_id
          AND organization.status = 'active'
          AND member.status = 'active'
    ) THEN
        RAISE EXCEPTION 'team membership target is unavailable'
            USING ERRCODE = '23514',
                  CONSTRAINT = 'team_memberships_active_target';
    END IF;
    RETURN NEW;
END;
$$;

CREATE TRIGGER team_memberships_target
    BEFORE INSERT OR UPDATE ON team_memberships
    FOR EACH ROW
    EXECUTE FUNCTION enforce_team_membership_target();

CREATE OR REPLACE FUNCTION enforce_team_membership_update()
RETURNS trigger
LANGUAGE plpgsql
AS $$
BEGIN
    IF NEW.team_id IS DISTINCT FROM OLD.team_id
        OR NEW.organization_id IS DISTINCT FROM OLD.organization_id
        OR NEW.user_id IS DISTINCT FROM OLD.user_id
        OR NEW.created_at IS DISTINCT FROM OLD.created_at
    THEN
        RAISE EXCEPTION 'team membership identity fields cannot change'
            USING ERRCODE = '23514';
    END IF;

    IF NEW.lock_version <> OLD.lock_version + 1 THEN
        RAISE EXCEPTION 'team membership update must advance lock version exactly once'
            USING ERRCODE = '23514';
    END IF;
    RETURN NEW;
END;
$$;

CREATE TRIGGER team_memberships_update_invariants
    BEFORE UPDATE ON team_memberships
    FOR EACH ROW
    EXECUTE FUNCTION enforce_team_membership_update();

CREATE TABLE team_project_roles (
    team_id uuid NOT NULL,
    organization_id uuid NOT NULL,
    project_id uuid NOT NULL,
    role text NOT NULL,
    created_at timestamptz NOT NULL DEFAULT CURRENT_TIMESTAMP,
    updated_at timestamptz NOT NULL DEFAULT CURRENT_TIMESTAMP,
    lock_version bigint NOT NULL DEFAULT 1,
    PRIMARY KEY (team_id, project_id),
    CONSTRAINT team_project_roles_team_fk
        FOREIGN KEY (team_id, organization_id)
        REFERENCES teams (id, organization_id)
        ON DELETE CASCADE,
    CONSTRAINT team_project_roles_project_owner_fk
        FOREIGN KEY (project_id, organization_id)
        REFERENCES projects (id, owner_organization_id)
        ON DELETE CASCADE,
    CONSTRAINT team_project_roles_role_check
        CHECK (role IN ('read', 'write', 'admin')),
    CONSTRAINT team_project_roles_timestamps_check
        CHECK (updated_at >= created_at),
    CONSTRAINT team_project_roles_lock_version_check
        CHECK (lock_version BETWEEN 1 AND 9223372036854775806)
);

CREATE INDEX team_project_roles_project_idx
    ON team_project_roles (project_id, organization_id, team_id);
CREATE INDEX team_project_roles_organization_idx
    ON team_project_roles (organization_id, team_id, project_id);

CREATE OR REPLACE FUNCTION enforce_team_project_role_target()
RETURNS trigger
LANGUAGE plpgsql
AS $$
BEGIN
    IF NOT EXISTS (
        SELECT 1
        FROM teams team
        JOIN organizations organization
          ON organization.id = team.organization_id
        JOIN projects project
          ON project.id = NEW.project_id
         AND project.owner_organization_id = team.organization_id
        WHERE team.id = NEW.team_id
          AND team.organization_id = NEW.organization_id
          AND organization.status = 'active'
          AND project.owner_user_id IS NULL
          AND project.state = 'active'
    ) THEN
        RAISE EXCEPTION 'team project role target is unavailable'
            USING ERRCODE = '23514',
                  CONSTRAINT = 'team_project_roles_active_target';
    END IF;
    RETURN NEW;
END;
$$;

CREATE TRIGGER team_project_roles_target
    BEFORE INSERT OR UPDATE ON team_project_roles
    FOR EACH ROW
    EXECUTE FUNCTION enforce_team_project_role_target();

CREATE OR REPLACE FUNCTION enforce_team_project_role_update()
RETURNS trigger
LANGUAGE plpgsql
AS $$
BEGIN
    IF NEW.team_id IS DISTINCT FROM OLD.team_id
        OR NEW.organization_id IS DISTINCT FROM OLD.organization_id
        OR NEW.project_id IS DISTINCT FROM OLD.project_id
        OR NEW.created_at IS DISTINCT FROM OLD.created_at
    THEN
        RAISE EXCEPTION 'team project role identity fields cannot change'
            USING ERRCODE = '23514';
    END IF;

    IF NEW.lock_version <> OLD.lock_version + 1 THEN
        RAISE EXCEPTION 'team project role update must advance lock version exactly once'
            USING ERRCODE = '23514';
    END IF;
    RETURN NEW;
END;
$$;

CREATE TRIGGER team_project_roles_update_invariants
    BEFORE UPDATE ON team_project_roles
    FOR EACH ROW
    EXECUTE FUNCTION enforce_team_project_role_update();
