-- A backup generation must exist before the snapshot is exported so it can
-- globally fence object GC. The exporter records the real PostgreSQL snapshot
-- once, while the generation is still preparing, before copying may begin.

ALTER TABLE backup_generations
    ALTER COLUMN synchronized_snapshot_id DROP NOT NULL,
    ALTER COLUMN expected_object_count DROP NOT NULL,
    ALTER COLUMN expected_payload_bytes DROP NOT NULL,
    DROP CONSTRAINT backup_generations_snapshot_check,
    ADD CONSTRAINT backup_generations_snapshot_check CHECK (
        synchronized_snapshot_id IS NULL OR (
            octet_length(synchronized_snapshot_id) BETWEEN 1 AND 256
            AND synchronized_snapshot_id = btrim(synchronized_snapshot_id)
            AND synchronized_snapshot_id !~ '[[:cntrl:]]'
        )
    ),
    ADD CONSTRAINT backup_generations_snapshot_state_check CHECK (
        state IN ('preparing', 'failed') OR synchronized_snapshot_id IS NOT NULL
    ),
    ADD CONSTRAINT backup_generations_expectation_state_check CHECK (
        (expected_object_count IS NULL AND expected_payload_bytes IS NULL
            AND state IN ('preparing', 'failed'))
        OR (expected_object_count IS NOT NULL AND expected_payload_bytes IS NOT NULL)
    );

CREATE OR REPLACE FUNCTION enforce_backup_generation_transition() RETURNS trigger
LANGUAGE plpgsql AS $$
DECLARE
    actual_count bigint;
    actual_bytes bigint;
    database_count bigint;
BEGIN
    IF NEW.id IS DISTINCT FROM OLD.id
       OR NEW.format_version IS DISTINCT FROM OLD.format_version
       OR NEW.nuriteo_version IS DISTINCT FROM OLD.nuriteo_version
       OR NEW.schema_version IS DISTINCT FROM OLD.schema_version
       OR NEW.postgres_major IS DISTINCT FROM OLD.postgres_major
       OR NEW.backup_method IS DISTINCT FROM OLD.backup_method
       OR NEW.created_at IS DISTINCT FROM OLD.created_at
       OR NEW.updated_at < OLD.updated_at THEN
        RAISE EXCEPTION 'backup generation identity and expectations are immutable' USING ERRCODE='23514';
    END IF;
    IF OLD.expected_object_count IS NOT NULL AND (
        NEW.expected_object_count IS DISTINCT FROM OLD.expected_object_count
        OR NEW.expected_payload_bytes IS DISTINCT FROM OLD.expected_payload_bytes
    ) THEN
        RAISE EXCEPTION 'backup manifest expectations are immutable' USING ERRCODE='23514';
    END IF;
    IF OLD.expected_object_count IS NULL AND (
        NEW.expected_object_count IS NOT NULL OR NEW.expected_payload_bytes IS NOT NULL
    ) AND (
        NEW.expected_object_count IS NULL OR NEW.expected_payload_bytes IS NULL
        OR OLD.state <> 'preparing' OR NEW.state <> 'preparing'
    ) THEN
        RAISE EXCEPTION 'backup manifest expectations may only be assigned together while preparing' USING ERRCODE='23514';
    END IF;
    IF OLD.synchronized_snapshot_id IS NOT NULL
       AND NEW.synchronized_snapshot_id IS DISTINCT FROM OLD.synchronized_snapshot_id THEN
        RAISE EXCEPTION 'backup synchronized snapshot is immutable' USING ERRCODE='23514';
    END IF;
    IF OLD.synchronized_snapshot_id IS NULL
       AND NEW.synchronized_snapshot_id IS NOT NULL
       AND (OLD.state <> 'preparing' OR NEW.state <> 'preparing') THEN
        RAISE EXCEPTION 'backup synchronized snapshot may only be assigned while preparing' USING ERRCODE='23514';
    END IF;
    IF OLD.state = 'preparing' AND NEW.state NOT IN ('preparing', 'copying', 'failed')
       OR OLD.state = 'copying' AND NEW.state NOT IN ('copying', 'verifying', 'failed')
       OR OLD.state = 'verifying' AND NEW.state NOT IN ('verifying', 'complete', 'failed')
       OR OLD.state IN ('complete', 'failed') AND NEW.state IS DISTINCT FROM OLD.state THEN
        RAISE EXCEPTION 'invalid backup generation state transition' USING ERRCODE='23514';
    END IF;
    IF NEW.state = 'copying' AND (
        NEW.synchronized_snapshot_id IS NULL
        OR NEW.expected_object_count IS NULL
        OR NEW.expected_payload_bytes IS NULL
    ) THEN
        RAISE EXCEPTION 'backup copying requires synchronized snapshot and manifest expectations' USING ERRCODE='23514';
    END IF;
    IF OLD.prune_requested_at IS NOT NULL
       AND NEW.prune_requested_at IS DISTINCT FROM OLD.prune_requested_at THEN
        RAISE EXCEPTION 'backup prune marker is immutable' USING ERRCODE='23514';
    END IF;
    IF NEW.prune_requested_at IS NOT NULL AND OLD.prune_requested_at IS NULL THEN
        IF OLD.state <> 'complete' OR EXISTS (
            SELECT 1 FROM backup_retention_claims claim
             WHERE claim.backup_id=OLD.id
               AND (claim.retain_until IS NULL OR claim.retain_until>transaction_timestamp())
        ) THEN
            RAISE EXCEPTION 'retained or incomplete backup cannot be marked for prune' USING ERRCODE='23514';
        END IF;
    END IF;
    IF NEW.state = 'complete' AND OLD.state <> 'complete' THEN
        SELECT count(*), coalesce(sum(entry.payload_bytes), 0),
               count(*) FILTER (WHERE entry.component='database_archive')
          INTO actual_count, actual_bytes, database_count
          FROM backup_manifest_entries entry WHERE entry.backup_id=OLD.id;
        IF actual_count <> NEW.expected_object_count
           OR actual_bytes <> NEW.expected_payload_bytes OR database_count <> 1 THEN
            RAISE EXCEPTION 'backup manifest does not match generation expectations' USING ERRCODE='23514';
        END IF;
    END IF;
    RETURN NEW;
END;
$$;

-- An active generation is a global fence from creation until terminalization.
-- Per-object holds take over for the exact exported inventory before that fence
-- is released, avoiding the inventory-discovery race of online backup.
CREATE OR REPLACE FUNCTION enforce_gc_policy_deletion_fence() RETURNS trigger
LANGUAGE plpgsql AS $$
BEGIN
    IF NEW.status IN ('running','completed') AND NEW.status IS DISTINCT FROM OLD.status THEN
        PERFORM lock_bundle_object_lifecycle(NEW.object_key);
        IF EXISTS (SELECT 1 FROM backup_generations generation
                   WHERE generation.state IN ('preparing','copying','verifying'))
           OR EXISTS (SELECT 1 FROM projects project JOIN bundles bundle ON bundle.id=project.working_head_bundle_id
                      WHERE bundle.object_key=NEW.object_key)
           OR EXISTS (SELECT 1 FROM project_bundle_refs reference JOIN bundles bundle ON bundle.id=reference.bundle_id
                      WHERE bundle.object_key=NEW.object_key)
           OR EXISTS (SELECT 1 FROM save_sessions session WHERE session.staging_object_key=NEW.object_key
                      AND session.state IN ('created','uploading','verifying'))
           OR EXISTS (SELECT 1 FROM object_retention_holds hold WHERE hold.object_key=NEW.object_key
                      AND (hold.retain_until IS NULL OR hold.retain_until>transaction_timestamp())) THEN
            RAISE EXCEPTION 'GC deletion fence requires no active backup, live reference or retention hold' USING ERRCODE='23514';
        END IF;
    END IF;
    RETURN NEW;
END;
$$;
