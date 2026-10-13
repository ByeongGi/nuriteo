-- Forward-only hardening for the NOT-002 replicated SMTP delivery worker.

ALTER TABLE email_outbox
    ADD CONSTRAINT email_outbox_lease_owner_check
        CHECK (
            lease_owner IS NULL
            OR lease_owner ~ '^[0-9a-f]{8}-[0-9a-f]{4}-7[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$'
        ),
    ADD CONSTRAINT email_outbox_lease_time_check
        CHECK (state <> 'sending' OR lease_expires_at > updated_at);
