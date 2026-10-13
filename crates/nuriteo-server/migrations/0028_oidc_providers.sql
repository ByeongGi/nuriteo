-- Global multi-provider OIDC administration. Protocol discovery, JWKS and
-- endpoint validation remain owned by OIDC-002.

ALTER TABLE oidc_providers
    ADD COLUMN client_id text,
    ADD COLUMN config_version bigint NOT NULL DEFAULT 1,
    ADD COLUMN secret_version bigint NOT NULL DEFAULT 0,
    ADD COLUMN client_secret_credential_id uuid;

-- The Alpha schema was not connected to an OIDC runtime. Preserve any
-- manually seeded row as disabled and require an administrator to replace the
-- placeholder client identity through the supported service before use.
UPDATE oidc_providers
SET client_id = 'unconfigured',
    status = 'disabled',
    disabled_at = COALESCE(disabled_at, CURRENT_TIMESTAMP),
    updated_at = CURRENT_TIMESTAMP;

ALTER TABLE oidc_providers
    ALTER COLUMN client_id SET NOT NULL,
    ALTER COLUMN client_id DROP DEFAULT,
    ADD CONSTRAINT oidc_providers_uuid_v7_check CHECK (
        (get_byte(uuid_send(id), 6) >> 4) = 7
        AND (get_byte(uuid_send(id), 8) & 192) = 128
    ),
    ADD CONSTRAINT oidc_providers_client_id_check CHECK (
        client_id = btrim(client_id)
        AND client_id !~ '[[:cntrl:]]'
        AND char_length(client_id) BETWEEN 1 AND 1024
    ),
    ADD CONSTRAINT oidc_providers_config_version_check CHECK (config_version >= 1),
    ADD CONSTRAINT oidc_providers_secret_version_check CHECK (
        (secret_version = 0 AND client_secret_credential_id IS NULL)
        OR (secret_version >= 1 AND client_secret_credential_id IS NOT NULL)
    ),
    ADD CONSTRAINT oidc_providers_active_secret_check CHECK (
        status = 'disabled'
        OR (secret_version >= 1 AND client_secret_credential_id IS NOT NULL)
    ),
    ADD CONSTRAINT oidc_providers_client_secret_fk
        FOREIGN KEY (client_secret_credential_id) REFERENCES integration_credentials (id)
        ON DELETE RESTRICT DEFERRABLE INITIALLY DEFERRED;

CREATE INDEX oidc_providers_status_display_idx
    ON oidc_providers (status, display_name, id);

CREATE FUNCTION enforce_oidc_provider_insert() RETURNS trigger
LANGUAGE plpgsql AS $$
BEGIN
    IF NEW.status <> 'disabled'
       OR NEW.disabled_at IS NULL
       OR NEW.secret_version <> 0
       OR NEW.client_secret_credential_id IS NOT NULL THEN
        RAISE EXCEPTION 'OIDC provider must be inserted as an unconfigured disabled candidate';
    END IF;
    RETURN NEW;
END;
$$;

CREATE TRIGGER oidc_providers_insert_guard
BEFORE INSERT ON oidc_providers
FOR EACH ROW EXECUTE FUNCTION enforce_oidc_provider_insert();

CREATE FUNCTION enforce_oidc_provider_update() RETURNS trigger
LANGUAGE plpgsql AS $$
BEGIN
    IF OLD.id <> NEW.id
       OR OLD.issuer <> NEW.issuer
       OR OLD.created_at <> NEW.created_at THEN
        RAISE EXCEPTION 'OIDC provider identity and issuer cannot change';
    END IF;
    IF NEW.config_version <> OLD.config_version + 1 THEN
        RAISE EXCEPTION 'OIDC provider config version must increase by one';
    END IF;
    IF OLD.status = 'disabled' AND NEW.status = 'active' THEN
        RAISE EXCEPTION 'OIDC provider activation requires the OIDC-002 validation boundary';
    END IF;
    IF NEW.secret_version NOT IN (OLD.secret_version, OLD.secret_version + 1) THEN
        RAISE EXCEPTION 'OIDC provider secret version transition is invalid';
    END IF;
    IF OLD.client_secret_credential_id IS NOT NULL
       AND NEW.client_secret_credential_id IS DISTINCT FROM OLD.client_secret_credential_id THEN
        RAISE EXCEPTION 'OIDC provider credential identity cannot change';
    END IF;
    RETURN NEW;
END;
$$;

CREATE TRIGGER oidc_providers_update_guard
BEFORE UPDATE ON oidc_providers
FOR EACH ROW EXECUTE FUNCTION enforce_oidc_provider_update();

CREATE FUNCTION enforce_oidc_provider_secret_binding() RETURNS trigger
LANGUAGE plpgsql AS $$
BEGIN
    IF NEW.secret_version > 0 AND NOT EXISTS (
        SELECT 1 FROM integration_credentials
        WHERE id = NEW.client_secret_credential_id
          AND integration_type = 'oidc'
          AND integration_id = NEW.id::text
          AND credential_kind = 'client_secret'
          AND credential_version = NEW.secret_version
    ) THEN
        RAISE EXCEPTION 'OIDC provider secret generation is unavailable';
    END IF;
    RETURN NEW;
END;
$$;

CREATE CONSTRAINT TRIGGER oidc_provider_secret_binding_guard
AFTER INSERT OR UPDATE ON oidc_providers
DEFERRABLE INITIALLY DEFERRED
FOR EACH ROW EXECUTE FUNCTION enforce_oidc_provider_secret_binding();

CREATE FUNCTION enforce_oidc_credential_reverse_binding() RETURNS trigger
LANGUAGE plpgsql AS $$
BEGIN
    IF NEW.integration_type = 'oidc'
       AND NEW.credential_kind = 'client_secret'
       AND EXISTS (
           SELECT 1 FROM oidc_providers provider
           WHERE provider.client_secret_credential_id = NEW.id
       )
       AND NOT EXISTS (
           SELECT 1 FROM oidc_providers provider
           WHERE provider.client_secret_credential_id = NEW.id
             AND provider.id::text = NEW.integration_id
             AND provider.secret_version = NEW.credential_version
       ) THEN
        RAISE EXCEPTION 'OIDC credential generation is not bound to its provider';
    END IF;
    RETURN NEW;
END;
$$;

CREATE CONSTRAINT TRIGGER oidc_credential_reverse_binding_guard
AFTER UPDATE ON integration_credentials
DEFERRABLE INITIALLY DEFERRED
FOR EACH ROW EXECUTE FUNCTION enforce_oidc_credential_reverse_binding();

CREATE FUNCTION enforce_oidc_provider_delete() RETURNS trigger
LANGUAGE plpgsql AS $$
BEGIN
    IF OLD.status <> 'disabled' THEN
        RAISE EXCEPTION 'OIDC provider must be disabled before deletion';
    END IF;
    IF EXISTS (SELECT 1 FROM oidc_identities WHERE provider_id = OLD.id) THEN
        RAISE EXCEPTION 'OIDC provider with linked identities cannot be deleted';
    END IF;
    RETURN OLD;
END;
$$;

CREATE TRIGGER oidc_providers_delete_guard
BEFORE DELETE ON oidc_providers
FOR EACH ROW EXECUTE FUNCTION enforce_oidc_provider_delete();
