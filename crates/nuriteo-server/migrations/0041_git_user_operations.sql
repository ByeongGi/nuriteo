-- User-owned Git HTTPS credentials and one canonical remote binding per Project.
-- Credential plaintext remains in the common Master Key envelope. Git operations
-- are serialized by locking the Project remote row (or the Project for import).

CREATE TABLE user_git_credentials (
    id uuid PRIMARY KEY,
    user_id uuid NOT NULL REFERENCES users(id) ON DELETE CASCADE,
    provider_id uuid NOT NULL REFERENCES git_providers(id) ON DELETE RESTRICT,
    credential_id uuid NOT NULL REFERENCES integration_credentials(id)
        ON DELETE RESTRICT DEFERRABLE INITIALLY DEFERRED,
    credential_version bigint NOT NULL,
    connection_version bigint NOT NULL DEFAULT 1,
    created_at timestamptz NOT NULL DEFAULT CURRENT_TIMESTAMP,
    updated_at timestamptz NOT NULL DEFAULT CURRENT_TIMESTAMP,
    CONSTRAINT user_git_credentials_identity_unique UNIQUE(user_id,provider_id),
    CONSTRAINT user_git_credentials_uuid_v7_check CHECK (
        (get_byte(uuid_send(id),6) >> 4)=7
        AND (get_byte(uuid_send(id),8) & 192)=128
    ),
    CONSTRAINT user_git_credentials_versions_check CHECK (
        credential_version>=1 AND connection_version>=1
    ),
    CONSTRAINT user_git_credentials_time_check CHECK(updated_at>=created_at)
);

CREATE INDEX user_git_credentials_provider_idx
    ON user_git_credentials(provider_id,user_id);

CREATE FUNCTION enforce_user_git_credential_update() RETURNS trigger
LANGUAGE plpgsql AS $$
BEGIN
    IF NEW.id<>OLD.id OR NEW.user_id<>OLD.user_id
       OR NEW.provider_id<>OLD.provider_id OR NEW.credential_id<>OLD.credential_id
       OR NEW.created_at<>OLD.created_at THEN
        RAISE EXCEPTION 'Git credential identity cannot change' USING ERRCODE='23514';
    END IF;
    IF NEW.connection_version<>OLD.connection_version+1
       OR NEW.credential_version<>OLD.credential_version+1 THEN
        RAISE EXCEPTION 'Git credential rotation must advance one generation'
            USING ERRCODE='23514';
    END IF;
    RETURN NEW;
END;
$$;

CREATE TRIGGER user_git_credentials_update_guard
BEFORE UPDATE ON user_git_credentials
FOR EACH ROW EXECUTE FUNCTION enforce_user_git_credential_update();

CREATE FUNCTION enforce_user_git_credential_binding() RETURNS trigger
LANGUAGE plpgsql AS $$
BEGIN
    IF NOT EXISTS(
        SELECT 1 FROM integration_credentials
        WHERE id=NEW.credential_id AND instance_id='instance'
          AND integration_type='git_user' AND integration_id=NEW.id::text
          AND credential_kind='https_token'
          AND credential_version=NEW.credential_version
    ) THEN
        RAISE EXCEPTION 'Git credential generation is unavailable' USING ERRCODE='23514';
    END IF;
    RETURN NEW;
END;
$$;

CREATE CONSTRAINT TRIGGER user_git_credential_binding_guard
AFTER INSERT OR UPDATE ON user_git_credentials DEFERRABLE INITIALLY DEFERRED
FOR EACH ROW EXECUTE FUNCTION enforce_user_git_credential_binding();

CREATE TABLE project_git_remotes (
    project_id uuid PRIMARY KEY REFERENCES projects(id) ON DELETE CASCADE,
    provider_id uuid NOT NULL REFERENCES git_providers(id) ON DELETE RESTRICT,
    repository_url text NOT NULL,
    branch text NOT NULL,
    remote_head_sha text NOT NULL,
    imported_by_user_id uuid NOT NULL REFERENCES users(id) ON DELETE RESTRICT,
    remote_version bigint NOT NULL DEFAULT 1,
    created_at timestamptz NOT NULL DEFAULT CURRENT_TIMESTAMP,
    updated_at timestamptz NOT NULL DEFAULT CURRENT_TIMESTAMP,
    CONSTRAINT project_git_remotes_url_check CHECK (
        repository_url LIKE 'https://%' AND char_length(repository_url) BETWEEN 9 AND 2048
        AND repository_url !~ '[[:cntrl:][:space:]]'
    ),
    CONSTRAINT project_git_remotes_branch_check CHECK (
        branch=btrim(branch) AND branch !~ '[[:cntrl:][:space:]]'
        AND char_length(branch) BETWEEN 1 AND 255
    ),
    CONSTRAINT project_git_remotes_sha_check CHECK (
        remote_head_sha ~ '^[0-9a-f]{40}([0-9a-f]{24})?$'
    ),
    CONSTRAINT project_git_remotes_version_check CHECK(remote_version>=1),
    CONSTRAINT project_git_remotes_time_check CHECK(updated_at>=created_at)
);

CREATE INDEX project_git_remotes_provider_idx
    ON project_git_remotes(provider_id,project_id);

CREATE FUNCTION enforce_project_git_remote_update() RETURNS trigger
LANGUAGE plpgsql AS $$
BEGIN
    IF NEW.project_id<>OLD.project_id OR NEW.provider_id<>OLD.provider_id
       OR NEW.repository_url<>OLD.repository_url OR NEW.branch<>OLD.branch
       OR NEW.imported_by_user_id<>OLD.imported_by_user_id
       OR NEW.created_at<>OLD.created_at THEN
        RAISE EXCEPTION 'Project Git remote identity cannot change' USING ERRCODE='23514';
    END IF;
    IF NEW.remote_version<>OLD.remote_version+1 THEN
        RAISE EXCEPTION 'Project Git remote generation must advance once' USING ERRCODE='23514';
    END IF;
    RETURN NEW;
END;
$$;

CREATE TRIGGER project_git_remotes_update_guard
BEFORE UPDATE ON project_git_remotes
FOR EACH ROW EXECUTE FUNCTION enforce_project_git_remote_update();

-- The Alpha trigger denied every credential deletion. Permit deletion only
-- after every durable owner has been removed in the same transaction.
CREATE OR REPLACE FUNCTION protect_integration_credential_ownership() RETURNS trigger
LANGUAGE plpgsql AS $$
BEGIN
    IF EXISTS(SELECT 1 FROM oidc_providers WHERE client_secret_credential_id=OLD.id)
       OR EXISTS(SELECT 1 FROM registry_connections WHERE credential_id=OLD.id)
       OR EXISTS(SELECT 1 FROM user_git_credentials WHERE credential_id=OLD.id) THEN
        RAISE EXCEPTION 'adopted integration credentials cannot be deleted';
    END IF;
    RETURN OLD;
END;
$$;
