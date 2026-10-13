-- Expand storage scopes into the exactly-one accounting boundary shared by
-- Personal and Organization Workspaces. Existing User ownership and IDs are
-- preserved byte-for-byte.

ALTER TABLE storage_scopes
    ALTER COLUMN owner_user_id DROP NOT NULL,
    ADD COLUMN owner_organization_id uuid,
    ADD CONSTRAINT storage_scopes_owner_organization_unique
        UNIQUE (owner_organization_id),
    ADD CONSTRAINT storage_scopes_owner_organization_fk
        FOREIGN KEY (owner_organization_id)
        REFERENCES organizations (id)
        ON DELETE RESTRICT,
    ADD CONSTRAINT storage_scopes_exactly_one_owner_check
        CHECK (num_nonnulls(owner_user_id, owner_organization_id) = 1);

-- PostgreSQL core has no UUIDv7 generator. Derive a stable namespace-separated
-- UUID from the immutable Organization ID, then force the version/variant bits.
-- The primary key and per-owner unique constraints fail closed on any collision.
WITH organization_scope_ids AS (
    SELECT
        id AS organization_id,
        created_at,
        updated_at,
        md5('nuriteo:organization-storage-scope:v1:' || id::text) AS digest
    FROM organizations
),
organization_scopes AS (
    SELECT
        (
            substring(digest FROM 1 FOR 8) || '-' ||
            substring(digest FROM 9 FOR 4) || '-' ||
            '7' || substring(digest FROM 14 FOR 3) || '-' ||
            '8' || substring(digest FROM 18 FOR 3) || '-' ||
            substring(digest FROM 21 FOR 12)
        )::uuid AS id,
        organization_id,
        created_at,
        updated_at
    FROM organization_scope_ids
)
INSERT INTO storage_scopes (
    id,
    owner_user_id,
    owner_organization_id,
    created_at,
    updated_at
)
SELECT id, NULL, organization_id, created_at, GREATEST(created_at, updated_at)
FROM organization_scopes;
