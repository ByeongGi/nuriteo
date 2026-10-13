-- User inbox projection and transactional email outbox. SMTP delivery is
-- intentionally performed after commit; this schema only records durable work.

CREATE OR REPLACE FUNCTION notification_payload_has_sensitive_key(value jsonb, depth integer DEFAULT 0)
RETURNS boolean
LANGUAGE plpgsql
IMMUTABLE
STRICT
AS $$
DECLARE
    item record;
    element jsonb;
BEGIN
    IF depth > 8 THEN
        RETURN true;
    END IF;
    IF jsonb_typeof(value) = 'object' THEN
        FOR item IN SELECT key, child FROM jsonb_each(value) AS entry(key, child)
        LOOP
            IF lower(item.key) ~ '(^|[._-])(authorization|cookie|credential|password|secret|session|token|totp|recovery[._-]?codes?|activation[._-]?url|fallback[._-]?url)($|[._-])'
                OR lower(regexp_replace(item.key, '[._-]', '', 'g')) ~ '(authorization|cookie|credential|password|secret|session|token|totp|recoverycodes?|activationurl|fallbackurl)'
                OR notification_payload_has_sensitive_key(item.child, depth + 1)
            THEN
                RETURN true;
            END IF;
        END LOOP;
    ELSIF jsonb_typeof(value) = 'array' THEN
        FOR element IN SELECT child FROM jsonb_array_elements(value) AS child
        LOOP
            IF notification_payload_has_sensitive_key(element, depth + 1) THEN
                RETURN true;
            END IF;
        END LOOP;
    END IF;
    RETURN false;
END;
$$;

CREATE OR REPLACE FUNCTION notification_payload_node_count(value jsonb, depth integer DEFAULT 0)
RETURNS integer
LANGUAGE plpgsql
IMMUTABLE
STRICT
AS $$
DECLARE
    child jsonb;
    child_count integer;
    total integer := 1;
BEGIN
    IF depth > 8 THEN
        RETURN 257;
    END IF;
    IF jsonb_typeof(value) = 'object' THEN
        FOR child IN SELECT entry.value FROM jsonb_each(value) AS entry
        LOOP
            child_count := notification_payload_node_count(child, depth + 1);
            total := total + child_count;
            IF total > 256 THEN
                RETURN total;
            END IF;
        END LOOP;
    ELSIF jsonb_typeof(value) = 'array' THEN
        FOR child IN SELECT element FROM jsonb_array_elements(value) AS element
        LOOP
            child_count := notification_payload_node_count(child, depth + 1);
            total := total + child_count;
            IF total > 256 THEN
                RETURN total;
            END IF;
        END LOOP;
    END IF;
    RETURN total;
END;
$$;

-- PostgreSQL's jsonb::text adds presentation whitespace after separators,
-- while serde_json uses compact JSON. Count the exact compact UTF-8 form so
-- the domain admission and database constraint share the same 16 KiB bound.
CREATE OR REPLACE FUNCTION notification_payload_compact_octets(value jsonb, depth integer DEFAULT 0)
RETURNS bigint
LANGUAGE plpgsql
IMMUTABLE
STRICT
AS $$
DECLARE
    item record;
    element jsonb;
    total bigint;
    item_count integer := 0;
BEGIN
    IF depth > 8 THEN
        RETURN 16385;
    END IF;
    IF jsonb_typeof(value) = 'object' THEN
        total := 2;
        FOR item IN SELECT key, child FROM jsonb_each(value) AS entry(key, child)
        LOOP
            IF item_count > 0 THEN
                total := total + 1;
            END IF;
            total := total
                + octet_length(to_jsonb(item.key)::text)
                + 1
                + notification_payload_compact_octets(item.child, depth + 1);
            item_count := item_count + 1;
            IF total > 16384 THEN
                RETURN total;
            END IF;
        END LOOP;
        RETURN total;
    ELSIF jsonb_typeof(value) = 'array' THEN
        total := 2;
        FOR element IN SELECT child FROM jsonb_array_elements(value) AS child
        LOOP
            IF item_count > 0 THEN
                total := total + 1;
            END IF;
            total := total + notification_payload_compact_octets(element, depth + 1);
            item_count := item_count + 1;
            IF total > 16384 THEN
                RETURN total;
            END IF;
        END LOOP;
        RETURN total;
    END IF;
    RETURN octet_length(value::text);
END;
$$;

CREATE OR REPLACE FUNCTION notification_payload_values_bounded(value jsonb, depth integer DEFAULT 0)
RETURNS boolean
LANGUAGE plpgsql
IMMUTABLE
STRICT
AS $$
DECLARE
    child jsonb;
BEGIN
    IF depth > 8 THEN
        RETURN false;
    END IF;
    IF jsonb_typeof(value) = 'string' THEN
        RETURN octet_length(value #>> '{}') <= 4096;
    ELSIF jsonb_typeof(value) = 'object' THEN
        FOR child IN SELECT entry.value FROM jsonb_each(value) AS entry
        LOOP
            IF NOT notification_payload_values_bounded(child, depth + 1) THEN
                RETURN false;
            END IF;
        END LOOP;
    ELSIF jsonb_typeof(value) = 'array' THEN
        FOR child IN SELECT element FROM jsonb_array_elements(value) AS element
        LOOP
            IF NOT notification_payload_values_bounded(child, depth + 1) THEN
                RETURN false;
            END IF;
        END LOOP;
    END IF;
    RETURN true;
END;
$$;

CREATE TABLE notifications (
    id uuid PRIMARY KEY,
    recipient_user_id uuid NOT NULL,
    classification text NOT NULL,
    event_code text NOT NULL,
    template_id text NOT NULL,
    locale text NOT NULL,
    resource_type text NOT NULL,
    resource_id text NOT NULL,
    rendering_data jsonb NOT NULL DEFAULT '{}'::jsonb,
    status text NOT NULL DEFAULT 'unread',
    action_state text NOT NULL DEFAULT 'none',
    resolved_at timestamptz,
    occurrence_count integer NOT NULL DEFAULT 1,
    first_occurred_at timestamptz NOT NULL,
    last_occurred_at timestamptz NOT NULL,
    created_at timestamptz NOT NULL DEFAULT CURRENT_TIMESTAMP,
    updated_at timestamptz NOT NULL DEFAULT CURRENT_TIMESTAMP,
    lock_version bigint NOT NULL DEFAULT 1,
    CONSTRAINT notifications_id_v7_check
        CHECK (
            substring(id::text FROM 15 FOR 1) = '7'
            AND substring(id::text FROM 20 FOR 1) IN ('8', '9', 'a', 'b')
        ),
    CONSTRAINT notifications_recipient_fk
        FOREIGN KEY (recipient_user_id) REFERENCES users (id) ON DELETE RESTRICT,
    CONSTRAINT notifications_identity_unique UNIQUE (id, recipient_user_id),
    CONSTRAINT notifications_classification_check
        CHECK (classification IN ('critical_security', 'account_access', 'collaboration', 'operations')),
    CONSTRAINT notifications_event_code_check
        CHECK (event_code ~ '^[a-z][a-z0-9_.-]{0,127}$'),
    CONSTRAINT notifications_template_id_check
        CHECK (template_id ~ '^[a-z][a-z0-9_.-]{0,127}$'),
    CONSTRAINT notifications_locale_check
        CHECK (locale ~ '^[A-Za-z]{2,3}(-[A-Za-z0-9]{2,8}){0,2}$'),
    CONSTRAINT notifications_resource_check
        CHECK (
            resource_type ~ '^[a-z][a-z0-9_.-]{0,63}$'
            AND char_length(btrim(resource_id)) BETWEEN 1 AND 200
        ),
    CONSTRAINT notifications_rendering_data_check
        CHECK (
            jsonb_typeof(rendering_data) = 'object'
            AND notification_payload_compact_octets(rendering_data) <= 16384
            AND notification_payload_values_bounded(rendering_data)
            AND notification_payload_node_count(rendering_data) <= 256
            AND NOT notification_payload_has_sensitive_key(rendering_data)
        ),
    CONSTRAINT notifications_status_check
        CHECK (status IN ('unread', 'read', 'archived')),
    CONSTRAINT notifications_action_state_check
        CHECK (
            (action_state IN ('none', 'pending') AND resolved_at IS NULL)
            OR (action_state IN ('resolved', 'canceled') AND resolved_at IS NOT NULL)
        ),
    CONSTRAINT notifications_occurrence_check
        CHECK (occurrence_count BETWEEN 1 AND 2147483647),
    CONSTRAINT notifications_time_check
        CHECK (
            first_occurred_at <= last_occurred_at
            AND created_at >= first_occurred_at
            AND updated_at >= created_at
            AND updated_at >= last_occurred_at
            AND (resolved_at IS NULL OR resolved_at >= first_occurred_at)
        ),
    CONSTRAINT notifications_lock_version_check
        CHECK (lock_version BETWEEN 1 AND 9223372036854775806)
);

CREATE INDEX notifications_inbox_idx
    ON notifications (recipient_user_id, status, last_occurred_at DESC, id DESC);
CREATE INDEX notifications_unread_idx
    ON notifications (recipient_user_id, last_occurred_at DESC, id DESC)
    WHERE status = 'unread';
CREATE INDEX notifications_retention_idx
    ON notifications (classification, created_at, id)
    WHERE action_state <> 'pending';
CREATE INDEX notifications_resource_idx
    ON notifications (resource_type, resource_id, recipient_user_id);

CREATE TABLE email_outbox (
    id uuid PRIMARY KEY,
    notification_id uuid,
    recipient_user_id uuid,
    recipient_email text NOT NULL,
    classification text NOT NULL,
    template_id text NOT NULL,
    locale text NOT NULL,
    resource_type text NOT NULL,
    resource_id text NOT NULL,
    rendering_data jsonb NOT NULL DEFAULT '{}'::jsonb,
    state text NOT NULL DEFAULT 'pending',
    attempt_count smallint NOT NULL DEFAULT 0,
    available_at timestamptz NOT NULL DEFAULT CURRENT_TIMESTAMP,
    first_attempt_at timestamptz,
    last_attempt_at timestamptz,
    sent_at timestamptz,
    lease_owner text,
    lease_expires_at timestamptz,
    last_smtp_code integer,
    last_error_class text,
    created_at timestamptz NOT NULL DEFAULT CURRENT_TIMESTAMP,
    updated_at timestamptz NOT NULL DEFAULT CURRENT_TIMESTAMP,
    lock_version bigint NOT NULL DEFAULT 1,
    CONSTRAINT email_outbox_id_v7_check
        CHECK (
            substring(id::text FROM 15 FOR 1) = '7'
            AND substring(id::text FROM 20 FOR 1) IN ('8', '9', 'a', 'b')
        ),
    CONSTRAINT email_outbox_notification_recipient_fk
        FOREIGN KEY (notification_id, recipient_user_id)
        REFERENCES notifications (id, recipient_user_id)
        ON DELETE SET NULL (notification_id, recipient_user_id),
    CONSTRAINT email_outbox_notification_shape_check
        CHECK (
            (notification_id IS NULL AND recipient_user_id IS NULL)
            OR (notification_id IS NOT NULL AND recipient_user_id IS NOT NULL)
        ),
    CONSTRAINT email_outbox_recipient_check
        CHECK (
            recipient_email = lower(btrim(recipient_email))
            AND char_length(recipient_email) BETWEEN 3 AND 320
            AND recipient_email ~ '^[^[:space:]@]+@[^[:space:]@]+$'
        ),
    CONSTRAINT email_outbox_classification_check
        CHECK (classification IN ('critical_security', 'account_access', 'collaboration', 'operations')),
    CONSTRAINT email_outbox_template_id_check
        CHECK (template_id ~ '^[a-z][a-z0-9_.-]{0,127}$'),
    CONSTRAINT email_outbox_locale_check
        CHECK (locale ~ '^[A-Za-z]{2,3}(-[A-Za-z0-9]{2,8}){0,2}$'),
    CONSTRAINT email_outbox_resource_check
        CHECK (
            resource_type ~ '^[a-z][a-z0-9_.-]{0,63}$'
            AND char_length(btrim(resource_id)) BETWEEN 1 AND 200
        ),
    CONSTRAINT email_outbox_rendering_data_check
        CHECK (
            jsonb_typeof(rendering_data) = 'object'
            AND notification_payload_compact_octets(rendering_data) <= 16384
            AND notification_payload_values_bounded(rendering_data)
            AND notification_payload_node_count(rendering_data) <= 256
            AND NOT notification_payload_has_sensitive_key(rendering_data)
        ),
    CONSTRAINT email_outbox_state_check
        CHECK (state IN ('pending', 'sending', 'retry_wait', 'sent', 'dead_letter', 'canceled')),
    CONSTRAINT email_outbox_attempt_count_check
        CHECK (attempt_count BETWEEN 0 AND 8),
    CONSTRAINT email_outbox_attempt_time_check
        CHECK (
            (attempt_count = 0 AND first_attempt_at IS NULL AND last_attempt_at IS NULL)
            OR (
                attempt_count > 0
                AND first_attempt_at IS NOT NULL
                AND last_attempt_at IS NOT NULL
                AND first_attempt_at >= created_at
                AND last_attempt_at >= first_attempt_at
                AND last_attempt_at <= updated_at
            )
        ),
    CONSTRAINT email_outbox_state_attempt_check
        CHECK (
            (state = 'pending' AND attempt_count = 0)
            OR (state IN ('sending', 'retry_wait', 'sent', 'dead_letter') AND attempt_count > 0)
            OR state = 'canceled'
        ),
    CONSTRAINT email_outbox_retry_schedule_check
        CHECK (state <> 'retry_wait' OR available_at >= updated_at),
    CONSTRAINT email_outbox_lease_check
        CHECK (
            (state = 'sending' AND lease_owner IS NOT NULL AND lease_expires_at IS NOT NULL)
            OR (state <> 'sending' AND lease_owner IS NULL AND lease_expires_at IS NULL)
        ),
    CONSTRAINT email_outbox_sent_check
        CHECK (
            (
                state = 'sent'
                AND sent_at IS NOT NULL
                AND attempt_count > 0
                AND sent_at >= last_attempt_at
                AND last_smtp_code BETWEEN 200 AND 299
            )
            OR (state <> 'sent' AND sent_at IS NULL)
        ),
    CONSTRAINT email_outbox_smtp_code_check
        CHECK (last_smtp_code IS NULL OR last_smtp_code BETWEEN 100 AND 599),
    CONSTRAINT email_outbox_error_class_check
        CHECK (
            (last_error_class IS NULL OR last_error_class IN ('transient', 'permanent', 'ambiguous'))
            AND (state NOT IN ('retry_wait', 'dead_letter') OR last_error_class IS NOT NULL)
            AND (state <> 'pending' OR (last_error_class IS NULL AND last_smtp_code IS NULL))
        ),
    CONSTRAINT email_outbox_time_check
        CHECK (updated_at >= created_at AND available_at >= created_at),
    CONSTRAINT email_outbox_lock_version_check
        CHECK (lock_version BETWEEN 1 AND 9223372036854775806)
);

CREATE INDEX email_outbox_claim_idx
    ON email_outbox (available_at, id)
    WHERE state IN ('pending', 'retry_wait');
CREATE INDEX email_outbox_lease_recovery_idx
    ON email_outbox (lease_expires_at, id)
    WHERE state = 'sending';
CREATE INDEX email_outbox_dead_letter_idx
    ON email_outbox (updated_at DESC, id DESC)
    WHERE state = 'dead_letter';
CREATE INDEX email_outbox_notification_idx
    ON email_outbox (notification_id)
    WHERE notification_id IS NOT NULL;

CREATE OR REPLACE FUNCTION enforce_notification_update()
RETURNS trigger
LANGUAGE plpgsql
AS $$
BEGIN
    IF NEW.id IS DISTINCT FROM OLD.id
        OR NEW.recipient_user_id IS DISTINCT FROM OLD.recipient_user_id
        OR NEW.classification IS DISTINCT FROM OLD.classification
        OR NEW.event_code IS DISTINCT FROM OLD.event_code
        OR NEW.template_id IS DISTINCT FROM OLD.template_id
        OR NEW.locale IS DISTINCT FROM OLD.locale
        OR NEW.resource_type IS DISTINCT FROM OLD.resource_type
        OR NEW.resource_id IS DISTINCT FROM OLD.resource_id
        OR NEW.first_occurred_at IS DISTINCT FROM OLD.first_occurred_at
        OR NEW.created_at IS DISTINCT FROM OLD.created_at
    THEN
        RAISE EXCEPTION 'notification identity fields cannot change' USING ERRCODE = '23514';
    END IF;
    IF NEW.occurrence_count < OLD.occurrence_count
        OR NEW.last_occurred_at < OLD.last_occurred_at
        OR NEW.updated_at < OLD.updated_at
    THEN
        RAISE EXCEPTION 'notification history must be monotonic' USING ERRCODE = '23514';
    END IF;
    IF (NEW.occurrence_count IS DISTINCT FROM OLD.occurrence_count)
        <> (NEW.last_occurred_at IS DISTINCT FROM OLD.last_occurred_at)
    THEN
        RAISE EXCEPTION 'notification recurrence count and time must advance together' USING ERRCODE = '23514';
    END IF;
    IF NOT (
        NEW.action_state = OLD.action_state
        OR (OLD.action_state = 'none' AND NEW.action_state = 'pending')
        OR (OLD.action_state = 'pending' AND NEW.action_state IN ('resolved', 'canceled'))
    ) THEN
        RAISE EXCEPTION 'notification action transition is invalid' USING ERRCODE = '23514';
    END IF;
    IF OLD.action_state IN ('resolved', 'canceled')
        AND NEW.resolved_at IS DISTINCT FROM OLD.resolved_at
    THEN
        RAISE EXCEPTION 'terminal notification resolution is immutable' USING ERRCODE = '23514';
    END IF;
    IF NEW.lock_version <> OLD.lock_version + 1 THEN
        RAISE EXCEPTION 'notification update must advance lock version exactly once' USING ERRCODE = '23514';
    END IF;
    RETURN NEW;
END;
$$;

CREATE TRIGGER notifications_update_invariants
    BEFORE UPDATE ON notifications
    FOR EACH ROW EXECUTE FUNCTION enforce_notification_update();

CREATE OR REPLACE FUNCTION guard_notification_retention_delete()
RETURNS trigger
LANGUAGE plpgsql
AS $$
BEGIN
    IF EXISTS (
        SELECT 1
        FROM email_outbox
        WHERE notification_id = OLD.id
          AND state IN ('pending', 'sending', 'retry_wait')
    ) THEN
        RAISE EXCEPTION 'notification has active email delivery' USING ERRCODE = '23514';
    END IF;
    RETURN OLD;
END;
$$;

CREATE TRIGGER notifications_retention_delete_guard
    BEFORE DELETE ON notifications
    FOR EACH ROW EXECUTE FUNCTION guard_notification_retention_delete();

CREATE OR REPLACE FUNCTION enforce_email_outbox_insert()
RETURNS trigger
LANGUAGE plpgsql
AS $$
DECLARE
    linked notifications%ROWTYPE;
BEGIN
    IF NEW.state <> 'pending' THEN
        RAISE EXCEPTION 'new email outbox work must start pending' USING ERRCODE = '23514';
    END IF;
    IF NEW.notification_id IS NULL THEN
        RETURN NEW;
    END IF;
    SELECT * INTO linked
    FROM notifications
    WHERE id = NEW.notification_id
      AND recipient_user_id = NEW.recipient_user_id;
    IF NOT FOUND THEN
        RETURN NEW;
    END IF;
    IF NEW.classification IS DISTINCT FROM linked.classification
        OR NEW.template_id IS DISTINCT FROM linked.template_id
        OR NEW.locale IS DISTINCT FROM linked.locale
        OR NEW.resource_type IS DISTINCT FROM linked.resource_type
        OR NEW.resource_id IS DISTINCT FROM linked.resource_id
        OR NEW.rendering_data IS DISTINCT FROM linked.rendering_data
    THEN
        RAISE EXCEPTION 'email outbox message must match notification' USING ERRCODE = '23514';
    END IF;
    RETURN NEW;
END;
$$;

CREATE TRIGGER email_outbox_insert_invariants
    BEFORE INSERT ON email_outbox
    FOR EACH ROW EXECUTE FUNCTION enforce_email_outbox_insert();

CREATE OR REPLACE FUNCTION enforce_email_outbox_update()
RETURNS trigger
LANGUAGE plpgsql
AS $$
BEGIN
    -- The composite FK's SET NULL action is the sole permitted mutation of a
    -- terminal row. Its internal update is nested below the notification delete
    -- trigger; direct application updates run at trigger depth one.
    IF OLD.state IN ('sent', 'dead_letter', 'canceled') THEN
        IF pg_trigger_depth() > 1
            AND OLD.notification_id IS NOT NULL
            AND OLD.recipient_user_id IS NOT NULL
            AND NEW.notification_id IS NULL
            AND NEW.recipient_user_id IS NULL
            AND ROW(
                NEW.id, NEW.recipient_email, NEW.classification, NEW.template_id,
                NEW.locale, NEW.resource_type, NEW.resource_id, NEW.rendering_data,
                NEW.state, NEW.attempt_count, NEW.available_at, NEW.first_attempt_at,
                NEW.last_attempt_at, NEW.sent_at, NEW.lease_owner, NEW.lease_expires_at,
                NEW.last_smtp_code, NEW.last_error_class, NEW.created_at, NEW.updated_at,
                NEW.lock_version
            ) IS NOT DISTINCT FROM ROW(
                OLD.id, OLD.recipient_email, OLD.classification, OLD.template_id,
                OLD.locale, OLD.resource_type, OLD.resource_id, OLD.rendering_data,
                OLD.state, OLD.attempt_count, OLD.available_at, OLD.first_attempt_at,
                OLD.last_attempt_at, OLD.sent_at, OLD.lease_owner, OLD.lease_expires_at,
                OLD.last_smtp_code, OLD.last_error_class, OLD.created_at, OLD.updated_at,
                OLD.lock_version
            )
        THEN
            RETURN NEW;
        END IF;
        RAISE EXCEPTION 'terminal email outbox row is immutable' USING ERRCODE = '23514';
    END IF;
    IF NEW.id IS DISTINCT FROM OLD.id
        OR NEW.notification_id IS DISTINCT FROM OLD.notification_id
        OR NEW.recipient_user_id IS DISTINCT FROM OLD.recipient_user_id
        OR NEW.recipient_email IS DISTINCT FROM OLD.recipient_email
        OR NEW.classification IS DISTINCT FROM OLD.classification
        OR NEW.template_id IS DISTINCT FROM OLD.template_id
        OR NEW.locale IS DISTINCT FROM OLD.locale
        OR NEW.resource_type IS DISTINCT FROM OLD.resource_type
        OR NEW.resource_id IS DISTINCT FROM OLD.resource_id
        OR NEW.rendering_data IS DISTINCT FROM OLD.rendering_data
        OR NEW.created_at IS DISTINCT FROM OLD.created_at
    THEN
        RAISE EXCEPTION 'email outbox message fields cannot change' USING ERRCODE = '23514';
    END IF;
    IF NOT (
        NEW.state = OLD.state
        OR (OLD.state IN ('pending', 'retry_wait') AND NEW.state IN ('sending', 'canceled'))
        OR (OLD.state = 'retry_wait' AND NEW.state = 'dead_letter')
        OR (OLD.state = 'sending' AND NEW.state IN ('sent', 'retry_wait', 'dead_letter', 'canceled'))
    ) THEN
        RAISE EXCEPTION 'email outbox state transition is invalid' USING ERRCODE = '23514';
    END IF;
    IF NEW.attempt_count < OLD.attempt_count
        OR NEW.available_at < OLD.available_at
        OR NEW.updated_at < OLD.updated_at
        OR (OLD.first_attempt_at IS NOT NULL AND NEW.first_attempt_at IS DISTINCT FROM OLD.first_attempt_at)
        OR (OLD.last_attempt_at IS NOT NULL AND NEW.last_attempt_at < OLD.last_attempt_at)
    THEN
        RAISE EXCEPTION 'email outbox attempt history must be monotonic' USING ERRCODE = '23514';
    END IF;
    IF OLD.state IN ('pending', 'retry_wait') AND NEW.state = 'sending' THEN
        IF NEW.attempt_count <> OLD.attempt_count + 1
            OR NEW.last_attempt_at IS NULL
            OR (OLD.attempt_count = 0 AND NEW.first_attempt_at IS NULL)
            OR (OLD.attempt_count > 0 AND NEW.first_attempt_at IS DISTINCT FROM OLD.first_attempt_at)
        THEN
            RAISE EXCEPTION 'email outbox claim must record one attempt' USING ERRCODE = '23514';
        END IF;
    ELSIF NEW.attempt_count <> OLD.attempt_count THEN
        RAISE EXCEPTION 'email outbox attempt count changes only on claim' USING ERRCODE = '23514';
    END IF;
    IF NEW.lock_version <> OLD.lock_version + 1 THEN
        RAISE EXCEPTION 'email outbox update must advance lock version exactly once' USING ERRCODE = '23514';
    END IF;
    RETURN NEW;
END;
$$;

CREATE TRIGGER email_outbox_update_invariants
    BEFORE UPDATE ON email_outbox
    FOR EACH ROW EXECUTE FUNCTION enforce_email_outbox_update();
