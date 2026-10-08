-- OIDC identity linking is provisioned-only: an identity may be attached to an
-- existing account or to an unexpired invitation, never by unrestricted JIT.

ALTER TABLE oidc_identities
    ADD COLUMN normalized_email_at_link text,
    ADD COLUMN link_source text,
    ADD COLUMN activation_invitation_id uuid;

UPDATE oidc_identities identity
SET normalized_email_at_link = account.normalized_email,
    link_source = 'preexisting'
FROM users account
WHERE account.id = identity.user_id;

ALTER TABLE oidc_identities
    ALTER COLUMN normalized_email_at_link SET NOT NULL,
    ALTER COLUMN link_source SET NOT NULL,
    ADD CONSTRAINT oidc_identities_uuid_v7_check CHECK (
        (get_byte(uuid_send(id), 6) >> 4) = 7
        AND (get_byte(uuid_send(id), 8) & 192) = 128
    ),
    ADD CONSTRAINT oidc_identities_user_provider_unique UNIQUE(user_id, provider_id),
    ADD CONSTRAINT oidc_identities_link_source_check
        CHECK(
            (link_source = 'preexisting' AND activation_invitation_id IS NULL)
            OR (link_source = 'invitation' AND activation_invitation_id IS NOT NULL)
        ),
    ADD CONSTRAINT oidc_identities_activation_invitation_unique
        UNIQUE(activation_invitation_id),
    ADD CONSTRAINT oidc_identities_activation_invitation_fk
        FOREIGN KEY(activation_invitation_id, normalized_email_at_link)
        REFERENCES activation_invitations(id, normalized_email)
        ON DELETE RESTRICT,
    ADD CONSTRAINT oidc_identities_link_email_check CHECK (
        normalized_email_at_link = lower(btrim(normalized_email_at_link))
        AND normalized_email_at_link !~ '[[:cntrl:]]'
        AND char_length(normalized_email_at_link) BETWEEN 3 AND 320
    );

CREATE FUNCTION enforce_oidc_identity_update() RETURNS trigger
LANGUAGE plpgsql AS $$
BEGIN
    IF NEW.id IS DISTINCT FROM OLD.id
       OR NEW.user_id IS DISTINCT FROM OLD.user_id
       OR NEW.provider_id IS DISTINCT FROM OLD.provider_id
       OR NEW.subject IS DISTINCT FROM OLD.subject
       OR NEW.linked_at IS DISTINCT FROM OLD.linked_at
       OR NEW.normalized_email_at_link IS DISTINCT FROM OLD.normalized_email_at_link
       OR NEW.link_source IS DISTINCT FROM OLD.link_source
       OR NEW.activation_invitation_id IS DISTINCT FROM OLD.activation_invitation_id THEN
        RAISE EXCEPTION 'OIDC identity binding is immutable';
    END IF;
    RETURN NEW;
END;
$$;

CREATE FUNCTION enforce_oidc_identity_insert() RETURNS trigger
LANGUAGE plpgsql AS $$
BEGIN
    IF NOT EXISTS(
        SELECT 1 FROM users account
        WHERE account.id=NEW.user_id
          AND account.status='active'
          AND account.normalized_email=NEW.normalized_email_at_link
    ) THEN
        RAISE EXCEPTION 'OIDC identity must bind an active account with the verified email';
    END IF;
    IF NEW.link_source='invitation' AND NOT EXISTS(
        SELECT 1 FROM activation_invitations invitation
        WHERE invitation.id=NEW.activation_invitation_id
          AND invitation.normalized_email=NEW.normalized_email_at_link
          AND invitation.status='accepted'
    ) THEN
        RAISE EXCEPTION 'OIDC invitation identity requires an accepted invitation';
    END IF;
    RETURN NEW;
END;
$$;

CREATE TRIGGER oidc_identities_insert_guard
BEFORE INSERT ON oidc_identities
FOR EACH ROW EXECUTE FUNCTION enforce_oidc_identity_insert();

CREATE TRIGGER oidc_identities_update_guard
BEFORE UPDATE ON oidc_identities
FOR EACH ROW EXECUTE FUNCTION enforce_oidc_identity_update();

CREATE FUNCTION enforce_oidc_identity_unlink() RETURNS trigger
LANGUAGE plpgsql AS $$
DECLARE
    target_is_admin boolean;
    target_usable_after boolean;
BEGIN
    -- Serialize the instance-wide administrator/credential safety predicate.
    PERFORM pg_advisory_xact_lock(1330200900, 0);
    SELECT is_instance_admin INTO target_is_admin FROM users WHERE id=OLD.user_id FOR UPDATE;
    SELECT EXISTS(SELECT 1 FROM local_password_credentials WHERE user_id=OLD.user_id)
        OR EXISTS(
            SELECT 1 FROM oidc_identities other_identity
            JOIN oidc_providers provider ON provider.id=other_identity.provider_id
            WHERE other_identity.user_id=OLD.user_id AND other_identity.id<>OLD.id
              AND provider.status='active'
        ) INTO target_usable_after;
    IF NOT target_usable_after THEN
        RAISE EXCEPTION 'cannot remove the last usable credential';
    END IF;
    IF target_is_admin AND NOT EXISTS(
        SELECT 1 FROM users administrator
        WHERE administrator.status='active' AND administrator.is_instance_admin
          AND (
            EXISTS(SELECT 1 FROM local_password_credentials local
                   WHERE local.user_id=administrator.id)
            OR EXISTS(
                SELECT 1 FROM oidc_identities identity
                JOIN oidc_providers provider ON provider.id=identity.provider_id
                WHERE identity.user_id=administrator.id AND provider.status='active'
                  AND identity.id<>OLD.id
            )
          )
    ) THEN
        RAISE EXCEPTION 'cannot remove the last usable administrator credential';
    END IF;
    INSERT INTO oidc_identity_unlink_tombstones
        (provider_id,subject_hash,generation,last_unlinked_at)
    VALUES(
        OLD.provider_id,
        sha256(convert_to(OLD.subject, 'UTF8')),
        1,
        transaction_timestamp()
    )
    ON CONFLICT(provider_id,subject_hash) DO UPDATE
       SET generation=oidc_identity_unlink_tombstones.generation+1,
           last_unlinked_at=transaction_timestamp();
    RETURN OLD;
END;
$$;

CREATE TRIGGER oidc_identities_unlink_guard
BEFORE DELETE ON oidc_identities
FOR EACH ROW EXECUTE FUNCTION enforce_oidc_identity_unlink();

-- A successful unlink is a durable generation fence. Only a digest of the
-- external subject is retained, so a callback created before the unlink
-- cannot recreate the binding from its verified-email claim.
CREATE TABLE oidc_identity_unlink_tombstones (
    provider_id uuid NOT NULL,
    subject_hash bytea NOT NULL,
    generation bigint NOT NULL DEFAULT 1,
    last_unlinked_at timestamptz NOT NULL DEFAULT CURRENT_TIMESTAMP,
    PRIMARY KEY(provider_id, subject_hash),
    CONSTRAINT oidc_identity_unlink_tombstones_provider_fk
        FOREIGN KEY(provider_id) REFERENCES oidc_providers(id) ON DELETE RESTRICT,
    CONSTRAINT oidc_identity_unlink_tombstones_subject_hash_check
        CHECK(octet_length(subject_hash) = 32),
    CONSTRAINT oidc_identity_unlink_tombstones_generation_check
        CHECK(generation >= 1)
);

CREATE FUNCTION enforce_oidc_unlink_tombstone_update() RETURNS trigger
LANGUAGE plpgsql AS $$
BEGIN
    IF NEW.provider_id IS DISTINCT FROM OLD.provider_id
       OR NEW.subject_hash IS DISTINCT FROM OLD.subject_hash
       OR NEW.generation <> OLD.generation + 1
       OR NEW.last_unlinked_at < OLD.last_unlinked_at THEN
        RAISE EXCEPTION 'OIDC unlink tombstone transition is invalid';
    END IF;
    RETURN NEW;
END;
$$;

CREATE TRIGGER oidc_identity_unlink_tombstones_update_guard
BEFORE UPDATE ON oidc_identity_unlink_tombstones
FOR EACH ROW EXECUTE FUNCTION enforce_oidc_unlink_tombstone_update();

CREATE FUNCTION protect_oidc_unlink_tombstone_delete() RETURNS trigger
LANGUAGE plpgsql AS $$
BEGIN
    RAISE EXCEPTION 'OIDC unlink tombstones cannot be deleted';
END;
$$;

CREATE TRIGGER oidc_identity_unlink_tombstones_delete_guard
BEFORE DELETE ON oidc_identity_unlink_tombstones
FOR EACH ROW EXECUTE FUNCTION protect_oidc_unlink_tombstone_delete();

-- Provider disable participates in the same instance-wide safety fence as
-- unlink. Excluding the provider being disabled must still leave at least one
-- active administrator with a usable local or active OIDC credential.
CREATE FUNCTION enforce_oidc_provider_disable_admin_safety() RETURNS trigger
LANGUAGE plpgsql AS $$
BEGIN
    IF OLD.status = 'active' AND NEW.status = 'disabled' THEN
        PERFORM pg_advisory_xact_lock(1330200900, 0);
        IF NOT EXISTS(
            SELECT 1
            FROM users administrator
            WHERE administrator.status = 'active'
              AND administrator.is_instance_admin
              AND (
                  EXISTS(
                      SELECT 1 FROM local_password_credentials local
                      WHERE local.user_id = administrator.id
                  )
                  OR EXISTS(
                      SELECT 1
                      FROM oidc_identities identity
                      JOIN oidc_providers provider ON provider.id = identity.provider_id
                      WHERE identity.user_id = administrator.id
                        AND provider.status = 'active'
                        AND provider.id <> NEW.id
                  )
              )
        ) THEN
            RAISE EXCEPTION 'cannot disable the last usable administrator provider';
        END IF;
    END IF;
    RETURN NEW;
END;
$$;

CREATE TRIGGER oidc_providers_disable_admin_safety_guard
BEFORE UPDATE ON oidc_providers
FOR EACH ROW EXECUTE FUNCTION enforce_oidc_provider_disable_admin_safety();
