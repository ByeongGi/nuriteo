-- Enforce the Alpha Organization membership ceiling at the database boundary.
-- The total row cap includes memberships whose users are currently inactive,
-- which makes activation incapable of bypassing the list-completeness invariant.

LOCK TABLE organizations, organization_memberships IN SHARE ROW EXCLUSIVE MODE;

DO $$
BEGIN
    IF EXISTS (
        SELECT organization_id
        FROM organization_memberships
        GROUP BY organization_id
        HAVING count(*) > 100
    ) THEN
        RAISE EXCEPTION 'existing organization exceeds the member limit'
            USING ERRCODE = '23514',
                  CONSTRAINT = 'organization_member_limit';
    END IF;
END;
$$;

CREATE OR REPLACE FUNCTION enforce_organization_member_limit()
RETURNS trigger
LANGUAGE plpgsql
AS $$
DECLARE
    lock_id uuid;
    members bigint;
    admission_required boolean := FALSE;
BEGIN
    IF TG_OP = 'INSERT' THEN
        admission_required := TRUE;
    ELSE
        admission_required := OLD.organization_id IS DISTINCT FROM NEW.organization_id
            OR OLD.user_id IS DISTINCT FROM NEW.user_id;
    END IF;

    FOR lock_id IN
        SELECT id
          FROM (
              VALUES (NEW.organization_id),
                     (CASE WHEN TG_OP = 'UPDATE' THEN OLD.organization_id ELSE NEW.organization_id END)
          ) AS organizations_to_lock(id)
         GROUP BY id
         ORDER BY id
    LOOP
        PERFORM pg_advisory_xact_lock(1314212943, hashtext(lock_id::text));
    END LOOP;

    IF admission_required THEN
        IF TG_OP = 'INSERT' THEN
            SELECT count(*)
              INTO members
              FROM organization_memberships
             WHERE organization_id = NEW.organization_id;
        ELSE
            SELECT count(*)
              INTO members
              FROM organization_memberships
             WHERE organization_id = NEW.organization_id
               AND (organization_id, user_id)
                  <> (OLD.organization_id, OLD.user_id);
        END IF;

        IF members >= 100 THEN
            RAISE EXCEPTION 'organization member limit was reached'
                USING ERRCODE = '23514',
                      CONSTRAINT = 'organization_member_limit';
        END IF;
    END IF;

    RETURN NEW;
END;
$$;

CREATE TRIGGER organization_memberships_member_limit
BEFORE INSERT OR UPDATE OF organization_id, user_id
ON organization_memberships
FOR EACH ROW
EXECUTE FUNCTION enforce_organization_member_limit();
