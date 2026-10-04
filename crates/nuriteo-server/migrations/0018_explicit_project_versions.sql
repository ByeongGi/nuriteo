-- Durable idempotency and source-fence metadata for explicit immutable
-- Project Versions. Raw Idempotency-Key values never enter PostgreSQL.

ALTER TABLE project_bundle_refs
    ADD COLUMN idempotency_digest bytea,
    ADD COLUMN source_project_version bigint;

-- The reference table existed before the product API. Preserve any
-- migration-only Version rows with deterministic identities that production
-- requests cannot derive from a client key.
UPDATE project_bundle_refs
SET idempotency_digest = decode(md5(id::text) || md5('legacy-version:' || id::text), 'hex'),
    source_project_version = 1
WHERE kind = 'version';

ALTER TABLE project_bundle_refs
    DROP CONSTRAINT project_bundle_refs_shape_check,
    ADD CONSTRAINT project_bundle_refs_idempotency_digest_check
        CHECK (idempotency_digest IS NULL OR octet_length(idempotency_digest) = 32),
    ADD CONSTRAINT project_bundle_refs_source_project_version_check
        CHECK (
            source_project_version IS NULL
            OR source_project_version BETWEEN 1 AND 9223372036854775806
        ),
    ADD CONSTRAINT project_bundle_refs_shape_check
        CHECK (
            (
                kind = 'recovery'
                AND recovery_position BETWEEN 1 AND 3
                AND version_name IS NULL
                AND idempotency_digest IS NULL
                AND source_project_version IS NULL
            )
            OR (
                kind = 'version'
                AND recovery_position IS NULL
                AND version_name IS NOT NULL
                AND version_name = btrim(version_name)
                AND version_name !~ '[[:cntrl:]]'
                AND char_length(version_name) BETWEEN 1 AND 200
                AND idempotency_digest IS NOT NULL
                AND octet_length(idempotency_digest) = 32
                AND source_project_version IS NOT NULL
                AND source_project_version BETWEEN 1 AND 9223372036854775806
            )
        );

CREATE UNIQUE INDEX project_bundle_refs_version_idempotency_unique
    ON project_bundle_refs (project_id, actor_user_id, idempotency_digest)
    WHERE kind = 'version';

CREATE INDEX project_bundle_refs_version_page_idx
    ON project_bundle_refs (project_id, created_at DESC, id DESC)
    WHERE kind = 'version';
