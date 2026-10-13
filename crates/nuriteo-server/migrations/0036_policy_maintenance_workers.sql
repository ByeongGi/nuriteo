-- Durable, replica-safe ownership for object-GC attempts. The candidate state
-- machine remains owned by migration 0014; leases only fence external object
-- deletion and may be recovered after a crashed worker.

CREATE TABLE gc_candidate_leases (
    object_key text PRIMARY KEY REFERENCES gc_candidates(object_key) ON DELETE CASCADE,
    lease_owner uuid NOT NULL,
    lease_expires_at timestamptz NOT NULL,
    created_at timestamptz NOT NULL DEFAULT CURRENT_TIMESTAMP,
    updated_at timestamptz NOT NULL DEFAULT CURRENT_TIMESTAMP,
    CONSTRAINT gc_candidate_leases_owner_v7_check CHECK (
        (get_byte(uuid_send(lease_owner), 6) >> 4) = 7
        AND (get_byte(uuid_send(lease_owner), 8) & 192) = 128
    ),
    CONSTRAINT gc_candidate_leases_time_check CHECK (
        lease_expires_at > created_at AND updated_at >= created_at
    )
);

CREATE INDEX gc_candidate_leases_expiry_idx
    ON gc_candidate_leases(lease_expires_at, object_key);

-- A backup/export operation may fence object reclamation without teaching the
-- GC worker about a particular backup implementation. Writers must acquire
-- lock_bundle_object_lifecycle(object_key) while creating/removing a hold.
CREATE TABLE object_retention_holds (
    object_key text NOT NULL,
    holder_kind text NOT NULL,
    holder_id uuid NOT NULL,
    retain_until timestamptz,
    created_at timestamptz NOT NULL DEFAULT CURRENT_TIMESTAMP,
    PRIMARY KEY (object_key, holder_kind, holder_id),
    CONSTRAINT object_retention_holds_key_check CHECK (
        octet_length(object_key) BETWEEN 1 AND 1024
        AND object_key !~ E'[\\x00-\\x1F\\x7F]'
    ),
    CONSTRAINT object_retention_holds_kind_check CHECK (
        holder_kind IN ('backup', 'export')
    ),
    CONSTRAINT object_retention_holds_holder_v7_check CHECK (
        (get_byte(uuid_send(holder_id), 6) >> 4) = 7
        AND (get_byte(uuid_send(holder_id), 8) & 192) = 128
    ),
    CONSTRAINT object_retention_holds_expiry_check CHECK (
        retain_until IS NULL OR retain_until > created_at
    )
);

CREATE INDEX object_retention_holds_active_idx
    ON object_retention_holds(object_key, retain_until);

CREATE FUNCTION enforce_object_retention_hold_write() RETURNS trigger
LANGUAGE plpgsql AS $$
DECLARE
    key text := CASE WHEN TG_OP = 'DELETE' THEN OLD.object_key ELSE NEW.object_key END;
BEGIN
    IF TG_OP = 'UPDATE' AND (
        NEW.object_key IS DISTINCT FROM OLD.object_key
        OR NEW.holder_kind IS DISTINCT FROM OLD.holder_kind
        OR NEW.holder_id IS DISTINCT FROM OLD.holder_id
        OR NEW.created_at IS DISTINCT FROM OLD.created_at
    ) THEN
        RAISE EXCEPTION 'retention hold identity is immutable' USING ERRCODE='23514';
    END IF;
    PERFORM lock_bundle_object_lifecycle(key);
    IF TG_OP <> 'DELETE' AND (NEW.retain_until IS NULL OR NEW.retain_until > transaction_timestamp())
       AND EXISTS (SELECT 1 FROM gc_candidates candidate
                   WHERE candidate.object_key=key AND candidate.status IN ('running','completed')) THEN
        RAISE EXCEPTION 'retention hold conflicts with object deletion fence' USING ERRCODE='23514';
    END IF;
    RETURN CASE WHEN TG_OP = 'DELETE' THEN OLD ELSE NEW END;
END;
$$;

CREATE TRIGGER object_retention_holds_write_fence
BEFORE INSERT OR UPDATE OR DELETE ON object_retention_holds
FOR EACH ROW EXECUTE FUNCTION enforce_object_retention_hold_write();

CREATE FUNCTION enforce_gc_policy_deletion_fence() RETURNS trigger
LANGUAGE plpgsql AS $$
BEGIN
    IF NEW.status IN ('running','completed') AND NEW.status IS DISTINCT FROM OLD.status THEN
        PERFORM lock_bundle_object_lifecycle(NEW.object_key);
        IF EXISTS (SELECT 1 FROM projects project JOIN bundles bundle ON bundle.id=project.working_head_bundle_id
                   WHERE bundle.object_key=NEW.object_key)
           OR EXISTS (SELECT 1 FROM project_bundle_refs reference JOIN bundles bundle ON bundle.id=reference.bundle_id
                      WHERE bundle.object_key=NEW.object_key)
           OR EXISTS (SELECT 1 FROM save_sessions session WHERE session.staging_object_key=NEW.object_key
                      AND session.state IN ('created','uploading','verifying'))
           OR EXISTS (SELECT 1 FROM object_retention_holds hold WHERE hold.object_key=NEW.object_key
                      AND (hold.retain_until IS NULL OR hold.retain_until>transaction_timestamp())) THEN
            RAISE EXCEPTION 'GC deletion fence requires no live reference or retention hold' USING ERRCODE='23514';
        END IF;
    END IF;
    RETURN NEW;
END;
$$;

CREATE TRIGGER gc_candidates_policy_deletion_fence
BEFORE UPDATE ON gc_candidates
FOR EACH ROW EXECUTE FUNCTION enforce_gc_policy_deletion_fence();

CREATE TABLE gc_object_deletion_receipts (
    object_key text PRIMARY KEY REFERENCES gc_candidates(object_key) ON DELETE RESTRICT,
    expected_sha256 bytea NOT NULL,
    expected_bytes bigint NOT NULL,
    outcome text NOT NULL,
    completed_at timestamptz NOT NULL DEFAULT CURRENT_TIMESTAMP,
    CONSTRAINT gc_object_deletion_receipts_digest_check CHECK(octet_length(expected_sha256)=32),
    CONSTRAINT gc_object_deletion_receipts_bytes_check CHECK(expected_bytes>=0),
    CONSTRAINT gc_object_deletion_receipts_outcome_check CHECK(outcome IN ('deleted','absent'))
);

CREATE FUNCTION reject_gc_object_deletion_receipt_change() RETURNS trigger
LANGUAGE plpgsql AS $$
BEGIN
    RAISE EXCEPTION 'GC object deletion receipt is immutable' USING ERRCODE='23514';
END;
$$;

CREATE TRIGGER gc_object_deletion_receipts_no_update
BEFORE UPDATE OR DELETE ON gc_object_deletion_receipts
FOR EACH ROW EXECUTE FUNCTION reject_gc_object_deletion_receipt_change();

CREATE FUNCTION enforce_gc_candidate_lease_update() RETURNS trigger
LANGUAGE plpgsql AS $$
BEGIN
    IF NEW.object_key IS DISTINCT FROM OLD.object_key
       OR NEW.created_at IS DISTINCT FROM OLD.created_at
       OR NEW.updated_at < OLD.updated_at
       OR NEW.lease_expires_at <= transaction_timestamp() THEN
        RAISE EXCEPTION 'GC candidate lease update is invalid' USING ERRCODE='23514';
    END IF;
    RETURN NEW;
END;
$$;

CREATE TRIGGER gc_candidate_leases_update_guard
BEFORE UPDATE ON gc_candidate_leases
FOR EACH ROW EXECUTE FUNCTION enforce_gc_candidate_lease_update();

CREATE FUNCTION reject_gc_candidate_leases_truncate() RETURNS trigger
LANGUAGE plpgsql AS $$
BEGIN
    RAISE EXCEPTION 'GC candidate leases cannot be truncated' USING ERRCODE='23514';
END;
$$;

CREATE TRIGGER gc_candidate_leases_no_truncate
BEFORE TRUNCATE ON gc_candidate_leases
FOR EACH STATEMENT EXECUTE FUNCTION reject_gc_candidate_leases_truncate();
