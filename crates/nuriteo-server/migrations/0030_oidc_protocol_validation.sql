-- OIDC-002 validation proof. A provider may become active only when a proof
-- produced for its exact metadata and credential generation is committed in
-- the same update.

ALTER TABLE oidc_providers
    ADD COLUMN authorization_endpoint text,
    ADD COLUMN token_endpoint text,
    ADD COLUMN jwks_uri text,
    ADD COLUMN redirect_uri text,
    ADD COLUMN validation_config_version bigint,
    ADD COLUMN validation_secret_version bigint,
    ADD COLUMN validation_fingerprint bytea,
    ADD COLUMN validation_ca_fingerprint bytea,
    ADD COLUMN jwks_fingerprint bytea,
    ADD COLUMN validated_at timestamptz,
    ADD COLUMN validation_proof_id uuid,
    ADD CONSTRAINT oidc_providers_validation_shape_check CHECK (
        (authorization_endpoint IS NULL AND token_endpoint IS NULL
         AND jwks_uri IS NULL AND redirect_uri IS NULL
         AND validation_config_version IS NULL AND validation_secret_version IS NULL
         AND validation_fingerprint IS NULL AND validation_ca_fingerprint IS NULL
         AND jwks_fingerprint IS NULL
         AND validated_at IS NULL AND validation_proof_id IS NULL)
        OR
        (authorization_endpoint IS NOT NULL AND token_endpoint IS NOT NULL
         AND jwks_uri IS NOT NULL AND redirect_uri IS NOT NULL
         AND validation_config_version >= 1 AND validation_secret_version >= 1
         AND octet_length(validation_fingerprint) = 32
         AND octet_length(validation_ca_fingerprint) = 32
         AND octet_length(jwks_fingerprint) = 32
         AND validated_at IS NOT NULL AND validation_proof_id IS NOT NULL)
    ),
    ADD CONSTRAINT oidc_providers_active_validation_check CHECK (
        status = 'disabled'
        OR (
            validation_config_version = config_version - 1
            AND validation_secret_version = secret_version
            AND authorization_endpoint IS NOT NULL
            AND token_endpoint IS NOT NULL
            AND jwks_uri IS NOT NULL
            AND redirect_uri IS NOT NULL
            AND octet_length(validation_fingerprint) = 32
            AND octet_length(validation_ca_fingerprint) = 32
            AND octet_length(jwks_fingerprint) = 32
            AND validation_proof_id IS NOT NULL
        )
    );

CREATE TABLE oidc_validation_proofs (
    id uuid PRIMARY KEY,
    -- Deliberately not a FK: proof history remains as a value-free tombstone
    -- after the OIDC-001 hard-delete flow removes an unlinked provider.
    provider_id uuid NOT NULL,
    config_version bigint NOT NULL,
    secret_version bigint NOT NULL,
    authorization_endpoint text NOT NULL,
    token_endpoint text NOT NULL,
    jwks_uri text NOT NULL,
    redirect_uri text NOT NULL,
    validation_fingerprint bytea NOT NULL,
    validation_ca_fingerprint bytea NOT NULL,
    jwks_fingerprint bytea NOT NULL,
    attestation_key_version integer NOT NULL,
    activation_attestation bytea NOT NULL,
    created_at timestamptz NOT NULL DEFAULT CURRENT_TIMESTAMP,
    expires_at timestamptz NOT NULL,
    used_at timestamptz,
    CONSTRAINT oidc_validation_proofs_uuid_v7_check CHECK (
        (get_byte(uuid_send(id), 6) >> 4) = 7
        AND (get_byte(uuid_send(id), 8) & 192) = 128
    ),
    CONSTRAINT oidc_validation_proofs_generation_unique UNIQUE(provider_id, config_version),
    CONSTRAINT oidc_validation_proofs_versions_check CHECK (config_version >= 1 AND secret_version >= 1),
    CONSTRAINT oidc_validation_proofs_attestation_check CHECK (
        attestation_key_version >= 1 AND octet_length(activation_attestation)=32
    ),
    CONSTRAINT oidc_validation_proofs_fingerprints_check CHECK (
        octet_length(validation_fingerprint)=32
        AND octet_length(validation_ca_fingerprint)=32
        AND octet_length(jwks_fingerprint)=32
    ),
    CONSTRAINT oidc_validation_proofs_expiry_check CHECK (
        expires_at > created_at AND expires_at <= created_at + INTERVAL '5 minutes'
        AND (used_at IS NULL OR (used_at >= created_at AND used_at <= expires_at))
    )
);

ALTER TABLE oidc_providers ADD CONSTRAINT oidc_providers_validation_proof_fk
    FOREIGN KEY(validation_proof_id) REFERENCES oidc_validation_proofs(id) ON DELETE RESTRICT;

CREATE OR REPLACE FUNCTION enforce_oidc_provider_update() RETURNS trigger
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
    IF NEW.secret_version NOT IN (OLD.secret_version, OLD.secret_version + 1) THEN
        RAISE EXCEPTION 'OIDC provider secret version transition is invalid';
    END IF;
    IF OLD.client_secret_credential_id IS NOT NULL
       AND NEW.client_secret_credential_id IS DISTINCT FROM OLD.client_secret_credential_id THEN
        RAISE EXCEPTION 'OIDC provider credential identity cannot change';
    END IF;
    IF OLD.status = 'disabled' AND NEW.status = 'active' AND (
        NEW.validation_config_version IS DISTINCT FROM OLD.config_version
        OR NEW.validation_secret_version IS DISTINCT FROM NEW.secret_version
        OR NEW.validation_fingerprint IS NULL
        OR octet_length(NEW.validation_fingerprint) <> 32
        OR NEW.validation_ca_fingerprint IS NULL
        OR octet_length(NEW.validation_ca_fingerprint) <> 32
        OR NEW.jwks_fingerprint IS NULL
        OR octet_length(NEW.jwks_fingerprint) <> 32
        OR NEW.authorization_endpoint IS NULL
        OR NEW.token_endpoint IS NULL
        OR NEW.jwks_uri IS NULL
        OR NEW.redirect_uri IS NULL
        OR NEW.validated_at IS NULL
        OR NEW.validation_proof_id IS NULL
        OR NOT EXISTS (
            SELECT 1 FROM oidc_validation_proofs proof
            WHERE proof.id=NEW.validation_proof_id
              AND proof.provider_id=NEW.id
              AND proof.config_version=OLD.config_version
              AND proof.secret_version=NEW.secret_version
              AND proof.authorization_endpoint=NEW.authorization_endpoint
              AND proof.token_endpoint=NEW.token_endpoint
              AND proof.jwks_uri=NEW.jwks_uri
              AND proof.redirect_uri=NEW.redirect_uri
              AND proof.validation_fingerprint=NEW.validation_fingerprint
              AND proof.validation_ca_fingerprint=NEW.validation_ca_fingerprint
              AND proof.jwks_fingerprint=NEW.jwks_fingerprint
              AND proof.used_at IS NULL
              AND proof.expires_at >= transaction_timestamp()
        )
    ) THEN
        RAISE EXCEPTION 'OIDC provider activation requires an exact OIDC-002 validation proof';
    END IF;
    IF OLD.status = 'disabled' AND NEW.status = 'active' THEN
        UPDATE oidc_validation_proofs SET used_at=transaction_timestamp()
        WHERE id=NEW.validation_proof_id AND used_at IS NULL
          AND expires_at >= transaction_timestamp();
        IF NOT FOUND THEN
            RAISE EXCEPTION 'OIDC provider validation proof is stale or consumed';
        END IF;
    END IF;
    IF OLD.status = 'active' AND NEW.status = 'active' AND (
        NEW.client_id IS DISTINCT FROM OLD.client_id
        OR NEW.secret_version IS DISTINCT FROM OLD.secret_version
        OR NEW.authorization_endpoint IS DISTINCT FROM OLD.authorization_endpoint
        OR NEW.token_endpoint IS DISTINCT FROM OLD.token_endpoint
        OR NEW.jwks_uri IS DISTINCT FROM OLD.jwks_uri
        OR NEW.redirect_uri IS DISTINCT FROM OLD.redirect_uri
        OR NEW.validation_fingerprint IS DISTINCT FROM OLD.validation_fingerprint
        OR NEW.validation_ca_fingerprint IS DISTINCT FROM OLD.validation_ca_fingerprint
        OR NEW.jwks_fingerprint IS DISTINCT FROM OLD.jwks_fingerprint
        OR NEW.validation_config_version IS DISTINCT FROM OLD.validation_config_version
        OR NEW.validation_secret_version IS DISTINCT FROM OLD.validation_secret_version
        OR NEW.validated_at IS DISTINCT FROM OLD.validated_at
        OR NEW.validation_proof_id IS DISTINCT FROM OLD.validation_proof_id
    ) THEN
        RAISE EXCEPTION 'active OIDC validation state is immutable';
    END IF;
    RETURN NEW;
END;
$$;

CREATE FUNCTION protect_oidc_validation_proof() RETURNS trigger
LANGUAGE plpgsql AS $$
BEGIN
    IF TG_OP='DELETE' THEN
        RAISE EXCEPTION 'OIDC validation proof history cannot be deleted';
    END IF;
    IF OLD.id <> NEW.id OR OLD.provider_id <> NEW.provider_id
       OR OLD.config_version <> NEW.config_version OR OLD.secret_version <> NEW.secret_version
       OR OLD.authorization_endpoint <> NEW.authorization_endpoint
       OR OLD.token_endpoint <> NEW.token_endpoint OR OLD.jwks_uri <> NEW.jwks_uri
       OR OLD.redirect_uri <> NEW.redirect_uri
       OR OLD.validation_fingerprint <> NEW.validation_fingerprint
       OR OLD.validation_ca_fingerprint <> NEW.validation_ca_fingerprint
       OR OLD.jwks_fingerprint <> NEW.jwks_fingerprint
       OR OLD.attestation_key_version <> NEW.attestation_key_version
       OR OLD.activation_attestation <> NEW.activation_attestation
       OR OLD.created_at <> NEW.created_at OR OLD.expires_at <> NEW.expires_at
       OR OLD.used_at IS NOT NULL OR NEW.used_at IS NULL THEN
        RAISE EXCEPTION 'OIDC validation proof is immutable';
    END IF;
    RETURN NEW;
END;
$$;

CREATE TRIGGER oidc_validation_proofs_update_guard BEFORE UPDATE ON oidc_validation_proofs
FOR EACH ROW EXECUTE FUNCTION protect_oidc_validation_proof();
CREATE TRIGGER oidc_validation_proofs_delete_guard BEFORE DELETE ON oidc_validation_proofs
FOR EACH ROW EXECUTE FUNCTION protect_oidc_validation_proof();
