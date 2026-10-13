-- Encrypted integration credentials and integrity-sensitive private trust roots.
-- Master keys remain external to PostgreSQL. Ciphertext context is bound in Rust
-- to the instance, integration, credential identity and logical value version.

CREATE TABLE integration_credentials (
    id uuid PRIMARY KEY,
    instance_id text NOT NULL,
    integration_type text NOT NULL,
    integration_id text NOT NULL,
    credential_kind text NOT NULL,
    credential_version bigint NOT NULL,
    algorithm text NOT NULL,
    key_version integer NOT NULL,
    nonce bytea NOT NULL,
    ciphertext bytea NOT NULL,
    created_at timestamptz NOT NULL DEFAULT CURRENT_TIMESTAMP,
    updated_at timestamptz NOT NULL DEFAULT CURRENT_TIMESTAMP,
    CONSTRAINT integration_credentials_identity_unique
        UNIQUE (instance_id, integration_type, integration_id, credential_kind),
    CONSTRAINT integration_credentials_uuid_v7_check
        CHECK (
            (get_byte(uuid_send(id), 6) >> 4) = 7
            AND (get_byte(uuid_send(id), 8) & 192) = 128
        ),
    CONSTRAINT integration_credentials_nonce_unique UNIQUE (key_version, nonce),
    CONSTRAINT integration_credentials_instance_check
        CHECK (instance_id ~ '^[A-Za-z0-9][A-Za-z0-9._:-]{0,127}$'),
    CONSTRAINT integration_credentials_names_check CHECK (
        integration_type ~ '^[a-z][a-z0-9_-]{0,63}$'
        AND integration_id ~ '^[A-Za-z0-9][A-Za-z0-9._:-]{0,127}$'
        AND credential_kind ~ '^[a-z][a-z0-9_-]{0,63}$'
    ),
    CONSTRAINT integration_credentials_version_check CHECK (credential_version >= 1),
    CONSTRAINT integration_credentials_algorithm_check CHECK (algorithm = 'aes-256-gcm-v1'),
    CONSTRAINT integration_credentials_key_version_check CHECK (key_version >= 1),
    CONSTRAINT integration_credentials_nonce_check CHECK (octet_length(nonce) = 12),
    CONSTRAINT integration_credentials_ciphertext_check
        CHECK (octet_length(ciphertext) BETWEEN 17 AND 65552),
    CONSTRAINT integration_credentials_timestamp_check CHECK (updated_at >= created_at)
);

CREATE INDEX integration_credentials_rotation_idx
    ON integration_credentials (key_version, id);

CREATE FUNCTION enforce_integration_credential_update() RETURNS trigger
LANGUAGE plpgsql AS $$
BEGIN
    IF OLD.id <> NEW.id
       OR OLD.instance_id <> NEW.instance_id
       OR OLD.integration_type <> NEW.integration_type
       OR OLD.integration_id <> NEW.integration_id
       OR OLD.credential_kind <> NEW.credential_kind
       OR OLD.created_at <> NEW.created_at THEN
        RAISE EXCEPTION 'integration credential identity cannot change';
    END IF;
    IF NEW.algorithm <> OLD.algorithm
       OR NEW.updated_at < OLD.updated_at
       OR NEW.nonce = OLD.nonce
       OR NEW.ciphertext = OLD.ciphertext THEN
        RAISE EXCEPTION 'integration credential cryptographic fields must change together';
    END IF;
    IF NEW.credential_version = OLD.credential_version + 1 THEN
        RETURN NEW;
    END IF;
    IF NEW.credential_version = OLD.credential_version
       AND NEW.key_version <> OLD.key_version THEN
        RETURN NEW;
    END IF;
    RAISE EXCEPTION 'integration credential version transition is invalid';
END;
$$;

CREATE TRIGGER integration_credentials_update_guard
BEFORE UPDATE ON integration_credentials
FOR EACH ROW EXECUTE FUNCTION enforce_integration_credential_update();

CREATE FUNCTION protect_integration_credential_ownership() RETURNS trigger
LANGUAGE plpgsql AS $$
BEGIN
    RAISE EXCEPTION 'adopted integration credentials cannot be deleted';
END;
$$;

CREATE TRIGGER integration_credentials_delete_guard
BEFORE DELETE ON integration_credentials
FOR EACH ROW EXECUTE FUNCTION protect_integration_credential_ownership();

CREATE FUNCTION integration_ca_fingerprints_valid(input_fingerprints text[]) RETURNS boolean
LANGUAGE sql IMMUTABLE STRICT AS $$
    SELECT cardinality(input_fingerprints) BETWEEN 1 AND 64
       AND bool_and(value ~ '^[0-9a-f]{64}$')
    FROM unnest(input_fingerprints) AS value
$$;

CREATE TABLE integration_ca_bundles (
    id uuid PRIMARY KEY,
    integration_type text NOT NULL,
    integration_id text NOT NULL,
    version bigint NOT NULL,
    state text NOT NULL,
    pem bytea NOT NULL,
    certificate_count smallint NOT NULL,
    fingerprints text[] NOT NULL,
    earliest_expiry timestamptz NOT NULL,
    endpoint_fingerprint bytea NOT NULL,
    created_at timestamptz NOT NULL DEFAULT CURRENT_TIMESTAMP,
    activated_at timestamptz,
    retired_at timestamptz,
    CONSTRAINT integration_ca_identity_version_unique
        UNIQUE (integration_type, integration_id, version),
    CONSTRAINT integration_ca_uuid_v7_check CHECK (
        (get_byte(uuid_send(id), 6) >> 4) = 7
        AND (get_byte(uuid_send(id), 8) & 192) = 128
    ),
    CONSTRAINT integration_ca_names_check CHECK (
        integration_type ~ '^[a-z][a-z0-9_-]{0,63}$'
        AND integration_id ~ '^[A-Za-z0-9][A-Za-z0-9._:-]{0,127}$'
    ),
    CONSTRAINT integration_ca_version_check CHECK (version >= 1),
    CONSTRAINT integration_ca_state_check CHECK (state IN ('candidate', 'active', 'retired')),
    CONSTRAINT integration_ca_pem_check CHECK (octet_length(pem) BETWEEN 1 AND 1048576),
    CONSTRAINT integration_ca_count_check CHECK (
        certificate_count BETWEEN 1 AND 64
        AND cardinality(fingerprints) = certificate_count
    ),
    CONSTRAINT integration_ca_fingerprint_check CHECK (
        array_position(fingerprints, NULL) IS NULL
        AND integration_ca_fingerprints_valid(fingerprints)
    ),
    CONSTRAINT integration_ca_endpoint_fingerprint_check CHECK (octet_length(endpoint_fingerprint) = 32),
    CONSTRAINT integration_ca_lifecycle_check CHECK (
        (state = 'candidate' AND activated_at IS NULL AND retired_at IS NULL)
        OR (state = 'active' AND activated_at IS NOT NULL AND retired_at IS NULL)
        OR (state = 'retired' AND activated_at IS NOT NULL AND retired_at IS NOT NULL
            AND retired_at >= activated_at)
    )
);

CREATE UNIQUE INDEX integration_ca_one_candidate_idx
    ON integration_ca_bundles (integration_type, integration_id) WHERE state = 'candidate';
CREATE UNIQUE INDEX integration_ca_one_active_idx
    ON integration_ca_bundles (integration_type, integration_id) WHERE state = 'active';

CREATE FUNCTION enforce_integration_ca_insert() RETURNS trigger
LANGUAGE plpgsql AS $$
BEGIN
    IF NEW.state <> 'candidate'
       OR NEW.activated_at IS NOT NULL
       OR NEW.retired_at IS NOT NULL THEN
        RAISE EXCEPTION 'integration CA must be inserted as a candidate';
    END IF;
    RETURN NEW;
END;
$$;

CREATE TRIGGER integration_ca_insert_guard
BEFORE INSERT ON integration_ca_bundles
FOR EACH ROW EXECUTE FUNCTION enforce_integration_ca_insert();

CREATE FUNCTION enforce_integration_ca_lifecycle() RETURNS trigger
LANGUAGE plpgsql AS $$
BEGIN
    IF OLD.id <> NEW.id
       OR OLD.integration_type <> NEW.integration_type
       OR OLD.integration_id <> NEW.integration_id
       OR OLD.version <> NEW.version
       OR OLD.pem <> NEW.pem
       OR OLD.certificate_count <> NEW.certificate_count
       OR OLD.fingerprints <> NEW.fingerprints
       OR OLD.earliest_expiry <> NEW.earliest_expiry
       OR OLD.endpoint_fingerprint <> NEW.endpoint_fingerprint
       OR OLD.created_at <> NEW.created_at THEN
        RAISE EXCEPTION 'integration CA immutable fields cannot change';
    END IF;
    IF NOT (
        (OLD.state = 'candidate' AND NEW.state = 'active'
         AND OLD.activated_at IS NULL AND NEW.activated_at IS NOT NULL
         AND OLD.retired_at IS NULL AND NEW.retired_at IS NULL)
        OR (OLD.state = 'active' AND NEW.state = 'retired'
            AND OLD.activated_at = NEW.activated_at
            AND OLD.retired_at IS NULL AND NEW.retired_at IS NOT NULL)
    ) THEN
        RAISE EXCEPTION 'invalid integration CA lifecycle transition';
    END IF;
    RETURN NEW;
END;
$$;

CREATE TRIGGER integration_ca_lifecycle_guard
BEFORE UPDATE ON integration_ca_bundles
FOR EACH ROW EXECUTE FUNCTION enforce_integration_ca_lifecycle();

CREATE FUNCTION protect_integration_ca_history() RETURNS trigger
LANGUAGE plpgsql AS $$
BEGIN
    IF OLD.state <> 'candidate' THEN
        RAISE EXCEPTION 'active or retired integration CA history cannot be deleted';
    END IF;
    RETURN OLD;
END;
$$;

CREATE TRIGGER integration_ca_delete_guard
BEFORE DELETE ON integration_ca_bundles
FOR EACH ROW EXECUTE FUNCTION protect_integration_ca_history();
