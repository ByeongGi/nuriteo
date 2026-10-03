-- Bounded per-user accounting for failed local-password authentication.
-- Unknown identifiers and raw authentication material are never persisted.

CREATE TABLE local_auth_failures (
    user_id uuid PRIMARY KEY,
    failure_count smallint NOT NULL,
    window_started_at timestamptz NOT NULL,
    last_failed_at timestamptz NOT NULL,
    locked_at timestamptz,
    locked_until timestamptz,
    updated_at timestamptz NOT NULL,
    CONSTRAINT local_auth_failures_user_fk
        FOREIGN KEY (user_id) REFERENCES users (id) ON DELETE RESTRICT,
    CONSTRAINT local_auth_failures_count_check
        CHECK (failure_count BETWEEN 1 AND 20),
    CONSTRAINT local_auth_failures_window_check
        CHECK (
            last_failed_at >= window_started_at
            AND updated_at >= window_started_at
            AND updated_at >= last_failed_at
        ),
    CONSTRAINT local_auth_failures_lock_pair_check
        CHECK ((locked_at IS NULL) = (locked_until IS NULL)),
    CONSTRAINT local_auth_failures_lock_bounds_check
        CHECK (
            locked_at IS NULL
            OR (
                failure_count >= 3
                AND locked_at >= window_started_at
                AND locked_at <= last_failed_at
                AND locked_until > locked_at
                AND updated_at >= locked_at
            )
        )
);

CREATE INDEX local_auth_failures_locked_until_idx
    ON local_auth_failures (locked_until)
    WHERE locked_until IS NOT NULL;
