-- Durable replay ledger for atomic promotion of an immutable Version or
-- Recovery Checkpoint to the Project Working Head. Raw Idempotency-Key values
-- are never persisted.

CREATE TABLE project_history_promotions (
    id uuid PRIMARY KEY,
    project_id uuid NOT NULL REFERENCES projects (id) ON DELETE CASCADE,
    actor_user_id uuid NOT NULL REFERENCES users (id) ON DELETE RESTRICT,
    idempotency_digest bytea NOT NULL,
    reference_kind text NOT NULL,
    reference_id uuid NOT NULL,
    bundle_id uuid NOT NULL REFERENCES bundles (id) ON DELETE RESTRICT,
    expected_project_version bigint NOT NULL,
    resulting_project_version bigint NOT NULL,
    changed boolean NOT NULL,
    audit_event_id uuid NOT NULL UNIQUE REFERENCES audit_events (id) ON DELETE RESTRICT,
    created_at timestamptz NOT NULL DEFAULT CURRENT_TIMESTAMP,
    CONSTRAINT project_history_promotions_id_v7_check
        CHECK (
            substring(id::text FROM 15 FOR 1) = '7'
            AND substring(id::text FROM 20 FOR 1) IN ('8', '9', 'a', 'b')
        ),
    CONSTRAINT project_history_promotions_digest_check
        CHECK (octet_length(idempotency_digest) = 32),
    CONSTRAINT project_history_promotions_kind_check
        CHECK (reference_kind IN ('version', 'recovery')),
    CONSTRAINT project_history_promotions_versions_check
        CHECK (
            expected_project_version BETWEEN 1 AND 9223372036854775806
            AND resulting_project_version BETWEEN expected_project_version
                                                AND 9223372036854775806
            AND (
                (changed AND resulting_project_version = expected_project_version + 1)
                OR (NOT changed AND resulting_project_version = expected_project_version)
            )
        )
);

CREATE UNIQUE INDEX project_history_promotions_idempotency_unique
    ON project_history_promotions (project_id, actor_user_id, idempotency_digest);
CREATE INDEX project_history_promotions_project_created_idx
    ON project_history_promotions (project_id, created_at DESC, id DESC);

CREATE TRIGGER project_history_promotions_no_truncate
    BEFORE TRUNCATE ON project_history_promotions
    FOR EACH STATEMENT EXECUTE FUNCTION reject_bundle_persistence_truncate();

CREATE FUNCTION project_history_promotions_immutable_guard()
RETURNS trigger
LANGUAGE plpgsql
AS $$
BEGIN
    IF TG_OP = 'DELETE'
        AND pg_trigger_depth() > 1
        AND current_setting('nuriteo.project_delete_id', true) = OLD.project_id::text
        AND NOT EXISTS (SELECT 1 FROM projects WHERE id = OLD.project_id)
    THEN
        RETURN OLD;
    END IF;
    RAISE EXCEPTION 'project history promotion outcomes are immutable'
        USING ERRCODE = '23514';
END;
$$;

CREATE TRIGGER project_history_promotions_immutable
    BEFORE UPDATE OR DELETE ON project_history_promotions
    FOR EACH ROW EXECUTE FUNCTION project_history_promotions_immutable_guard();
