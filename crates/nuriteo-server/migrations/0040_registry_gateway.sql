-- Instance-global npm Registry Gateway routing and encrypted credential binding.

CREATE TABLE registry_connections (
    id uuid PRIMARY KEY,
    display_name text NOT NULL,
    base_url text NOT NULL,
    canonical_host text NOT NULL,
    canonical_port integer NOT NULL,
    base_path text NOT NULL,
    status text NOT NULL DEFAULT 'disabled',
    is_default boolean NOT NULL DEFAULT false,
    config_version bigint NOT NULL DEFAULT 1,
    credential_version bigint NOT NULL DEFAULT 0,
    credential_id uuid,
    validation_config_version bigint,
    validation_credential_version bigint,
    validation_fingerprint bytea,
    validation_ca_fingerprint bytea,
    validated_at timestamptz,
    disabled_at timestamptz DEFAULT CURRENT_TIMESTAMP,
    created_at timestamptz NOT NULL DEFAULT CURRENT_TIMESTAMP,
    updated_at timestamptz NOT NULL DEFAULT CURRENT_TIMESTAMP,
    CONSTRAINT registry_connections_uuid_v7_check CHECK (
        (get_byte(uuid_send(id),6)>>4)=7 AND (get_byte(uuid_send(id),8)&192)=128
    ),
    CONSTRAINT registry_connections_name_check CHECK (
        display_name=btrim(display_name) AND display_name !~ '[[:cntrl:]]'
        AND char_length(display_name) BETWEEN 1 AND 200
    ),
    CONSTRAINT registry_connections_url_check CHECK (
        base_url LIKE 'https://%' AND char_length(base_url) BETWEEN 9 AND 2048
        AND base_url !~ '[[:cntrl:][:space:]]'
    ),
    CONSTRAINT registry_connections_host_check CHECK (
        canonical_host=lower(canonical_host) AND canonical_host=btrim(canonical_host)
        AND canonical_host !~ '[[:cntrl:]/:@?#[:space:]]'
        AND char_length(canonical_host) BETWEEN 1 AND 253
        AND canonical_port BETWEEN 1 AND 65535
    ),
    CONSTRAINT registry_connections_path_check CHECK (
        base_path LIKE '/%' AND base_path NOT LIKE '%..%'
        AND base_path NOT LIKE '%?%' AND base_path NOT LIKE '%#%'
        AND char_length(base_path) BETWEEN 1 AND 1024
    ),
    CONSTRAINT registry_connections_status_check CHECK (status IN ('active','disabled')),
    CONSTRAINT registry_connections_default_check CHECK (NOT is_default OR status='active'),
    CONSTRAINT registry_connections_version_check CHECK (config_version>=1),
    CONSTRAINT registry_connections_credential_check CHECK (
        (credential_version=0 AND credential_id IS NULL)
        OR (credential_version>=1 AND credential_id IS NOT NULL)
    ),
    CONSTRAINT registry_connections_active_check CHECK (
        status='disabled' OR (
            credential_version>=1 AND validation_config_version=config_version-1
            AND validation_credential_version=credential_version
            AND octet_length(validation_fingerprint)=32
            AND octet_length(validation_ca_fingerprint)=32
            AND validated_at IS NOT NULL AND disabled_at IS NULL
        )
    ),
    CONSTRAINT registry_connections_credential_fk FOREIGN KEY(credential_id)
        REFERENCES integration_credentials(id) ON DELETE RESTRICT DEFERRABLE INITIALLY DEFERRED
);

CREATE UNIQUE INDEX registry_connections_origin_path_idx
    ON registry_connections(canonical_host,canonical_port,base_path);
CREATE UNIQUE INDEX registry_connections_one_default_idx
    ON registry_connections(is_default) WHERE is_default;

CREATE TABLE registry_scope_routes (
    scope text PRIMARY KEY,
    connection_id uuid NOT NULL REFERENCES registry_connections(id) ON DELETE CASCADE,
    created_at timestamptz NOT NULL DEFAULT CURRENT_TIMESTAMP,
    updated_at timestamptz NOT NULL DEFAULT CURRENT_TIMESTAMP,
    CONSTRAINT registry_scope_routes_scope_check CHECK (
        scope ~ '^@[a-z0-9][a-z0-9._-]{0,63}$' AND scope=lower(scope)
    )
);

CREATE INDEX registry_scope_routes_connection_idx ON registry_scope_routes(connection_id,scope);

CREATE FUNCTION enforce_registry_connection_insert() RETURNS trigger
LANGUAGE plpgsql AS $$
BEGIN
    IF NEW.status<>'disabled' OR NEW.is_default OR NEW.config_version<>1
       OR NEW.credential_version<>0 OR NEW.credential_id IS NOT NULL
       OR NEW.validation_config_version IS NOT NULL OR NEW.validated_at IS NOT NULL THEN
        RAISE EXCEPTION 'Registry connection must be inserted as an unconfigured disabled candidate'
            USING ERRCODE='23514';
    END IF;
    RETURN NEW;
END;
$$;
CREATE TRIGGER registry_connections_insert_guard BEFORE INSERT ON registry_connections
FOR EACH ROW EXECUTE FUNCTION enforce_registry_connection_insert();

CREATE FUNCTION enforce_registry_connection_update() RETURNS trigger
LANGUAGE plpgsql AS $$
BEGIN
    IF NEW.id<>OLD.id OR NEW.canonical_host<>OLD.canonical_host
       OR NEW.canonical_port<>OLD.canonical_port OR NEW.base_path<>OLD.base_path
       OR NEW.created_at<>OLD.created_at THEN
        RAISE EXCEPTION 'Registry connection identity and endpoint binding cannot change'
            USING ERRCODE='23514';
    END IF;
    IF NEW.config_version<>OLD.config_version+1 THEN
        RAISE EXCEPTION 'Registry config version must increase by one' USING ERRCODE='23514';
    END IF;
    IF NEW.credential_version NOT IN (OLD.credential_version,OLD.credential_version+1) THEN
        RAISE EXCEPTION 'Registry credential generation transition is invalid' USING ERRCODE='23514';
    END IF;
    IF OLD.credential_id IS NOT NULL AND NEW.credential_id IS DISTINCT FROM OLD.credential_id THEN
        RAISE EXCEPTION 'Registry credential identity cannot change' USING ERRCODE='23514';
    END IF;
    IF OLD.status='active' AND NEW.status='active' AND (
        NEW.display_name IS DISTINCT FROM OLD.display_name
        OR NEW.base_url IS DISTINCT FROM OLD.base_url
        OR NEW.credential_version IS DISTINCT FROM OLD.credential_version
    ) THEN
        RAISE EXCEPTION 'Active Registry connection is immutable' USING ERRCODE='23514';
    END IF;
    RETURN NEW;
END;
$$;
CREATE TRIGGER registry_connections_update_guard BEFORE UPDATE ON registry_connections
FOR EACH ROW EXECUTE FUNCTION enforce_registry_connection_update();

CREATE FUNCTION enforce_registry_credential_binding() RETURNS trigger
LANGUAGE plpgsql AS $$
BEGIN
    IF NEW.credential_version>0 AND NOT EXISTS(
        SELECT 1 FROM integration_credentials
        WHERE id=NEW.credential_id AND integration_type='registry'
          AND integration_id=NEW.id::text AND credential_kind='auth_token'
          AND credential_version=NEW.credential_version
    ) THEN
        RAISE EXCEPTION 'Registry credential generation is unavailable' USING ERRCODE='23514';
    END IF;
    RETURN NEW;
END;
$$;
CREATE CONSTRAINT TRIGGER registry_credential_binding_guard
AFTER INSERT OR UPDATE ON registry_connections DEFERRABLE INITIALLY DEFERRED
FOR EACH ROW EXECUTE FUNCTION enforce_registry_credential_binding();

