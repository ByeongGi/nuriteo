-- MFA enforcement projections. The canonical policy values remain in the
-- versioned instance_settings registry; this migration owns only atomic policy
-- reconciliation and per-user enrollment deadlines.

CREATE TABLE mfa_policy_state (
    singleton boolean PRIMARY KEY DEFAULT TRUE,
    lock_version bigint NOT NULL DEFAULT 1,
    updated_at timestamptz NOT NULL DEFAULT CURRENT_TIMESTAMP,
    CONSTRAINT mfa_policy_state_singleton_check CHECK (singleton),
    CONSTRAINT mfa_policy_state_version_check CHECK (lock_version BETWEEN 1 AND 9223372036854775806)
);

INSERT INTO mfa_policy_state(singleton) VALUES(TRUE);

CREATE TABLE mfa_enrollment_requirements (
    user_id uuid PRIMARY KEY,
    policy_mode text NOT NULL,
    required_since timestamptz NOT NULL,
    deadline_at timestamptz NOT NULL,
    notification_id uuid NOT NULL UNIQUE,
    created_at timestamptz NOT NULL DEFAULT CURRENT_TIMESTAMP,
    updated_at timestamptz NOT NULL DEFAULT CURRENT_TIMESTAMP,
    CONSTRAINT mfa_enrollment_requirements_user_fk
        FOREIGN KEY(user_id) REFERENCES users(id) ON DELETE RESTRICT,
    CONSTRAINT mfa_enrollment_requirements_notification_fk
        FOREIGN KEY(notification_id) REFERENCES notifications(id) ON DELETE RESTRICT,
    CONSTRAINT mfa_enrollment_requirements_mode_check
        CHECK(policy_mode IN ('administrators', 'all_local_users')),
    CONSTRAINT mfa_enrollment_requirements_time_check
        CHECK(required_since <= deadline_at AND created_at >= required_since AND updated_at >= created_at)
);

CREATE INDEX mfa_enrollment_requirements_deadline_idx
    ON mfa_enrollment_requirements(deadline_at, user_id);

-- Short-lived encrypted receipts make browser retries deterministic even when
-- the first committed response (including a rotated cookie or recovery codes)
-- is lost in transit. Request attestations and ciphertext are domain-separated
-- under the configured master key; no MFA or session secret is stored in clear.
CREATE TABLE mfa_operation_receipts (
    id uuid PRIMARY KEY,
    user_id uuid NOT NULL,
    session_binding bytea NOT NULL,
    rotated_session_binding bytea,
    operation text NOT NULL,
    idempotency_key text NOT NULL,
    request_key_version integer NOT NULL,
    request_attestation bytea NOT NULL,
    response_key_version integer NOT NULL,
    response_nonce bytea NOT NULL,
    response_ciphertext bytea NOT NULL,
    expires_at timestamptz NOT NULL,
    created_at timestamptz NOT NULL DEFAULT CURRENT_TIMESTAMP,
    CONSTRAINT mfa_operation_receipts_user_fk
        FOREIGN KEY(user_id) REFERENCES users(id) ON DELETE RESTRICT,
    CONSTRAINT mfa_operation_receipts_uuid_v7_check
        CHECK(uuid_extract_version(id)=7),
    CONSTRAINT mfa_operation_receipts_binding_check
        CHECK(octet_length(session_binding)=32
          AND (rotated_session_binding IS NULL OR octet_length(rotated_session_binding)=32)
          AND (rotated_session_binding IS NULL OR rotated_session_binding<>session_binding)),
    CONSTRAINT mfa_operation_receipts_operation_check
        CHECK(operation IN ('begin','confirm','challenge','recovery')),
    CONSTRAINT mfa_operation_receipts_rotation_check
        CHECK((operation='begin' AND rotated_session_binding IS NULL)
          OR (operation IN ('confirm','challenge','recovery') AND rotated_session_binding IS NOT NULL)),
    CONSTRAINT mfa_operation_receipts_key_check
        CHECK(length(idempotency_key) BETWEEN 16 AND 128 AND idempotency_key ~ '^[A-Za-z0-9._:-]+$'),
    CONSTRAINT mfa_operation_receipts_crypto_check
        CHECK(request_key_version > 0 AND octet_length(request_attestation)=32
          AND response_key_version > 0 AND octet_length(response_nonce)=12
          AND octet_length(response_ciphertext) BETWEEN 17 AND 65536),
    CONSTRAINT mfa_operation_receipts_expiry_check
        CHECK(expires_at > created_at AND expires_at <= created_at + interval '30 minutes'),
    CONSTRAINT mfa_operation_receipts_unique
        UNIQUE(session_binding, operation, idempotency_key)
);

CREATE INDEX mfa_operation_receipts_expiry_idx
    ON mfa_operation_receipts(expires_at, id);

CREATE UNIQUE INDEX mfa_operation_receipts_rotated_unique_idx
    ON mfa_operation_receipts(rotated_session_binding, operation, idempotency_key)
    WHERE rotated_session_binding IS NOT NULL;
