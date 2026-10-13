-- Hash-only credentials for public API automation. Plaintext token secrets
-- must never cross this persistence boundary.

CREATE TABLE access_tokens (
    id uuid PRIMARY KEY,
    kind text NOT NULL,
    name text NOT NULL,
    principal_id uuid NOT NULL,
    owner_user_id uuid REFERENCES users(id) ON DELETE SET NULL,
    project_id uuid REFERENCES projects(id) ON DELETE SET NULL,
    created_by_user_id uuid REFERENCES users(id) ON DELETE SET NULL,
    scopes text[] NOT NULL,
    token_prefix text NOT NULL,
    secret_hash bytea,
    state text NOT NULL DEFAULT 'active',
    expires_at timestamptz NOT NULL,
    revoked_at timestamptz,
    revoke_reason text,
    rotation_family_id uuid NOT NULL,
    rotated_from_id uuid REFERENCES access_tokens(id) ON DELETE RESTRICT,
    created_at timestamptz NOT NULL DEFAULT CURRENT_TIMESTAMP,
    updated_at timestamptz NOT NULL DEFAULT CURRENT_TIMESTAMP,
    lock_version bigint NOT NULL DEFAULT 1,
    CONSTRAINT access_tokens_id_v7_check CHECK (
        substring(id::text FROM 15 FOR 1) = '7'
        AND substring(id::text FROM 20 FOR 1) IN ('8','9','a','b')
    ),
    CONSTRAINT access_tokens_rotation_family_v7_check CHECK (
        substring(rotation_family_id::text FROM 15 FOR 1) = '7'
        AND substring(rotation_family_id::text FROM 20 FOR 1) IN ('8','9','a','b')
    ),
    CONSTRAINT access_tokens_kind_check CHECK (kind IN ('personal','project')),
    CONSTRAINT access_tokens_name_check CHECK (
        name=btrim(name) AND name !~ '[[:cntrl:]]'
        AND char_length(name) BETWEEN 1 AND 120
    ),
    CONSTRAINT access_tokens_principal_check CHECK (
        (kind='personal' AND owner_user_id=principal_id AND project_id IS NULL)
        OR (kind='project' AND project_id=principal_id AND owner_user_id IS NULL)
    ),
    CONSTRAINT access_tokens_prefix_check CHECK (
        token_prefix = CASE kind
            WHEN 'personal' THEN 'nur_pat_' || id::text || '_'
            WHEN 'project' THEN 'nur_prj_' || id::text || '_'
        END
    ),
    CONSTRAINT access_tokens_scope_nonempty_check CHECK (cardinality(scopes) BETWEEN 1 AND 6),
    CONSTRAINT access_tokens_secret_hash_check CHECK (
        (state='active' AND octet_length(secret_hash)=32 AND revoked_at IS NULL AND revoke_reason IS NULL)
        OR (state='revoked' AND secret_hash IS NULL AND revoked_at IS NOT NULL
            AND char_length(btrim(revoke_reason)) BETWEEN 1 AND 200)
    ),
    CONSTRAINT access_tokens_state_check CHECK (state IN ('active','revoked')),
    CONSTRAINT access_tokens_expiry_check CHECK (
        expires_at > created_at AND expires_at <= created_at + INTERVAL '365 days'
    ),
    CONSTRAINT access_tokens_timestamps_check CHECK (
        updated_at >= created_at AND (revoked_at IS NULL OR revoked_at >= created_at)
    ),
    CONSTRAINT access_tokens_lock_version_check CHECK (lock_version BETWEEN 1 AND 9223372036854775806),
    CONSTRAINT access_tokens_secret_hash_unique UNIQUE(secret_hash)
);

CREATE INDEX access_tokens_owner_idx ON access_tokens(owner_user_id, state, expires_at, id)
    WHERE owner_user_id IS NOT NULL;
CREATE INDEX access_tokens_project_idx ON access_tokens(project_id, state, expires_at, id)
    WHERE project_id IS NOT NULL;
CREATE INDEX access_tokens_inactive_cleanup_idx ON access_tokens(updated_at, id)
    WHERE state='revoked';

CREATE FUNCTION enforce_access_token_write() RETURNS trigger
LANGUAGE plpgsql AS $$
DECLARE
    scope text;
    previous_scope text := NULL;
BEGIN
    IF TG_OP='INSERT' THEN
        IF NEW.token_prefix <> (CASE NEW.kind
            WHEN 'personal' THEN 'nur_pat_' || NEW.id::text || '_'
            WHEN 'project' THEN 'nur_prj_' || NEW.id::text || '_'
        END) THEN
            RAISE EXCEPTION 'access token prefix does not match its kind and id' USING ERRCODE='23514';
        END IF;
    ELSE
        IF NEW.id IS DISTINCT FROM OLD.id OR NEW.kind IS DISTINCT FROM OLD.kind
           OR NEW.principal_id IS DISTINCT FROM OLD.principal_id
           OR NEW.scopes IS DISTINCT FROM OLD.scopes
           OR NEW.token_prefix IS DISTINCT FROM OLD.token_prefix
           OR NEW.expires_at IS DISTINCT FROM OLD.expires_at
           OR NEW.created_by_user_id IS DISTINCT FROM OLD.created_by_user_id
           OR NEW.rotation_family_id IS DISTINCT FROM OLD.rotation_family_id
           OR NEW.rotated_from_id IS DISTINCT FROM OLD.rotated_from_id
           OR NEW.created_at IS DISTINCT FROM OLD.created_at THEN
            RAISE EXCEPTION 'access token credential fields are immutable' USING ERRCODE='23514';
        END IF;
        IF NEW.owner_user_id IS DISTINCT FROM OLD.owner_user_id
           AND NOT (OLD.owner_user_id IS NOT NULL AND NEW.owner_user_id IS NULL AND NEW.state='revoked') THEN
            RAISE EXCEPTION 'access token owner link is immutable' USING ERRCODE='23514';
        END IF;
        IF NEW.project_id IS DISTINCT FROM OLD.project_id
           AND NOT (OLD.project_id IS NOT NULL AND NEW.project_id IS NULL AND NEW.state='revoked') THEN
            RAISE EXCEPTION 'access token project link is immutable' USING ERRCODE='23514';
        END IF;
        IF OLD.state='revoked' THEN
            IF NEW.state='revoked' AND NEW.secret_hash IS NULL
               AND NEW.name IS NOT DISTINCT FROM OLD.name
               AND NEW.created_by_user_id IS NOT DISTINCT FROM OLD.created_by_user_id
               AND NEW.revoked_at IS NOT DISTINCT FROM OLD.revoked_at
               AND NEW.revoke_reason IS NOT DISTINCT FROM OLD.revoke_reason
               AND NEW.updated_at IS NOT DISTINCT FROM OLD.updated_at
               AND NEW.lock_version IS NOT DISTINCT FROM OLD.lock_version
               AND (
                   (OLD.owner_user_id IS NOT NULL AND NEW.owner_user_id IS NULL
                    AND NEW.project_id IS NOT DISTINCT FROM OLD.project_id)
                   OR (OLD.project_id IS NOT NULL AND NEW.project_id IS NULL
                       AND NEW.owner_user_id IS NOT DISTINCT FROM OLD.owner_user_id)
               ) THEN
                -- PostgreSQL FK ON DELETE SET NULL detaches the live resource
                -- link while principal_id preserves inactive audit metadata.
                RETURN NEW;
            END IF;
            RAISE EXCEPTION 'revoked access token is immutable' USING ERRCODE='23514';
        END IF;
        IF NEW.state='active' AND NEW.secret_hash IS DISTINCT FROM OLD.secret_hash THEN
            RAISE EXCEPTION 'access token hash is immutable' USING ERRCODE='23514';
        END IF;
        IF NEW.lock_version <> OLD.lock_version + 1 OR NEW.updated_at <= OLD.updated_at THEN
            RAISE EXCEPTION 'access token update must advance version and time' USING ERRCODE='23514';
        END IF;
    END IF;

    FOREACH scope IN ARRAY NEW.scopes LOOP
        IF scope NOT IN ('project:read','project:write','project:publish','project:manage','git:read','git:write')
           OR (NEW.kind='project' AND scope NOT IN ('project:read','project:write','project:publish'))
           OR (previous_scope IS NOT NULL AND scope <= previous_scope) THEN
            RAISE EXCEPTION 'access token scopes must be allowed, unique, and sorted' USING ERRCODE='23514';
        END IF;
        previous_scope := scope;
    END LOOP;
    RETURN NEW;
END;
$$;

CREATE TRIGGER access_tokens_write_guard
BEFORE INSERT OR UPDATE ON access_tokens
FOR EACH ROW EXECUTE FUNCTION enforce_access_token_write();

CREATE FUNCTION revoke_personal_tokens_for_user_lifecycle() RETURNS trigger
LANGUAGE plpgsql AS $$
BEGIN
    IF TG_OP='DELETE' OR (OLD.status='active' AND NEW.status='disabled') THEN
        UPDATE access_tokens SET state='revoked', secret_hash=NULL,
            revoked_at=transaction_timestamp(),
            revoke_reason=CASE WHEN TG_OP='DELETE' THEN 'user_deleted' ELSE 'user_disabled' END,
            updated_at=transaction_timestamp(), lock_version=lock_version+1
        WHERE owner_user_id=OLD.id AND state='active';
    END IF;
    RETURN CASE WHEN TG_OP='DELETE' THEN OLD ELSE NEW END;
END;
$$;

CREATE TRIGGER users_revoke_personal_access_tokens
BEFORE UPDATE OF status OR DELETE ON users
FOR EACH ROW EXECUTE FUNCTION revoke_personal_tokens_for_user_lifecycle();

CREATE FUNCTION revoke_project_tokens_for_trust_boundary() RETURNS trigger
LANGUAGE plpgsql AS $$
BEGIN
    IF TG_OP='DELETE' OR NEW.owner_user_id IS DISTINCT FROM OLD.owner_user_id
       OR NEW.owner_organization_id IS DISTINCT FROM OLD.owner_organization_id THEN
        UPDATE access_tokens SET state='revoked', secret_hash=NULL,
            revoked_at=transaction_timestamp(),
            revoke_reason=CASE WHEN TG_OP='DELETE' THEN 'project_deleted' ELSE 'project_transferred' END,
            updated_at=transaction_timestamp(), lock_version=lock_version+1
        WHERE project_id=OLD.id AND state='active';
    END IF;
    RETURN CASE WHEN TG_OP='DELETE' THEN OLD ELSE NEW END;
END;
$$;

CREATE TRIGGER projects_revoke_automation_tokens
BEFORE UPDATE OF owner_user_id, owner_organization_id OR DELETE ON projects
FOR EACH ROW EXECUTE FUNCTION revoke_project_tokens_for_trust_boundary();
