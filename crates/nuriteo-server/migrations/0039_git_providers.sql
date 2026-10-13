-- Instance-global Git provider configuration. User credentials and remote Git
-- operations are introduced by GIT-002; this migration owns only the durable,
-- host-bound provider and its preflight generation fence.

CREATE TABLE git_providers (
    id uuid PRIMARY KEY,
    display_name text NOT NULL,
    provider_kind text NOT NULL,
    canonical_host text NOT NULL,
    canonical_port integer NOT NULL,
    api_base_url text NOT NULL,
    oauth_authorization_url text,
    oauth_token_url text,
    oauth_client_id text,
    status text NOT NULL DEFAULT 'disabled',
    allows_read boolean NOT NULL DEFAULT true,
    allows_write boolean NOT NULL DEFAULT false,
    config_version bigint NOT NULL DEFAULT 1,
    validation_config_version bigint,
    validation_endpoint_fingerprint bytea,
    validation_ca_fingerprint bytea,
    validated_at timestamptz,
    disabled_at timestamptz DEFAULT CURRENT_TIMESTAMP,
    created_at timestamptz NOT NULL DEFAULT CURRENT_TIMESTAMP,
    updated_at timestamptz NOT NULL DEFAULT CURRENT_TIMESTAMP,
    CONSTRAINT git_providers_uuid_v7_check CHECK (
        (get_byte(uuid_send(id), 6) >> 4) = 7
        AND (get_byte(uuid_send(id), 8) & 192) = 128
    ),
    CONSTRAINT git_providers_display_name_check CHECK (
        display_name=btrim(display_name) AND display_name !~ '[[:cntrl:]]'
        AND char_length(display_name) BETWEEN 1 AND 200
    ),
    CONSTRAINT git_providers_kind_check CHECK (
        provider_kind IN ('github','github_enterprise','gitlab','gitlab_self_managed','generic')
    ),
    CONSTRAINT git_providers_host_check CHECK (
        canonical_host=lower(canonical_host) AND canonical_host=btrim(canonical_host)
        AND canonical_host !~ '[[:cntrl:]/:@?#[:space:]]'
        AND char_length(canonical_host) BETWEEN 1 AND 253
    ),
    CONSTRAINT git_providers_port_check CHECK (canonical_port BETWEEN 1 AND 65535),
    CONSTRAINT git_providers_api_url_check CHECK (
        api_base_url LIKE 'https://%' AND char_length(api_base_url) BETWEEN 9 AND 2048
        AND api_base_url !~ '[[:cntrl:][:space:]]'
    ),
    CONSTRAINT git_providers_oauth_check CHECK (
        (provider_kind='generic' AND oauth_authorization_url IS NULL
            AND oauth_token_url IS NULL AND oauth_client_id IS NULL)
        OR
        (provider_kind<>'generic' AND oauth_authorization_url LIKE 'https://%'
            AND oauth_token_url LIKE 'https://%' AND oauth_client_id IS NOT NULL
            AND char_length(oauth_authorization_url) BETWEEN 9 AND 2048
            AND char_length(oauth_token_url) BETWEEN 9 AND 2048
            AND oauth_client_id=btrim(oauth_client_id)
            AND oauth_client_id !~ '[[:cntrl:]]'
            AND char_length(oauth_client_id) BETWEEN 1 AND 1024)
    ),
    CONSTRAINT git_providers_status_check CHECK (status IN ('active','disabled')),
    CONSTRAINT git_providers_operation_check CHECK (allows_read OR NOT allows_write),
    CONSTRAINT git_providers_version_check CHECK (config_version >= 1),
    CONSTRAINT git_providers_validation_check CHECK (
        (status='disabled')
        OR
        (status='active' AND validation_config_version=config_version-1
            AND octet_length(validation_endpoint_fingerprint)=32
            AND octet_length(validation_ca_fingerprint)=32
            AND validated_at IS NOT NULL AND disabled_at IS NULL)
    ),
    CONSTRAINT git_providers_time_check CHECK (updated_at>=created_at)
);

-- One exact host binding is authoritative even while disabled. This avoids a
-- later activation changing which credential would be selected for a URL.
CREATE UNIQUE INDEX git_providers_exact_host_idx
    ON git_providers(canonical_host,canonical_port);
CREATE INDEX git_providers_status_name_idx
    ON git_providers(status,lower(display_name),id);

CREATE FUNCTION enforce_git_provider_insert() RETURNS trigger
LANGUAGE plpgsql AS $$
BEGIN
    IF NEW.status<>'disabled' OR NEW.config_version<>1 OR NEW.disabled_at IS NULL
       OR NEW.validation_config_version IS NOT NULL
       OR NEW.validation_endpoint_fingerprint IS NOT NULL
       OR NEW.validation_ca_fingerprint IS NOT NULL OR NEW.validated_at IS NOT NULL THEN
        RAISE EXCEPTION 'Git provider must be inserted as an unvalidated disabled candidate'
            USING ERRCODE='23514';
    END IF;
    RETURN NEW;
END;
$$;

CREATE TRIGGER git_providers_insert_guard
BEFORE INSERT ON git_providers
FOR EACH ROW EXECUTE FUNCTION enforce_git_provider_insert();

CREATE FUNCTION enforce_git_provider_update() RETURNS trigger
LANGUAGE plpgsql AS $$
BEGIN
    IF NEW.id<>OLD.id OR NEW.canonical_host<>OLD.canonical_host
       OR NEW.canonical_port<>OLD.canonical_port OR NEW.created_at<>OLD.created_at THEN
        RAISE EXCEPTION 'Git provider identity and host binding cannot change' USING ERRCODE='23514';
    END IF;
    IF NEW.config_version<>OLD.config_version+1 THEN
        RAISE EXCEPTION 'Git provider config version must increase by one' USING ERRCODE='23514';
    END IF;
    IF OLD.status='active' AND NEW.status='active' AND (
        NEW.display_name IS DISTINCT FROM OLD.display_name
        OR NEW.provider_kind IS DISTINCT FROM OLD.provider_kind
        OR NEW.api_base_url IS DISTINCT FROM OLD.api_base_url
        OR NEW.oauth_authorization_url IS DISTINCT FROM OLD.oauth_authorization_url
        OR NEW.oauth_token_url IS DISTINCT FROM OLD.oauth_token_url
        OR NEW.oauth_client_id IS DISTINCT FROM OLD.oauth_client_id
        OR NEW.allows_read IS DISTINCT FROM OLD.allows_read
        OR NEW.allows_write IS DISTINCT FROM OLD.allows_write
    ) THEN
        RAISE EXCEPTION 'Active Git provider configuration is immutable' USING ERRCODE='23514';
    END IF;
    RETURN NEW;
END;
$$;

CREATE TRIGGER git_providers_update_guard
BEFORE UPDATE ON git_providers
FOR EACH ROW EXECUTE FUNCTION enforce_git_provider_update();

CREATE FUNCTION enforce_git_provider_delete() RETURNS trigger
LANGUAGE plpgsql AS $$
BEGIN
    IF OLD.status<>'disabled' THEN
        RAISE EXCEPTION 'Git provider must be disabled before deletion' USING ERRCODE='23514';
    END IF;
    RETURN OLD;
END;
$$;

CREATE TRIGGER git_providers_delete_guard
BEFORE DELETE ON git_providers
FOR EACH ROW EXECUTE FUNCTION enforce_git_provider_delete();
