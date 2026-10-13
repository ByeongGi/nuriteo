-- User notification channel preferences and bounded administrator mutation
-- receipts. Delivery payloads remain owned by the existing outbox tables.

CREATE TABLE notification_email_preferences (
    user_id uuid PRIMARY KEY REFERENCES users(id) ON DELETE RESTRICT,
    account_access boolean NOT NULL DEFAULT TRUE,
    collaboration boolean NOT NULL DEFAULT FALSE,
    operations boolean NOT NULL DEFAULT FALSE,
    lock_version bigint NOT NULL DEFAULT 1,
    created_at timestamptz NOT NULL DEFAULT CURRENT_TIMESTAMP,
    updated_at timestamptz NOT NULL DEFAULT CURRENT_TIMESTAMP,
    CONSTRAINT notification_email_preferences_version_check
        CHECK(lock_version BETWEEN 1 AND 9223372036854775806),
    CONSTRAINT notification_email_preferences_time_check CHECK(updated_at >= created_at)
);

CREATE FUNCTION enforce_notification_email_preference_update() RETURNS trigger
LANGUAGE plpgsql AS $$
BEGIN
    IF NEW.user_id IS DISTINCT FROM OLD.user_id OR NEW.created_at IS DISTINCT FROM OLD.created_at THEN
        RAISE EXCEPTION 'notification preference identity cannot change' USING ERRCODE='23514';
    END IF;
    IF NEW.lock_version <> OLD.lock_version + 1 OR NEW.updated_at < OLD.updated_at THEN
        RAISE EXCEPTION 'notification preference version transition is invalid' USING ERRCODE='23514';
    END IF;
    RETURN NEW;
END;
$$;

CREATE TRIGGER notification_email_preferences_update_guard
BEFORE UPDATE ON notification_email_preferences
FOR EACH ROW EXECUTE FUNCTION enforce_notification_email_preference_update();

CREATE FUNCTION serialize_notification_email_preference_mutation() RETURNS trigger
LANGUAGE plpgsql AS $$
DECLARE
    affected_user_id uuid;
BEGIN
    affected_user_id := CASE WHEN TG_OP='DELETE' THEN OLD.user_id ELSE NEW.user_id END;
    PERFORM pg_advisory_xact_lock(1330200902, hashtext(affected_user_id::text));
    IF TG_OP='DELETE' THEN
        RETURN OLD;
    END IF;
    RETURN NEW;
END;
$$;

CREATE TRIGGER notification_email_preferences_serialization_guard
BEFORE INSERT OR UPDATE OR DELETE ON notification_email_preferences
FOR EACH ROW EXECUTE FUNCTION serialize_notification_email_preference_mutation();

CREATE TABLE notification_admin_operation_receipts (
    actor_user_id uuid NOT NULL REFERENCES users(id) ON DELETE RESTRICT,
    idempotency_key text NOT NULL,
    operation text NOT NULL,
    target_email_outbox_id uuid NOT NULL REFERENCES email_outbox(id) ON DELETE RESTRICT,
    result_email_outbox_id uuid REFERENCES email_outbox(id) ON DELETE RESTRICT,
    created_at timestamptz NOT NULL DEFAULT CURRENT_TIMESTAMP,
    expires_at timestamptz NOT NULL DEFAULT (CURRENT_TIMESTAMP + INTERVAL '30 minutes'),
    PRIMARY KEY(actor_user_id,idempotency_key),
    CONSTRAINT notification_admin_receipt_key_check
        CHECK(length(idempotency_key) BETWEEN 16 AND 128 AND idempotency_key ~ '^[A-Za-z0-9._:-]+$'),
    CONSTRAINT notification_admin_receipt_operation_check
        CHECK((operation='retry' AND result_email_outbox_id IS NOT NULL)
           OR (operation='cancel' AND result_email_outbox_id IS NULL)),
    CONSTRAINT notification_admin_receipt_expiry_check
        CHECK(expires_at > created_at AND expires_at <= created_at + INTERVAL '30 minutes')
);

CREATE INDEX notification_admin_operation_receipts_expiry_idx
    ON notification_admin_operation_receipts(expires_at,actor_user_id);
