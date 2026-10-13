-- Replica-safe, privacy-preserving admission buckets for anonymous Public
-- Preview bindings. The Web tier supplies an HMAC-derived UUID; neither a
-- cookie value nor a network address is persisted.

CREATE TABLE public_preview_rate_limit_buckets (
    abuse_key uuid NOT NULL,
    public_id text NOT NULL,
    window_started_at timestamptz NOT NULL,
    used_bindings integer NOT NULL,
    updated_at timestamptz NOT NULL DEFAULT CURRENT_TIMESTAMP,
    PRIMARY KEY(abuse_key,public_id,window_started_at),
    CONSTRAINT public_preview_rate_limit_public_id_check CHECK (
        char_length(public_id)=43 AND public_id ~ '^[A-Za-z0-9_-]+$'
    ),
    CONSTRAINT public_preview_rate_limit_count_check CHECK (
        used_bindings BETWEEN 1 AND 120
    ),
    CONSTRAINT public_preview_rate_limit_window_check CHECK (
        window_started_at=date_trunc('minute',window_started_at)
        AND updated_at>=window_started_at
    )
);

CREATE INDEX public_preview_rate_limit_cleanup_idx
    ON public_preview_rate_limit_buckets(window_started_at,abuse_key,public_id);
