-- Durable restore-point metadata. Destination I/O is implemented separately;
-- only rows satisfying these invariants may be exposed as restore points.

CREATE TABLE backup_generations (
    id uuid PRIMARY KEY,
    format_version integer NOT NULL DEFAULT 1,
    nuriteo_version text NOT NULL,
    schema_version bigint NOT NULL,
    postgres_major integer NOT NULL,
    backup_method text NOT NULL DEFAULT 'pg_dump-custom',
    synchronized_snapshot_id text NOT NULL,
    state text NOT NULL DEFAULT 'preparing',
    expected_object_count bigint NOT NULL,
    expected_payload_bytes bigint NOT NULL,
    manifest_sha256 bytea,
    failure_code text,
    prune_requested_at timestamptz,
    created_at timestamptz NOT NULL DEFAULT CURRENT_TIMESTAMP,
    updated_at timestamptz NOT NULL DEFAULT CURRENT_TIMESTAMP,
    completed_at timestamptz,
    CONSTRAINT backup_generations_id_v7_check CHECK (
        (get_byte(uuid_send(id), 6) >> 4) = 7
        AND (get_byte(uuid_send(id), 8) & 192) = 128
    ),
    CONSTRAINT backup_generations_format_check CHECK (format_version = 1),
    CONSTRAINT backup_generations_version_check CHECK (
        octet_length(nuriteo_version) BETWEEN 1 AND 128
        AND nuriteo_version = btrim(nuriteo_version)
        AND nuriteo_version !~ '[[:cntrl:]]'
        AND schema_version > 0
        AND postgres_major BETWEEN 14 AND 99
    ),
    CONSTRAINT backup_generations_method_check CHECK (backup_method = 'pg_dump-custom'),
    CONSTRAINT backup_generations_snapshot_check CHECK (
        octet_length(synchronized_snapshot_id) BETWEEN 1 AND 256
        AND synchronized_snapshot_id = btrim(synchronized_snapshot_id)
        AND synchronized_snapshot_id !~ '[[:cntrl:]]'
    ),
    CONSTRAINT backup_generations_state_check CHECK (
        state IN ('preparing', 'copying', 'verifying', 'complete', 'failed')
    ),
    CONSTRAINT backup_generations_expected_count_check CHECK (expected_object_count > 0),
    CONSTRAINT backup_generations_expected_bytes_check CHECK (expected_payload_bytes > 0),
    CONSTRAINT backup_generations_manifest_digest_check CHECK (
        manifest_sha256 IS NULL OR octet_length(manifest_sha256) = 32
    ),
    CONSTRAINT backup_generations_failure_code_check CHECK (
        failure_code IS NULL OR (
            octet_length(failure_code) BETWEEN 1 AND 128
            AND failure_code ~ '^[a-z][a-z0-9_]*$'
        )
    ),
    CONSTRAINT backup_generations_result_check CHECK (
        (state IN ('preparing', 'copying', 'verifying')
            AND manifest_sha256 IS NULL AND failure_code IS NULL
            AND completed_at IS NULL AND prune_requested_at IS NULL)
        OR (state = 'complete' AND manifest_sha256 IS NOT NULL
            AND failure_code IS NULL AND completed_at IS NOT NULL)
        OR (state = 'failed' AND manifest_sha256 IS NULL
            AND failure_code IS NOT NULL AND completed_at IS NOT NULL
            AND prune_requested_at IS NULL)
    ),
    CONSTRAINT backup_generations_timestamps_check CHECK (
        updated_at >= created_at
        AND (completed_at IS NULL OR completed_at >= created_at)
        AND (completed_at IS NULL OR updated_at >= completed_at)
        AND (prune_requested_at IS NULL OR prune_requested_at >= completed_at)
        AND (prune_requested_at IS NULL OR updated_at >= prune_requested_at)
    )
);

CREATE UNIQUE INDEX backup_generations_one_active_idx
    ON backup_generations ((TRUE))
    WHERE state IN ('preparing', 'copying', 'verifying');
CREATE INDEX backup_generations_restore_points_idx
    ON backup_generations (completed_at DESC, id)
    WHERE state = 'complete' AND prune_requested_at IS NULL;

CREATE TABLE backup_payloads (
    sha256 bytea PRIMARY KEY,
    destination_object_key text NOT NULL UNIQUE,
    destination_version_id text,
    payload_bytes bigint NOT NULL,
    created_at timestamptz NOT NULL DEFAULT CURRENT_TIMESTAMP,
    CONSTRAINT backup_payloads_digest_check CHECK (octet_length(sha256) = 32),
    CONSTRAINT backup_payloads_key_check CHECK (
        octet_length(destination_object_key) BETWEEN 1 AND 1024
        AND destination_object_key = btrim(destination_object_key)
        AND destination_object_key !~ '[[:cntrl:]]'
        AND destination_object_key !~ '(^/|//|(^|/)\.\.?(/|$))'
    ),
    CONSTRAINT backup_payloads_version_check CHECK (
        destination_version_id IS NULL OR (
            octet_length(destination_version_id) BETWEEN 1 AND 1024
            AND destination_version_id = btrim(destination_version_id)
            AND destination_version_id !~ '[[:cntrl:]]'
        )
    ),
    CONSTRAINT backup_payloads_bytes_check CHECK (payload_bytes > 0)
);

CREATE TABLE backup_manifest_entries (
    backup_id uuid NOT NULL REFERENCES backup_generations(id) ON DELETE CASCADE,
    ordinal bigint NOT NULL,
    component text NOT NULL,
    source_object_key text,
    payload_sha256 bytea NOT NULL REFERENCES backup_payloads(sha256) ON DELETE RESTRICT,
    payload_bytes bigint NOT NULL,
    created_at timestamptz NOT NULL DEFAULT CURRENT_TIMESTAMP,
    PRIMARY KEY (backup_id, ordinal),
    CONSTRAINT backup_manifest_entries_ordinal_check CHECK (ordinal > 0),
    CONSTRAINT backup_manifest_entries_component_check CHECK (
        component IN ('database_archive', 'project_bundle')
    ),
    CONSTRAINT backup_manifest_entries_source_check CHECK (
        (component = 'database_archive' AND source_object_key IS NULL)
        OR (component = 'project_bundle' AND source_object_key IS NOT NULL
            AND octet_length(source_object_key) BETWEEN 1 AND 1024
            AND source_object_key = btrim(source_object_key)
            AND source_object_key !~ '[[:cntrl:]]'
            AND source_object_key !~ '(^/|//|(^|/)\.\.?(/|$))')
    ),
    CONSTRAINT backup_manifest_entries_bytes_check CHECK (payload_bytes > 0)
);

CREATE INDEX backup_manifest_entries_payload_idx
    ON backup_manifest_entries (payload_sha256, backup_id);
CREATE UNIQUE INDEX backup_manifest_entries_one_database_idx
    ON backup_manifest_entries (backup_id)
    WHERE component = 'database_archive';

CREATE TABLE backup_retention_claims (
    backup_id uuid NOT NULL REFERENCES backup_generations(id) ON DELETE CASCADE,
    retention_class text NOT NULL,
    retain_until timestamptz,
    created_at timestamptz NOT NULL DEFAULT CURRENT_TIMESTAMP,
    PRIMARY KEY (backup_id, retention_class),
    CONSTRAINT backup_retention_claims_class_check CHECK (
        retention_class IN ('daily', 'weekly', 'monthly', 'pinned')
    ),
    CONSTRAINT backup_retention_claims_expiry_check CHECK (
        retain_until IS NULL OR retain_until > created_at
    )
);

CREATE INDEX backup_retention_claims_expiry_idx
    ON backup_retention_claims (retain_until, backup_id);

CREATE TABLE backup_payload_gc_candidates (
    payload_sha256 bytea PRIMARY KEY REFERENCES backup_payloads(sha256) ON DELETE CASCADE,
    status text NOT NULL DEFAULT 'pending',
    eligible_at timestamptz NOT NULL,
    attempt_count integer NOT NULL DEFAULT 0,
    last_error_class text,
    created_at timestamptz NOT NULL DEFAULT CURRENT_TIMESTAMP,
    updated_at timestamptz NOT NULL DEFAULT CURRENT_TIMESTAMP,
    completed_at timestamptz,
    CONSTRAINT backup_payload_gc_candidates_state_check CHECK (
        status IN ('pending', 'running', 'failed', 'completed')
    ),
    CONSTRAINT backup_payload_gc_candidates_attempt_check CHECK (attempt_count >= 0),
    CONSTRAINT backup_payload_gc_candidates_error_check CHECK (
        last_error_class IS NULL OR (
            octet_length(last_error_class) BETWEEN 1 AND 128
            AND last_error_class ~ '^[a-z][a-z0-9_]*$'
        )
    ),
    CONSTRAINT backup_payload_gc_candidates_terminal_check CHECK (
        (status = 'completed' AND completed_at IS NOT NULL AND last_error_class IS NULL)
        OR (status = 'failed' AND completed_at IS NULL AND last_error_class IS NOT NULL)
        OR (status IN ('pending', 'running') AND completed_at IS NULL AND last_error_class IS NULL)
    ),
    CONSTRAINT backup_payload_gc_candidates_timestamps_check CHECK (
        eligible_at >= created_at AND updated_at >= created_at
        AND (completed_at IS NULL OR completed_at >= created_at)
        AND (completed_at IS NULL OR updated_at >= completed_at)
    )
);

CREATE FUNCTION lock_backup_payload(digest bytea) RETURNS void
LANGUAGE sql AS $$
    SELECT pg_advisory_xact_lock(1112230997, hashtext(encode(digest, 'hex')))
$$;

CREATE FUNCTION enforce_backup_generation_transition() RETURNS trigger
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
       OR NEW.synchronized_snapshot_id IS DISTINCT FROM OLD.synchronized_snapshot_id
       OR NEW.expected_object_count IS DISTINCT FROM OLD.expected_object_count
       OR NEW.expected_payload_bytes IS DISTINCT FROM OLD.expected_payload_bytes
       OR NEW.created_at IS DISTINCT FROM OLD.created_at
       OR NEW.updated_at < OLD.updated_at THEN
        RAISE EXCEPTION 'backup generation identity and expectations are immutable' USING ERRCODE='23514';
    END IF;
    IF OLD.state = 'preparing' AND NEW.state NOT IN ('preparing', 'copying', 'failed')
       OR OLD.state = 'copying' AND NEW.state NOT IN ('copying', 'verifying', 'failed')
       OR OLD.state = 'verifying' AND NEW.state NOT IN ('verifying', 'complete', 'failed')
       OR OLD.state IN ('complete', 'failed') AND NEW.state IS DISTINCT FROM OLD.state THEN
        RAISE EXCEPTION 'invalid backup generation state transition' USING ERRCODE='23514';
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

CREATE TRIGGER backup_generations_transition_guard
BEFORE UPDATE ON backup_generations
FOR EACH ROW EXECUTE FUNCTION enforce_backup_generation_transition();

CREATE FUNCTION enforce_backup_manifest_entry_write() RETURNS trigger
LANGUAGE plpgsql AS $$
DECLARE
    generation_state text;
    generation_prune_requested_at timestamptz;
    canonical_bytes bigint;
    digest bytea := CASE WHEN TG_OP='DELETE' THEN OLD.payload_sha256 ELSE NEW.payload_sha256 END;
BEGIN
    PERFORM lock_backup_payload(digest);
    SELECT state, prune_requested_at INTO generation_state, generation_prune_requested_at
      FROM backup_generations
     WHERE id=CASE WHEN TG_OP='DELETE' THEN OLD.backup_id ELSE NEW.backup_id END
     FOR UPDATE;
    IF TG_OP='INSERT' THEN
        IF generation_state NOT IN ('preparing', 'copying') THEN
            RAISE EXCEPTION 'backup manifest is not writable in this state' USING ERRCODE='23514';
        END IF;
        SELECT payload_bytes INTO canonical_bytes FROM backup_payloads WHERE sha256=NEW.payload_sha256;
        IF canonical_bytes IS DISTINCT FROM NEW.payload_bytes THEN
            RAISE EXCEPTION 'backup manifest payload metadata mismatch' USING ERRCODE='23514';
        END IF;
        IF EXISTS (SELECT 1 FROM backup_payload_gc_candidates candidate
                    WHERE candidate.payload_sha256=NEW.payload_sha256
                      AND candidate.status IN ('running','completed')) THEN
            RAISE EXCEPTION 'backup payload deletion is already fenced' USING ERRCODE='23514';
        END IF;
        RETURN NEW;
    END IF;
    IF TG_OP='UPDATE' THEN
        RAISE EXCEPTION 'backup manifest entries are immutable' USING ERRCODE='23514';
    END IF;
    IF generation_state <> 'failed'
       AND NOT (generation_state='complete' AND generation_prune_requested_at IS NOT NULL) THEN
        RAISE EXCEPTION 'protected backup manifest entries cannot be deleted' USING ERRCODE='23514';
    END IF;
    RETURN OLD;
END;
$$;

CREATE TRIGGER backup_manifest_entries_write_guard
BEFORE INSERT OR UPDATE OR DELETE ON backup_manifest_entries
FOR EACH ROW EXECUTE FUNCTION enforce_backup_manifest_entry_write();

CREATE FUNCTION enforce_backup_retention_claim_write() RETURNS trigger
LANGUAGE plpgsql AS $$
DECLARE
    generation_state text;
    generation_prune_requested_at timestamptz;
BEGIN
    SELECT state, prune_requested_at INTO generation_state, generation_prune_requested_at
      FROM backup_generations
     WHERE id=CASE WHEN TG_OP='DELETE' THEN OLD.backup_id ELSE NEW.backup_id END
     FOR UPDATE;
    IF generation_state <> 'complete' OR generation_prune_requested_at IS NOT NULL THEN
        RAISE EXCEPTION 'only complete active backups may have retention claims' USING ERRCODE='23514';
    END IF;
    IF TG_OP='UPDATE' AND (
        NEW.backup_id IS DISTINCT FROM OLD.backup_id
        OR NEW.retention_class IS DISTINCT FROM OLD.retention_class
        OR NEW.created_at IS DISTINCT FROM OLD.created_at
        OR (OLD.retain_until IS NULL AND NEW.retain_until IS NOT NULL)
        OR (OLD.retain_until IS NOT NULL AND NEW.retain_until IS NOT NULL
            AND NEW.retain_until < OLD.retain_until)
    ) THEN
        RAISE EXCEPTION 'backup retention may only be extended' USING ERRCODE='23514';
    END IF;
    RETURN CASE WHEN TG_OP='DELETE' THEN OLD ELSE NEW END;
END;
$$;

CREATE TRIGGER backup_retention_claims_write_guard
BEFORE INSERT OR UPDATE OR DELETE ON backup_retention_claims
FOR EACH ROW EXECUTE FUNCTION enforce_backup_retention_claim_write();

CREATE FUNCTION enforce_backup_payload_gc_fence() RETURNS trigger
LANGUAGE plpgsql AS $$
BEGIN
    IF TG_OP='INSERT' OR (NEW.status IN ('running','completed') AND NEW.status IS DISTINCT FROM OLD.status) THEN
        PERFORM lock_backup_payload(NEW.payload_sha256);
        IF EXISTS (
            SELECT 1 FROM backup_manifest_entries entry
            JOIN backup_generations generation ON generation.id=entry.backup_id
              WHERE entry.payload_sha256=NEW.payload_sha256
                AND (generation.state IN ('preparing','copying','verifying')
                     OR (generation.state='complete' AND generation.prune_requested_at IS NULL))
        ) THEN
            RAISE EXCEPTION 'backup payload GC requires no active or retained restore point' USING ERRCODE='23514';
        END IF;
    END IF;
    IF TG_OP='UPDATE' AND (
        NEW.payload_sha256 IS DISTINCT FROM OLD.payload_sha256
        OR NEW.created_at IS DISTINCT FROM OLD.created_at
        OR NEW.updated_at < OLD.updated_at OR OLD.status='completed'
        OR (OLD.status='pending' AND NEW.status NOT IN ('pending','running'))
        OR (OLD.status='running' AND NEW.status NOT IN ('running','failed','completed'))
        OR (OLD.status='failed' AND NEW.status NOT IN ('failed','pending'))
    ) THEN
        RAISE EXCEPTION 'invalid backup payload GC transition' USING ERRCODE='23514';
    END IF;
    RETURN NEW;
END;
$$;

CREATE TRIGGER backup_payload_gc_candidates_write_guard
BEFORE INSERT OR UPDATE ON backup_payload_gc_candidates
FOR EACH ROW EXECUTE FUNCTION enforce_backup_payload_gc_fence();

CREATE FUNCTION enforce_backup_payload_write() RETURNS trigger
LANGUAGE plpgsql AS $$
BEGIN
    IF TG_OP='UPDATE' THEN
        RAISE EXCEPTION 'backup payload metadata is immutable' USING ERRCODE='23514';
    END IF;
    PERFORM lock_backup_payload(OLD.sha256);
    IF NOT EXISTS (SELECT 1 FROM backup_payload_gc_candidates candidate
                    WHERE candidate.payload_sha256=OLD.sha256 AND candidate.status='completed')
       OR EXISTS (SELECT 1 FROM backup_manifest_entries entry WHERE entry.payload_sha256=OLD.sha256) THEN
        RAISE EXCEPTION 'backup payload deletion requires completed GC and no manifest reference' USING ERRCODE='23514';
    END IF;
    RETURN OLD;
END;
$$;

CREATE TRIGGER backup_payloads_write_guard
BEFORE UPDATE OR DELETE ON backup_payloads
FOR EACH ROW EXECUTE FUNCTION enforce_backup_payload_write();

CREATE VIEW complete_backup_restore_points AS
SELECT generation.id, generation.format_version, generation.nuriteo_version,
       generation.schema_version, generation.postgres_major, generation.backup_method,
       generation.expected_object_count, generation.expected_payload_bytes,
       generation.manifest_sha256, generation.created_at, generation.completed_at
  FROM backup_generations generation
 WHERE generation.state='complete' AND generation.prune_requested_at IS NULL;
