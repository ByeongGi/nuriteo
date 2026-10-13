-- Fail-closed state entered after a restore without a verified Secret Recovery Kit.
-- The singleton is restored with the database and then updated by the restore
-- coordinator before the target can be promoted.

CREATE TABLE instance_recovery_state (
    singleton boolean PRIMARY KEY DEFAULT TRUE,
    state text NOT NULL DEFAULT 'normal',
    reason text,
    entered_at timestamptz,
    updated_at timestamptz NOT NULL DEFAULT CURRENT_TIMESTAMP,
    CONSTRAINT instance_recovery_state_singleton_check CHECK (singleton),
    CONSTRAINT instance_recovery_state_state_check CHECK (
        state IN ('normal', 'needs_reconfiguration')
    ),
    CONSTRAINT instance_recovery_state_reason_check CHECK (
        (state = 'normal' AND reason IS NULL AND entered_at IS NULL)
        OR
        (state = 'needs_reconfiguration'
         AND reason = 'missing_recovery_kit'
         AND entered_at IS NOT NULL)
    )
);

INSERT INTO instance_recovery_state(singleton) VALUES(TRUE);

CREATE FUNCTION reject_active_integration_during_recovery() RETURNS trigger
LANGUAGE plpgsql AS $$
BEGIN
    IF NEW.status = 'active' AND EXISTS (
        SELECT 1 FROM instance_recovery_state
        WHERE singleton AND state = 'needs_reconfiguration'
    ) THEN
        RAISE EXCEPTION 'integration activation is blocked during instance recovery'
            USING ERRCODE = '55000';
    END IF;
    RETURN NEW;
END;
$$;

CREATE TRIGGER oidc_recovery_activation_guard
BEFORE INSERT OR UPDATE OF status ON oidc_providers
FOR EACH ROW EXECUTE FUNCTION reject_active_integration_during_recovery();

CREATE TRIGGER git_recovery_activation_guard
BEFORE INSERT OR UPDATE OF status ON git_providers
FOR EACH ROW EXECUTE FUNCTION reject_active_integration_during_recovery();

CREATE TRIGGER registry_recovery_activation_guard
BEFORE INSERT OR UPDATE OF status ON registry_connections
FOR EACH ROW EXECUTE FUNCTION reject_active_integration_during_recovery();

CREATE FUNCTION reject_smtp_enable_during_recovery() RETURNS trigger
LANGUAGE plpgsql AS $$
BEGIN
    IF NEW.key = 'smtp.enabled' AND NEW.value = 'true'::jsonb AND EXISTS (
        SELECT 1 FROM instance_recovery_state
        WHERE singleton AND state = 'needs_reconfiguration'
    ) THEN
        RAISE EXCEPTION 'SMTP activation is blocked during instance recovery'
            USING ERRCODE = '55000';
    END IF;
    RETURN NEW;
END;
$$;

CREATE TRIGGER smtp_recovery_activation_guard
BEFORE INSERT OR UPDATE OF value ON instance_settings
FOR EACH ROW EXECUTE FUNCTION reject_smtp_enable_during_recovery();
