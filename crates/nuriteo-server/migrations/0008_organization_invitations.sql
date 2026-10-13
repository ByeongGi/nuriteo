-- Organization-scoped invitations for existing active users. Bearer credentials
-- are persisted only as fixed-size SHA-256 digests and lifecycle is forward-only.

CREATE TABLE organization_invitations (
    id uuid PRIMARY KEY,
    organization_id uuid NOT NULL,
    invitee_user_id uuid NOT NULL,
    normalized_email text NOT NULL,
    invited_by_user_id uuid NOT NULL,
    proposed_role text NOT NULL,
    status text NOT NULL DEFAULT 'pending',
    token_hash bytea NOT NULL,
    created_at timestamptz NOT NULL DEFAULT CURRENT_TIMESTAMP,
    expires_at timestamptz NOT NULL,
    accepted_at timestamptz,
    declined_at timestamptz,
    expired_at timestamptz,
    revoked_at timestamptz,
    superseded_at timestamptz,
    replaced_by_invitation_id uuid,
    CONSTRAINT organization_invitations_identity_scope_unique
        UNIQUE (id, organization_id, invitee_user_id),
    CONSTRAINT organization_invitations_id_v7_check
        CHECK (
            substring(id::text FROM 15 FOR 1) = '7'
            AND substring(id::text FROM 20 FOR 1) IN ('8', '9', 'a', 'b')
        ),
    CONSTRAINT organization_invitations_organization_fk
        FOREIGN KEY (organization_id) REFERENCES organizations (id) ON DELETE RESTRICT,
    CONSTRAINT organization_invitations_invitee_fk
        FOREIGN KEY (invitee_user_id) REFERENCES users (id) ON DELETE RESTRICT,
    CONSTRAINT organization_invitations_inviter_fk
        FOREIGN KEY (invited_by_user_id) REFERENCES users (id) ON DELETE RESTRICT,
    CONSTRAINT organization_invitations_replacement_fk
        FOREIGN KEY (replaced_by_invitation_id, organization_id, invitee_user_id)
        REFERENCES organization_invitations (id, organization_id, invitee_user_id)
        ON DELETE RESTRICT DEFERRABLE INITIALLY DEFERRED,
    CONSTRAINT organization_invitations_normalized_email_check
        CHECK (
            normalized_email = lower(btrim(normalized_email))
            AND normalized_email !~ '[[:cntrl:]]'
            AND char_length(normalized_email) BETWEEN 3 AND 320
        ),
    CONSTRAINT organization_invitations_role_check
        CHECK (proposed_role IN ('owner', 'member')),
    CONSTRAINT organization_invitations_status_check
        CHECK (status IN ('pending', 'accepted', 'declined', 'expired', 'revoked', 'superseded')),
    CONSTRAINT organization_invitations_token_hash_unique UNIQUE (token_hash),
    CONSTRAINT organization_invitations_token_hash_check
        CHECK (octet_length(token_hash) = 32),
    CONSTRAINT organization_invitations_expiry_check
        CHECK (
            expires_at >= created_at + INTERVAL '1 hour'
            AND expires_at <= created_at + INTERVAL '30 days'
        ),
    CONSTRAINT organization_invitations_lifecycle_check
        CHECK (
            (
                status = 'pending'
                AND accepted_at IS NULL AND declined_at IS NULL
                AND expired_at IS NULL AND revoked_at IS NULL
                AND superseded_at IS NULL AND replaced_by_invitation_id IS NULL
            )
            OR (
                status = 'accepted'
                AND accepted_at IS NOT NULL
                AND accepted_at >= created_at AND accepted_at < expires_at
                AND declined_at IS NULL AND expired_at IS NULL
                AND revoked_at IS NULL AND superseded_at IS NULL
                AND replaced_by_invitation_id IS NULL
            )
            OR (
                status = 'declined'
                AND declined_at IS NOT NULL
                AND declined_at >= created_at AND declined_at < expires_at
                AND accepted_at IS NULL AND expired_at IS NULL
                AND revoked_at IS NULL AND superseded_at IS NULL
                AND replaced_by_invitation_id IS NULL
            )
            OR (
                status = 'expired'
                AND expired_at IS NOT NULL AND expired_at >= expires_at
                AND accepted_at IS NULL AND declined_at IS NULL
                AND revoked_at IS NULL AND superseded_at IS NULL
                AND replaced_by_invitation_id IS NULL
            )
            OR (
                status = 'revoked'
                AND revoked_at IS NOT NULL
                AND revoked_at >= created_at AND revoked_at < expires_at
                AND accepted_at IS NULL AND declined_at IS NULL
                AND expired_at IS NULL AND superseded_at IS NULL
                AND replaced_by_invitation_id IS NULL
            )
            OR (
                status = 'superseded'
                AND superseded_at IS NOT NULL
                AND superseded_at >= created_at AND superseded_at < expires_at
                AND accepted_at IS NULL AND declined_at IS NULL
                AND expired_at IS NULL AND revoked_at IS NULL
                AND replaced_by_invitation_id IS NOT NULL
                AND replaced_by_invitation_id <> id
            )
        )
);

CREATE UNIQUE INDEX organization_invitations_one_pending_invitee_idx
    ON organization_invitations (organization_id, invitee_user_id)
    WHERE status = 'pending';
CREATE INDEX organization_invitations_pending_expiry_idx
    ON organization_invitations (expires_at, id)
    WHERE status = 'pending';
CREATE INDEX organization_invitations_invitee_idx
    ON organization_invitations (invitee_user_id, created_at DESC);
CREATE INDEX organization_invitations_inviter_idx
    ON organization_invitations (invited_by_user_id, created_at DESC);
CREATE INDEX organization_invitations_replacement_idx
    ON organization_invitations (replaced_by_invitation_id)
    WHERE replaced_by_invitation_id IS NOT NULL;

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
        OR NEW.token_hash IS DISTINCT FROM OLD.token_hash
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

    RETURN NEW;
END;
$$;

CREATE TRIGGER organization_invitations_forward_only_update
    BEFORE UPDATE ON organization_invitations
    FOR EACH ROW
    EXECUTE FUNCTION enforce_organization_invitation_update();
