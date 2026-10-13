-- One-attempt invitation delivery credentials. A delivery retry may rotate the
-- digest only while the invitation remains pending; every rotation advances an
-- append-only generation so raw SQL cannot replace a digest without leaving an
-- observable forward-only transition.

ALTER TABLE activation_invitations
    ADD COLUMN delivery_token_generation bigint NOT NULL DEFAULT 0,
    ADD CONSTRAINT activation_invitations_delivery_token_generation_check
        CHECK (delivery_token_generation >= 0);

ALTER TABLE organization_invitations
    ADD COLUMN delivery_token_generation bigint NOT NULL DEFAULT 0,
    ADD CONSTRAINT organization_invitations_delivery_token_generation_check
        CHECK (delivery_token_generation >= 0);

CREATE OR REPLACE FUNCTION enforce_activation_invitation_update()
RETURNS trigger
LANGUAGE plpgsql
AS $$
BEGIN
    IF NEW.id IS DISTINCT FROM OLD.id
        OR NEW.normalized_email IS DISTINCT FROM OLD.normalized_email
        OR NEW.invited_by_user_id IS DISTINCT FROM OLD.invited_by_user_id
        OR NEW.created_at IS DISTINCT FROM OLD.created_at
        OR NEW.expires_at IS DISTINCT FROM OLD.expires_at
    THEN
        RAISE EXCEPTION 'activation invitation immutable fields cannot change'
            USING ERRCODE = '23514';
    END IF;

    IF OLD.status <> 'pending' AND NEW IS DISTINCT FROM OLD THEN
        RAISE EXCEPTION 'terminal activation invitation cannot change'
            USING ERRCODE = '23514';
    END IF;

    IF NEW.token_hash IS DISTINCT FROM OLD.token_hash
        OR NEW.delivery_token_generation IS DISTINCT FROM OLD.delivery_token_generation
    THEN
        IF OLD.status <> 'pending'
            OR NEW.status <> 'pending'
            OR NEW.expires_at <= transaction_timestamp()
            OR NEW.token_hash IS NOT DISTINCT FROM OLD.token_hash
            OR NEW.delivery_token_generation <> OLD.delivery_token_generation + 1
        THEN
            RAISE EXCEPTION 'activation invitation delivery credential rotation is invalid'
                USING ERRCODE = '23514';
        END IF;
    END IF;

    RETURN NEW;
END;
$$;

CREATE OR REPLACE FUNCTION enforce_organization_invitation_update()
RETURNS trigger
LANGUAGE plpgsql
AS $$
BEGIN
    IF NEW.id IS DISTINCT FROM OLD.id
        OR NEW.organization_id IS DISTINCT FROM OLD.organization_id
        OR NEW.invitee_user_id IS DISTINCT FROM OLD.invitee_user_id
        OR NEW.normalized_email IS DISTINCT FROM OLD.normalized_email
        OR NEW.invited_by_user_id IS DISTINCT FROM OLD.invited_by_user_id
        OR NEW.proposed_role IS DISTINCT FROM OLD.proposed_role
        OR NEW.created_at IS DISTINCT FROM OLD.created_at
        OR NEW.expires_at IS DISTINCT FROM OLD.expires_at
    THEN
        RAISE EXCEPTION 'organization invitation immutable fields cannot change'
            USING ERRCODE = '23514';
    END IF;

    IF OLD.status <> 'pending' AND NEW IS DISTINCT FROM OLD THEN
        RAISE EXCEPTION 'terminal organization invitation cannot change'
            USING ERRCODE = '23514';
    END IF;

    IF NEW.token_hash IS DISTINCT FROM OLD.token_hash
        OR NEW.delivery_token_generation IS DISTINCT FROM OLD.delivery_token_generation
    THEN
        IF OLD.status <> 'pending'
            OR NEW.status <> 'pending'
            OR NEW.expires_at <= transaction_timestamp()
            OR NEW.token_hash IS NOT DISTINCT FROM OLD.token_hash
            OR NEW.delivery_token_generation <> OLD.delivery_token_generation + 1
        THEN
            RAISE EXCEPTION 'organization invitation delivery credential rotation is invalid'
                USING ERRCODE = '23514';
        END IF;
    END IF;

    RETURN NEW;
END;
$$;
