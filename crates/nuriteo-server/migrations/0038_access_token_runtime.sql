-- Shared, replica-safe runtime state for API token authentication, usage,
-- weighted rate limiting and mutation idempotency.

ALTER TABLE access_tokens
    ADD COLUMN last_used_at timestamptz,
    ADD COLUMN last_api_category text;

ALTER TABLE access_tokens ADD CONSTRAINT access_tokens_usage_check CHECK (
    (last_used_at IS NULL AND last_api_category IS NULL)
    OR (last_used_at >= created_at AND last_api_category IN ('read','write','save','integration'))
);

CREATE TABLE access_token_source_ips (
    token_id uuid NOT NULL REFERENCES access_tokens(id) ON DELETE CASCADE,
    source_ip inet NOT NULL,
    last_seen_at timestamptz NOT NULL DEFAULT CURRENT_TIMESTAMP,
    PRIMARY KEY(token_id,source_ip)
);

CREATE INDEX access_token_source_ips_recency_idx
    ON access_token_source_ips(token_id,last_seen_at DESC,source_ip);

CREATE TABLE api_rate_limit_buckets (
    subject_kind text NOT NULL,
    subject_id uuid NOT NULL,
    source_ip inet,
    window_started_at timestamptz NOT NULL,
    used_points integer NOT NULL,
    updated_at timestamptz NOT NULL DEFAULT CURRENT_TIMESTAMP,
    PRIMARY KEY(subject_kind,subject_id,window_started_at),
    CONSTRAINT api_rate_limit_subject_check CHECK (subject_kind IN ('principal','token')),
    CONSTRAINT api_rate_limit_points_check CHECK (used_points BETWEEN 1 AND 1000000),
    CONSTRAINT api_rate_limit_window_check CHECK (
        window_started_at=date_trunc('minute',window_started_at) AND updated_at>=window_started_at
    )
);

CREATE INDEX api_rate_limit_buckets_cleanup_idx
    ON api_rate_limit_buckets(window_started_at,subject_kind,subject_id);

CREATE TABLE api_idempotency_receipts (
    principal_id uuid NOT NULL,
    token_id uuid NOT NULL REFERENCES access_tokens(id) ON DELETE CASCADE,
    method text NOT NULL,
    canonical_route text NOT NULL,
    idempotency_key text NOT NULL,
    request_fingerprint bytea NOT NULL,
    state text NOT NULL DEFAULT 'processing',
    response_status integer,
    response_body jsonb,
    created_at timestamptz NOT NULL DEFAULT CURRENT_TIMESTAMP,
    completed_at timestamptz,
    expires_at timestamptz NOT NULL DEFAULT (CURRENT_TIMESTAMP + INTERVAL '24 hours'),
    PRIMARY KEY(principal_id,method,canonical_route,idempotency_key),
    CONSTRAINT api_idempotency_method_check CHECK (method IN ('POST','PATCH','PUT')),
    CONSTRAINT api_idempotency_route_check CHECK (
        canonical_route LIKE '/api/v1/%' AND char_length(canonical_route) BETWEEN 9 AND 512
    ),
    CONSTRAINT api_idempotency_key_check CHECK (
        char_length(idempotency_key) BETWEEN 16 AND 255
        AND idempotency_key !~ '[[:cntrl:][:space:]]'
    ),
    CONSTRAINT api_idempotency_fingerprint_check CHECK (octet_length(request_fingerprint)=32),
    CONSTRAINT api_idempotency_state_check CHECK (state IN ('processing','completed')),
    CONSTRAINT api_idempotency_result_check CHECK (
        (state='processing' AND response_status IS NULL AND response_body IS NULL AND completed_at IS NULL)
        OR (state='completed' AND response_status BETWEEN 200 AND 599 AND response_body IS NOT NULL
            AND completed_at IS NOT NULL)
    ),
    CONSTRAINT api_idempotency_response_bound_check CHECK (
        response_body IS NULL OR octet_length(response_body::text)<=1048576
    ),
    CONSTRAINT api_idempotency_time_check CHECK (
        expires_at=created_at+INTERVAL '24 hours'
        AND (completed_at IS NULL OR completed_at>=created_at)
    )
);

CREATE INDEX api_idempotency_receipts_expiry_idx
    ON api_idempotency_receipts(expires_at,principal_id,idempotency_key);

CREATE FUNCTION enforce_api_idempotency_receipt_update() RETURNS trigger
LANGUAGE plpgsql AS $$
BEGIN
    IF NEW.principal_id IS DISTINCT FROM OLD.principal_id
       OR NEW.token_id IS DISTINCT FROM OLD.token_id
       OR NEW.method IS DISTINCT FROM OLD.method
       OR NEW.canonical_route IS DISTINCT FROM OLD.canonical_route
       OR NEW.idempotency_key IS DISTINCT FROM OLD.idempotency_key
       OR NEW.request_fingerprint IS DISTINCT FROM OLD.request_fingerprint
       OR NEW.created_at IS DISTINCT FROM OLD.created_at
       OR NEW.expires_at IS DISTINCT FROM OLD.expires_at
       OR OLD.state='completed'
       OR NOT (OLD.state='processing' AND NEW.state='completed') THEN
        RAISE EXCEPTION 'idempotency receipt transition is invalid' USING ERRCODE='23514';
    END IF;
    RETURN NEW;
END;
$$;

CREATE TRIGGER api_idempotency_receipts_update_guard
BEFORE UPDATE ON api_idempotency_receipts
FOR EACH ROW EXECUTE FUNCTION enforce_api_idempotency_receipt_update();

CREATE FUNCTION reject_api_idempotency_receipt_truncate() RETURNS trigger
LANGUAGE plpgsql AS $$ BEGIN
    RAISE EXCEPTION 'idempotency receipts cannot be truncated' USING ERRCODE='23514';
END; $$;

CREATE TRIGGER api_idempotency_receipts_no_truncate
BEFORE TRUNCATE ON api_idempotency_receipts
FOR EACH STATEMENT EXECUTE FUNCTION reject_api_idempotency_receipt_truncate();
