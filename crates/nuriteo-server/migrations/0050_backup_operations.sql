-- Administrator-owned backup policy and a durable operation queue. Workers
-- claim rows with SKIP LOCKED; the HTTP boundary never performs long-running
-- backup I/O inside a browser request.

CREATE TABLE backup_policy (
    singleton boolean PRIMARY KEY DEFAULT TRUE CHECK (singleton),
    enabled boolean NOT NULL DEFAULT TRUE,
    interval_hours integer NOT NULL DEFAULT 24,
    schedule_time time NOT NULL DEFAULT TIME '02:00:00',
    schedule_timezone text NOT NULL DEFAULT 'UTC',
    daily_retention integer DEFAULT 7,
    weekly_retention integer DEFAULT 4,
    monthly_retention integer DEFAULT 6,
    failed_retention_days integer NOT NULL DEFAULT 7,
    multipart_cleanup_hours integer NOT NULL DEFAULT 24,
    warning_after_hours integer NOT NULL DEFAULT 24,
    critical_after_failures integer NOT NULL DEFAULT 3,
    drill_frequency text NOT NULL DEFAULT 'monthly',
    drill_time time NOT NULL DEFAULT TIME '03:00:00',
    drill_timezone text NOT NULL DEFAULT 'UTC',
    lock_version bigint NOT NULL DEFAULT 1,
    updated_at timestamptz NOT NULL DEFAULT CURRENT_TIMESTAMP,
    CONSTRAINT backup_policy_timezone_check CHECK (
        octet_length(schedule_timezone) BETWEEN 1 AND 128
        AND octet_length(drill_timezone) BETWEEN 1 AND 128
        AND schedule_timezone = btrim(schedule_timezone)
        AND drill_timezone = btrim(drill_timezone)
        AND schedule_timezone !~ '[[:cntrl:]]'
        AND drill_timezone !~ '[[:cntrl:]]'
    ),
    CONSTRAINT backup_policy_retention_check CHECK (
        interval_hours BETWEEN 1 AND 168
        AND (daily_retention IS NULL OR daily_retention BETWEEN 0 AND 365)
        AND (weekly_retention IS NULL OR weekly_retention BETWEEN 0 AND 104)
        AND (monthly_retention IS NULL OR monthly_retention BETWEEN 0 AND 120)
        AND failed_retention_days BETWEEN 1 AND 90
        AND multipart_cleanup_hours BETWEEN 1 AND 168
    ),
    CONSTRAINT backup_policy_alert_check CHECK (
        warning_after_hours BETWEEN 1 AND 720
        AND critical_after_failures BETWEEN 1 AND 100
    ),
    CONSTRAINT backup_policy_drill_check CHECK (
        drill_frequency IN ('off', 'weekly', 'monthly', 'quarterly')
    ),
    CONSTRAINT backup_policy_version_check CHECK (lock_version > 0)
);

INSERT INTO backup_policy(singleton) VALUES (TRUE);

CREATE TABLE backup_operations (
    id uuid PRIMARY KEY,
    kind text NOT NULL,
    source text NOT NULL,
    backup_id uuid REFERENCES backup_generations(id) ON DELETE RESTRICT,
    state text NOT NULL DEFAULT 'queued',
    requested_by uuid REFERENCES users(id) ON DELETE SET NULL,
    failure_code text,
    requested_at timestamptz NOT NULL DEFAULT CURRENT_TIMESTAMP,
    started_at timestamptz,
    completed_at timestamptz,
    CONSTRAINT backup_operations_id_v7_check CHECK (
        (get_byte(uuid_send(id), 6) >> 4) = 7
        AND (get_byte(uuid_send(id), 8) & 192) = 128
    ),
    CONSTRAINT backup_operations_kind_check CHECK (
        kind IN ('create', 'verify', 'drill', 'prune')
    ),
    CONSTRAINT backup_operations_source_check CHECK (
        source IN ('manual', 'schedule')
    ),
    CONSTRAINT backup_operations_target_check CHECK (
        (kind = 'verify' AND backup_id IS NOT NULL)
        OR (kind <> 'verify' AND backup_id IS NULL)
    ),
    CONSTRAINT backup_operations_state_check CHECK (
        state IN ('queued', 'running', 'succeeded', 'failed', 'cancelled')
    ),
    CONSTRAINT backup_operations_failure_check CHECK (
        failure_code IS NULL OR (
            octet_length(failure_code) BETWEEN 1 AND 128
            AND failure_code ~ '^[a-z][a-z0-9_]*$'
        )
    ),
    CONSTRAINT backup_operations_terminal_check CHECK (
        (state = 'queued' AND started_at IS NULL AND completed_at IS NULL AND failure_code IS NULL)
        OR (state = 'running' AND started_at IS NOT NULL AND completed_at IS NULL AND failure_code IS NULL)
        OR (state = 'succeeded' AND started_at IS NOT NULL AND completed_at IS NOT NULL AND failure_code IS NULL)
        OR (state = 'failed' AND started_at IS NOT NULL AND completed_at IS NOT NULL AND failure_code IS NOT NULL)
        OR (state = 'cancelled' AND completed_at IS NOT NULL AND failure_code IS NULL)
    ),
    CONSTRAINT backup_operations_timestamps_check CHECK (
        (started_at IS NULL OR started_at >= requested_at)
        AND (completed_at IS NULL OR completed_at >= requested_at)
        AND (completed_at IS NULL OR started_at IS NULL OR completed_at >= started_at)
    )
);

CREATE UNIQUE INDEX backup_operations_one_active_idx
    ON backup_operations ((TRUE)) WHERE state IN ('queued', 'running');
CREATE INDEX backup_operations_history_idx
    ON backup_operations (requested_at DESC, id DESC);

CREATE FUNCTION enforce_backup_operation_transition() RETURNS trigger
LANGUAGE plpgsql AS $$
BEGIN
    IF NEW.id IS DISTINCT FROM OLD.id OR NEW.kind IS DISTINCT FROM OLD.kind
       OR NEW.source IS DISTINCT FROM OLD.source
       OR NEW.backup_id IS DISTINCT FROM OLD.backup_id
       OR NEW.requested_by IS DISTINCT FROM OLD.requested_by
       OR NEW.requested_at IS DISTINCT FROM OLD.requested_at THEN
        RAISE EXCEPTION 'backup operation identity is immutable' USING ERRCODE='23514';
    END IF;
    IF OLD.state = 'queued' AND NEW.state NOT IN ('queued', 'running', 'cancelled')
       OR OLD.state = 'running' AND NEW.state NOT IN ('running', 'succeeded', 'failed')
       OR OLD.state IN ('succeeded', 'failed', 'cancelled') AND NEW.state IS DISTINCT FROM OLD.state THEN
        RAISE EXCEPTION 'invalid backup operation state transition' USING ERRCODE='23514';
    END IF;
    RETURN NEW;
END;
$$;

CREATE TRIGGER backup_operations_transition_guard
BEFORE UPDATE ON backup_operations
FOR EACH ROW EXECUTE FUNCTION enforce_backup_operation_transition();
