-- Personal Workspace is a projection of User ownership, not a separate owner.
-- This internal scope is the stable storage/quota boundary for user-owned data.

CREATE TABLE storage_scopes (
    id uuid PRIMARY KEY,
    owner_user_id uuid NOT NULL,
    created_at timestamptz NOT NULL DEFAULT CURRENT_TIMESTAMP,
    updated_at timestamptz NOT NULL DEFAULT CURRENT_TIMESTAMP,
    CONSTRAINT storage_scopes_id_v7_check
        CHECK (
            substring(id::text FROM 15 FOR 1) = '7'
            AND substring(id::text FROM 20 FOR 1) IN ('8', '9', 'a', 'b')
        ),
    CONSTRAINT storage_scopes_owner_user_unique UNIQUE (owner_user_id),
    CONSTRAINT storage_scopes_owner_user_fk
        FOREIGN KEY (owner_user_id) REFERENCES users (id) ON DELETE RESTRICT,
    CONSTRAINT storage_scopes_timestamps_check CHECK (updated_at >= created_at)
);

-- Existing application-created User identifiers are UUIDv7. Reusing that
-- identifier only for this migration makes backfill deterministic without a
-- database random UUID extension; newly provisioned scopes receive their own ID.
INSERT INTO storage_scopes (id, owner_user_id, created_at, updated_at)
SELECT id, id, created_at, GREATEST(created_at, updated_at)
FROM users
ON CONFLICT (owner_user_id) DO NOTHING;
