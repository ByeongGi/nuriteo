-- PostgreSQL becomes the source of truth after the first complete Instance
-- setting materialization. Values are allowlisted and validated by the same
-- versioned Rust registry used by the admin API.

CREATE TABLE instance_settings (
    key text PRIMARY KEY,
    registry_version smallint NOT NULL,
    value jsonb NOT NULL,
    bootstrap_origin text NOT NULL,
    lock_version bigint NOT NULL DEFAULT 1,
    created_at timestamptz NOT NULL DEFAULT CURRENT_TIMESTAMP,
    updated_at timestamptz NOT NULL DEFAULT CURRENT_TIMESTAMP,
    CONSTRAINT instance_settings_key_check CHECK (
        key = lower(key)
        AND length(key) BETWEEN 3 AND 128
        AND key ~ '^[a-z][a-z0-9_]*(\.[a-z][a-z0-9_]*)+$'
    ),
    CONSTRAINT instance_settings_registry_version_check CHECK (
        registry_version BETWEEN 1 AND 32767
    ),
    CONSTRAINT instance_settings_bootstrap_origin_check CHECK (
        bootstrap_origin IN ('default', 'file', 'environment')
    ),
    CONSTRAINT instance_settings_lock_version_check CHECK (lock_version >= 1),
    CONSTRAINT instance_settings_timestamp_order_check CHECK (updated_at >= created_at)
);

CREATE INDEX instance_settings_registry_version_idx
    ON instance_settings (registry_version, key);
