-- Serializes administrator and active-owner removal so concurrent lifecycle
-- changes cannot leave an Instance without an active administrator or an
-- Organization without an active owner.

CREATE OR REPLACE FUNCTION enforce_user_administration_lifecycle()
RETURNS trigger
LANGUAGE plpgsql
AS $$
BEGIN
    IF OLD.status = 'active' AND OLD.is_instance_admin
       AND NOT (NEW.status = 'active' AND NEW.is_instance_admin)
    THEN
        PERFORM pg_advisory_xact_lock(1314212948, 0);
        IF NOT EXISTS (
            SELECT 1
            FROM users candidate
            WHERE candidate.id <> OLD.id
              AND candidate.status = 'active'
              AND candidate.is_instance_admin
        ) THEN
            RAISE EXCEPTION 'instance must retain an active administrator'
                USING ERRCODE = '23514',
                      CONSTRAINT = 'users_last_active_instance_admin';
        END IF;
    END IF;

    IF OLD.status = 'active' AND NEW.status = 'disabled' THEN
        PERFORM pg_advisory_xact_lock(1314212948, 0);
        IF EXISTS (
            SELECT 1
            FROM organization_memberships target_membership
            WHERE target_membership.user_id = OLD.id
              AND target_membership.role = 'owner'
              AND NOT EXISTS (
                  SELECT 1
                  FROM organization_memberships other_membership
                  JOIN users other_user ON other_user.id = other_membership.user_id
                  WHERE other_membership.organization_id = target_membership.organization_id
                    AND other_membership.user_id <> OLD.id
                    AND other_membership.role = 'owner'
                    AND other_user.status = 'active'
              )
        ) THEN
            RAISE EXCEPTION 'organization must retain an active owner'
                USING ERRCODE = '23514',
                      CONSTRAINT = 'users_last_active_organization_owner';
        END IF;
    END IF;

    RETURN NEW;
END;
$$;

CREATE TRIGGER users_administration_lifecycle
    BEFORE UPDATE OF status, is_instance_admin ON users
    FOR EACH ROW
    EXECUTE FUNCTION enforce_user_administration_lifecycle();

CREATE OR REPLACE FUNCTION enforce_membership_active_owner_lifecycle()
RETURNS trigger
LANGUAGE plpgsql
AS $$
DECLARE
    affected_organization_id uuid;
    affected_user_id uuid;
BEGIN
    IF TG_OP = 'INSERT' OR NEW.role = 'owner' THEN
        IF NOT EXISTS (
            SELECT 1 FROM users
            WHERE id = NEW.user_id AND status = 'active'
        ) THEN
            RAISE EXCEPTION 'owner must be an active user'
                USING ERRCODE = '23514',
                      CONSTRAINT = 'organization_owner_active_user';
        END IF;
    END IF;

    IF TG_OP = 'DELETE'
       OR (
           OLD.role = 'owner'
           AND (
               NEW.role <> 'owner'
               OR NEW.user_id IS DISTINCT FROM OLD.user_id
               OR NEW.organization_id IS DISTINCT FROM OLD.organization_id
           )
       )
    THEN
        PERFORM pg_advisory_xact_lock(1314212948, 0);
        affected_organization_id := OLD.organization_id;
        affected_user_id := OLD.user_id;
        IF NOT EXISTS (
            SELECT 1
            FROM organization_memberships membership
            JOIN users owner_user ON owner_user.id = membership.user_id
            WHERE membership.organization_id = affected_organization_id
              AND membership.user_id <> affected_user_id
              AND membership.role = 'owner'
              AND owner_user.status = 'active'
        ) THEN
            RAISE EXCEPTION 'organization must retain an active owner'
                USING ERRCODE = '23514',
                      CONSTRAINT = 'organization_memberships_last_active_owner';
        END IF;
    END IF;

    IF TG_OP = 'DELETE' THEN
        RETURN OLD;
    END IF;
    RETURN NEW;
END;
$$;

CREATE TRIGGER organization_memberships_active_owner_lifecycle
    BEFORE INSERT OR UPDATE OF role, user_id, organization_id OR DELETE ON organization_memberships
    FOR EACH ROW
    EXECUTE FUNCTION enforce_membership_active_owner_lifecycle();
