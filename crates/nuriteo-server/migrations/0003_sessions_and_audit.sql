-- Session and audit persistence. Only token digests are stored in sessions;
-- audit metadata is bounded, structured and must be redacted by its writer.

CREATE TABLE sessions (
    id uuid PRIMARY KEY,
    user_id uuid NOT NULL,
    token_hash bytea NOT NULL,
    created_at timestamptz NOT NULL DEFAULT CURRENT_TIMESTAMP,
    last_seen_at timestamptz NOT NULL DEFAULT CURRENT_TIMESTAMP,
    idle_expires_at timestamptz NOT NULL,
    absolute_expires_at timestamptz NOT NULL,
    last_reauthenticated_at timestamptz,
    rotated_at timestamptz,
    revoked_at timestamptz,
    revocation_reason text,
    replaced_by_session_id uuid,
    CONSTRAINT sessions_token_hash_unique UNIQUE (token_hash),
    CONSTRAINT sessions_user_fk
        FOREIGN KEY (user_id) REFERENCES users (id) ON DELETE RESTRICT,
    CONSTRAINT sessions_replacement_fk
        FOREIGN KEY (replaced_by_session_id) REFERENCES sessions (id) ON DELETE RESTRICT,
    CONSTRAINT sessions_token_hash_check
        CHECK (octet_length(token_hash) = 32),
    CONSTRAINT sessions_expiry_check
        CHECK (
            last_seen_at >= created_at
            AND idle_expires_at > last_seen_at
            AND absolute_expires_at > created_at
            AND idle_expires_at <= absolute_expires_at
        ),
    CONSTRAINT sessions_reauthentication_check
        CHECK (
            last_reauthenticated_at IS NULL
            OR (
                last_reauthenticated_at >= created_at
                AND last_reauthenticated_at <= last_seen_at
            )
        ),
    CONSTRAINT sessions_revocation_check
        CHECK (
            (revoked_at IS NULL AND revocation_reason IS NULL)
            OR (
                revoked_at IS NOT NULL
                AND revoked_at >= created_at
                AND revocation_reason ~ '^[a-z][a-z0-9_.-]{0,63}$'
            )
        ),
    CONSTRAINT sessions_rotation_check
        CHECK (
            (rotated_at IS NULL AND replaced_by_session_id IS NULL)
            OR (
                rotated_at IS NOT NULL
                AND rotated_at >= created_at
                AND revoked_at IS NOT NULL
                AND replaced_by_session_id IS NOT NULL
                AND replaced_by_session_id <> id
            )
        )
);

CREATE INDEX sessions_active_user_idx
    ON sessions (user_id, idle_expires_at, absolute_expires_at)
    WHERE revoked_at IS NULL;
CREATE INDEX sessions_idle_expiry_idx
    ON sessions (idle_expires_at)
    WHERE revoked_at IS NULL;
CREATE INDEX sessions_absolute_expiry_idx
    ON sessions (absolute_expires_at)
    WHERE revoked_at IS NULL;
CREATE INDEX sessions_revoked_at_idx
    ON sessions (revoked_at)
    WHERE revoked_at IS NOT NULL;
CREATE INDEX sessions_replacement_idx
    ON sessions (replaced_by_session_id)
    WHERE replaced_by_session_id IS NOT NULL;

CREATE TABLE audit_events (
    id uuid PRIMARY KEY,
    occurred_at timestamptz NOT NULL DEFAULT CURRENT_TIMESTAMP,
    actor_type text NOT NULL,
    actor_id text NOT NULL,
    actor_user_id uuid,
    actor_display_name text,
    action_code text NOT NULL,
    target_type text NOT NULL,
    target_id text NOT NULL,
    scope_type text NOT NULL,
    scope_id text NOT NULL,
    result text NOT NULL,
    reason_code text,
    correlation_id text NOT NULL,
    source_ip inet,
    schema_version integer NOT NULL DEFAULT 1,
    changed_fields text[] NOT NULL DEFAULT '{}',
    metadata jsonb NOT NULL DEFAULT '{}'::jsonb,
    CONSTRAINT audit_events_actor_user_fk
        FOREIGN KEY (actor_user_id) REFERENCES users (id) ON DELETE SET NULL,
    CONSTRAINT audit_events_actor_type_check
        CHECK (actor_type IN ('user', 'system', 'bootstrap', 'background_job', 'cli')),
    CONSTRAINT audit_events_actor_id_check
        CHECK (char_length(btrim(actor_id)) BETWEEN 1 AND 200),
    CONSTRAINT audit_events_actor_display_name_check
        CHECK (
            actor_display_name IS NULL
            OR char_length(btrim(actor_display_name)) BETWEEN 1 AND 200
        ),
    CONSTRAINT audit_events_action_code_check
        CHECK (action_code ~ '^[a-z][a-z0-9_.-]{0,127}$'),
    CONSTRAINT audit_events_target_check
        CHECK (
            target_type ~ '^[a-z][a-z0-9_.-]{0,63}$'
            AND char_length(btrim(target_id)) BETWEEN 1 AND 200
        ),
    CONSTRAINT audit_events_scope_check
        CHECK (
            scope_type IN ('instance', 'workspace', 'organization', 'project', 'user')
            AND char_length(btrim(scope_id)) BETWEEN 1 AND 200
        ),
    CONSTRAINT audit_events_result_check
        CHECK (result IN ('succeeded', 'denied', 'failed')),
    CONSTRAINT audit_events_reason_code_check
        CHECK (
            reason_code IS NULL
            OR reason_code ~ '^[A-Z][A-Z0-9_]{0,63}$'
        ),
    CONSTRAINT audit_events_correlation_id_check
        CHECK (correlation_id ~ '^[A-Za-z0-9._:-]{1,128}$'),
    CONSTRAINT audit_events_schema_version_check
        CHECK (schema_version BETWEEN 1 AND 2147483647),
    CONSTRAINT audit_events_changed_fields_check
        CHECK (cardinality(changed_fields) <= 64),
    CONSTRAINT audit_events_metadata_check
        CHECK (
            jsonb_typeof(metadata) = 'object'
            AND octet_length(metadata::text) <= 16384
        )
);

CREATE INDEX audit_events_occurred_at_idx
    ON audit_events (occurred_at DESC, id DESC);
CREATE INDEX audit_events_actor_idx
    ON audit_events (actor_type, actor_id, occurred_at DESC);
CREATE INDEX audit_events_action_idx
    ON audit_events (action_code, occurred_at DESC);
CREATE INDEX audit_events_target_idx
    ON audit_events (target_type, target_id, occurred_at DESC);
CREATE INDEX audit_events_scope_idx
    ON audit_events (scope_type, scope_id, occurred_at DESC);
CREATE INDEX audit_events_result_idx
    ON audit_events (result, occurred_at DESC);
CREATE INDEX audit_events_correlation_idx
    ON audit_events (correlation_id);
