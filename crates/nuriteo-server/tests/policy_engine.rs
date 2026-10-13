use std::env;
use std::fs;
use std::sync::Arc;
use std::sync::atomic::{AtomicUsize, Ordering};
use std::time::Duration;

use nuriteo_server::audit::{ActorType, AuditActor, AuditEventId};
use nuriteo_server::config::InstanceSettingBootstrap;
use nuriteo_server::database::{
    DatabasePool, DatabasePoolConfig, DatabaseTlsConfig, MigrationOptions, run_embedded_migrations,
};
use nuriteo_server::identity::{
    InvitationAuditContext, InvitationService, NormalizedEmail, SessionId, SessionPolicy,
    SessionService, UserId,
};
use nuriteo_server::instance_settings::InstanceSettingsRepository;
use nuriteo_server::object_storage::ObjectKey;
use nuriteo_server::organization::{
    OrganizationId, OrganizationInvitationActor, OrganizationInvitationAuditContext,
    OrganizationInvitationPolicy, OrganizationInvitationService, OrganizationRole,
};
use nuriteo_server::policy::{
    EffectivePolicyEngine, ObjectDeleteOutcome, ObjectGcBackend, PolicyApplyScope,
    PolicyChangeDirection, PolicyMaintenanceWorker,
};
use nuriteo_server::project::ProjectId;
use nuriteo_server::quota::{
    EffectiveQuota, QuotaService, QuotaServiceError, QuotaServicePolicy, ReservationRequest,
    SaveSessionId,
};
use nuriteo_server::workspace::StorageScopeId;
use serde_json::json;
use sqlx::{Connection, Executor};
use uuid::Uuid;

const DATABASE_URL_ENV: &str = "NURITEO_TEST_DATABASE_URL";
const DATABASE_CA_ENV: &str = "NURITEO_TEST_DATABASE_CA";
const USER_ID: &str = "0199ee6c-c777-7000-8000-000000000801";
const SCOPE_ID: &str = "0199ee6c-c777-7000-8000-000000000802";

#[tokio::test]
#[ignore = "requires the pinned PostgreSQL TLS fixture; run tests/fixtures/postgres-policy-engine/run.sh"]
async fn live_policy_is_serialized_restart_safe_and_dry_run_only() {
    let pool = fixture_pool().await;
    reset_fixture(&pool).await;
    let report = run_embedded_migrations(
        &pool,
        MigrationOptions::new(Duration::from_secs(5), Duration::from_secs(30)).unwrap(),
    )
    .await
    .unwrap();
    assert_eq!(report.latest_version, Some(50));
    InstanceSettingsRepository::new(pool.clone(), Duration::from_secs(5))
        .unwrap()
        .materialize(&InstanceSettingBootstrap::empty())
        .await
        .unwrap();
    seed_user(&pool).await;

    let engine = EffectivePolicyEngine::new(pool.clone(), Duration::from_secs(5)).unwrap();
    let snapshot = engine.load().await.unwrap();
    assert_eq!(
        snapshot.session_policy(Duration::from_secs(5)).unwrap(),
        SessionPolicy::default()
    );

    let impact = engine
        .preview_change("workspace.personal_default_quota_bytes", json!(1_048_576))
        .await
        .unwrap();
    assert_eq!(impact.direction, PolicyChangeDirection::Decrease);
    assert_eq!(impact.apply_scope, PolicyApplyScope::NewOperations);
    assert!(!impact.automatically_deletes_existing_data);

    verify_live_session_policy(&pool).await;
    verify_live_invitation_policy(&pool).await;
    verify_live_organization_invitation_policy(&pool).await;
    verify_live_quota_policy(&pool).await;
    verify_update_and_read_are_serialized(&pool).await;

    let cleanup = engine.cleanup_preview(25).await.unwrap();
    assert!(cleanup.dry_run);
    assert_eq!(cleanup.batch_limit, 25);
    assert_eq!(cleanup.eligible_candidates, 0);
    assert_eq!(cleanup.expected_reclaim_bytes, "0");
    verify_maintenance_workers(&pool).await;

    let restarted = EffectivePolicyEngine::new(pool.clone(), Duration::from_secs(5))
        .unwrap()
        .load()
        .await
        .unwrap();
    assert_eq!(
        restarted.value("sessions.idle_timeout_minutes"),
        Some(&json!(120))
    );

    reset_fixture(&pool).await;
    pool.close(Duration::from_secs(2)).await.unwrap();
}

#[derive(Clone, Default)]
struct FixtureGcBackend {
    calls: Arc<AtomicUsize>,
}

impl ObjectGcBackend for FixtureGcBackend {
    async fn delete_object(&self, _key: ObjectKey) -> ObjectDeleteOutcome {
        if self.calls.fetch_add(1, Ordering::SeqCst) == 0 {
            ObjectDeleteOutcome::Retryable
        } else {
            ObjectDeleteOutcome::Deleted
        }
    }
}

async fn verify_maintenance_workers(pool: &DatabasePool) {
    update_setting(pool, "object_storage.gc.enabled", json!(false)).await;
    update_setting(pool, "object_storage.gc.grace_period_hours", json!(0)).await;
    update_setting(pool, "object_storage.gc.batch_size", json!(1)).await;
    update_setting(pool, "notifications.general_retention_days", json!(365)).await;
    seed_unreferenced_bundle(
        pool,
        "0199ee6c-c777-7000-8000-000000000810",
        "0199ee6c-c777-7000-8000-000000000815",
        "0199ee6c-c777-7000-8000-000000000816",
        "bundles/policy-gc",
        "81",
        "gc-primary",
    )
    .await;
    sqlx::raw_sql(
        "INSERT INTO audit_events(id,occurred_at,actor_type,actor_id,action_code,target_type,target_id,scope_type,scope_id,result,correlation_id,metadata) VALUES \
         ('0199ee6c-c777-7000-8000-000000000901',transaction_timestamp()-interval '400 days','system','fixture','fixture.audit_expired','fixture','unreferenced','instance','instance','succeeded','fixture:audit-unreferenced','{}'::jsonb), \
         ('0199ee6c-c777-7000-8000-000000000902',transaction_timestamp()-interval '400 days','system','fixture','fixture.audit_expired','fixture','history-reference','instance','instance','succeeded','fixture:audit-referenced','{}'::jsonb); \
         INSERT INTO project_history_promotions(id,project_id,actor_user_id,idempotency_digest,reference_kind,reference_id,bundle_id,expected_project_version,resulting_project_version,changed,audit_event_id) VALUES \
         ('0199ee6c-c777-7000-8000-000000000903','0199ee6c-c777-7000-8000-000000000815'::uuid,'0199ee6c-c777-7000-8000-000000000801'::uuid,decode(repeat('90',32),'hex'),'version','0199ee6c-c777-7000-8000-000000000904'::uuid,'0199ee6c-c777-7000-8000-000000000810'::uuid,1,1,FALSE,'0199ee6c-c777-7000-8000-000000000902'::uuid)",
    )
    .execute(&mut *pool.acquire().await.unwrap())
    .await
    .unwrap();
    sqlx::raw_sql(
        "INSERT INTO gc_candidates(object_key,expected_sha256,expected_bytes,reason,eligible_at) \
         VALUES('bundles/policy-gc',decode(repeat('81',32),'hex'),128,'reference_removed',transaction_timestamp())",
    )
    .execute(&mut *pool.acquire().await.unwrap())
    .await
    .unwrap();
    sqlx::query(
        "INSERT INTO notifications(id,recipient_user_id,classification,event_code,template_id,locale,resource_type,resource_id,status,action_state,first_occurred_at,last_occurred_at,created_at,updated_at) \
         VALUES('0199ee6c-c777-7000-8000-000000000811',$1::uuid,'collaboration','policy.retention','policy.retention','en','project','retained','read','none',transaction_timestamp()-interval '100 days',transaction_timestamp()-interval '100 days',transaction_timestamp()-interval '100 days',transaction_timestamp()-interval '100 days'), \
               ('0199ee6c-c777-7000-8000-000000000812',$1::uuid,'collaboration','policy.unread','policy.unread','en','project','unread','unread','none',transaction_timestamp()-interval '100 days',transaction_timestamp()-interval '100 days',transaction_timestamp()-interval '100 days',transaction_timestamp()-interval '100 days'), \
               ('0199ee6c-c777-7000-8000-000000000825',$1::uuid,'collaboration','policy.action','policy.action','en','project','action','read','pending',transaction_timestamp()-interval '100 days',transaction_timestamp()-interval '100 days',transaction_timestamp()-interval '100 days',transaction_timestamp()-interval '100 days'), \
               ('0199ee6c-c777-7000-8000-000000000829',$1::uuid,'collaboration','policy.dead_letter','policy.dead_letter','en','project','dead-letter','read','none',transaction_timestamp()-interval '100 days',transaction_timestamp()-interval '100 days',transaction_timestamp()-interval '100 days',transaction_timestamp()-interval '100 days')",
    )
    .bind(USER_ID)
    .execute(&mut *pool.acquire().await.unwrap())
    .await
    .unwrap();
    sqlx::query(
        "INSERT INTO email_outbox(id,notification_id,recipient_user_id,recipient_email,classification,template_id,locale,resource_type,resource_id) \
         SELECT '0199ee6c-c777-7000-8000-000000000830'::uuid,id,recipient_user_id,'policy@example.test',classification,template_id,locale,resource_type,resource_id \
         FROM notifications WHERE id='0199ee6c-c777-7000-8000-000000000829'::uuid",
    )
    .execute(&mut *pool.acquire().await.unwrap())
    .await
    .unwrap();
    sqlx::query(
        "UPDATE email_outbox SET state='sending',attempt_count=1,first_attempt_at=transaction_timestamp(),last_attempt_at=transaction_timestamp(),lease_owner='0199ee6c-c777-7000-8000-000000000831',lease_expires_at=transaction_timestamp()+interval '30 seconds',updated_at=transaction_timestamp(),lock_version=lock_version+1 WHERE id='0199ee6c-c777-7000-8000-000000000830'::uuid",
    )
    .execute(&mut *pool.acquire().await.unwrap())
    .await
    .unwrap();
    sqlx::query(
        "UPDATE email_outbox SET state='dead_letter',lease_owner=NULL,lease_expires_at=NULL,last_smtp_code=550,last_error_class='permanent',updated_at=transaction_timestamp(),lock_version=lock_version+1 WHERE id='0199ee6c-c777-7000-8000-000000000830'::uuid",
    )
    .execute(&mut *pool.acquire().await.unwrap())
    .await
    .unwrap();

    let engine = EffectivePolicyEngine::new(pool.clone(), Duration::from_secs(5)).unwrap();
    let disabled_cleanup = engine.cleanup_preview(25).await.unwrap();
    assert!(!disabled_cleanup.gc_enabled);
    assert_eq!(disabled_cleanup.eligible_candidates, 0);
    let gc_impact = engine
        .preview_change("object_storage.gc.enabled", json!(true))
        .await
        .unwrap();
    assert_eq!(gc_impact.affected_resources, 1);
    assert!(gc_impact.automatically_deletes_existing_data);
    let notification_impact = engine
        .preview_change("notifications.general_retention_days", json!(30))
        .await
        .unwrap();
    assert_eq!(notification_impact.affected_resources, 1);
    assert!(notification_impact.automatically_deletes_existing_data);
    update_setting(pool, "object_storage.gc.enabled", json!(true)).await;
    update_setting(pool, "notifications.general_retention_days", json!(30)).await;

    let backend = FixtureGcBackend::default();
    let worker =
        PolicyMaintenanceWorker::new(pool.clone(), backend.clone(), Duration::from_secs(5))
            .unwrap();
    let first = worker.run_once().await.unwrap();
    assert_eq!(first.gc_claimed, 1);
    assert_eq!(first.gc_retried, 1);
    assert_eq!(first.notifications_deleted, 1);
    assert_eq!(first.audit_events_deleted, 1);
    let audit_retention_state: (bool, bool, i64) = sqlx::query_as(
        "SELECT \
         EXISTS(SELECT 1 FROM audit_events WHERE id='0199ee6c-c777-7000-8000-000000000901'::uuid), \
         EXISTS(SELECT 1 FROM audit_events WHERE id='0199ee6c-c777-7000-8000-000000000902'::uuid), \
         (SELECT COUNT(*) FROM audit_events WHERE action_code='audit.retention_pruned' AND actor_type='background_job')",
    )
    .fetch_one(&mut *pool.acquire().await.unwrap())
    .await
    .unwrap();
    assert_eq!(audit_retention_state, (false, true, 1));

    sqlx::raw_sql(
        "INSERT INTO audit_events(id,occurred_at,actor_type,actor_id,action_code,target_type,target_id,scope_type,scope_id,result,correlation_id,metadata) VALUES \
         ('0199ee6c-c777-7000-8000-000000000905',transaction_timestamp()-interval '400 days','system','fixture','fixture.audit_expired','fixture','rollback','instance','instance','succeeded','fixture:audit-rollback','{}'::jsonb); \
         CREATE FUNCTION reject_maintenance_audit() RETURNS trigger LANGUAGE plpgsql AS $$ \
         BEGIN IF NEW.action_code='audit.retention_pruned' AND NEW.actor_type='background_job' THEN RAISE EXCEPTION 'fixture audit failure'; END IF; RETURN NEW; END $$; \
         CREATE TRIGGER reject_maintenance_audit BEFORE INSERT ON audit_events FOR EACH ROW EXECUTE FUNCTION reject_maintenance_audit()",
    )
    .execute(&mut *pool.acquire().await.unwrap())
    .await
    .unwrap();
    assert_eq!(
        worker.run_once().await.unwrap_err(),
        nuriteo_server::policy::PolicyMaintenanceError::Database
    );
    assert!(sqlx::query_scalar::<_, bool>(
        "SELECT EXISTS(SELECT 1 FROM audit_events WHERE id='0199ee6c-c777-7000-8000-000000000905'::uuid)",
    )
    .fetch_one(&mut *pool.acquire().await.unwrap())
    .await
    .unwrap());
    sqlx::raw_sql(
        "DROP TRIGGER reject_maintenance_audit ON audit_events; DROP FUNCTION reject_maintenance_audit()",
    )
    .execute(&mut *pool.acquire().await.unwrap())
    .await
    .unwrap();
    assert!(sqlx::query_scalar::<_, bool>(
        "SELECT EXISTS(SELECT 1 FROM notifications WHERE id='0199ee6c-c777-7000-8000-000000000812'::uuid)",
    )
    .fetch_one(&mut *pool.acquire().await.unwrap())
    .await
    .unwrap());
    assert!(sqlx::query_scalar::<_, bool>(
        "SELECT EXISTS(SELECT 1 FROM notifications WHERE id='0199ee6c-c777-7000-8000-000000000825'::uuid)",
    )
    .fetch_one(&mut *pool.acquire().await.unwrap())
    .await
    .unwrap());
    assert!(sqlx::query_scalar::<_, bool>(
        "SELECT EXISTS(SELECT 1 FROM notifications WHERE id='0199ee6c-c777-7000-8000-000000000829'::uuid)",
    )
    .fetch_one(&mut *pool.acquire().await.unwrap())
    .await
    .unwrap());
    tokio::time::sleep(Duration::from_millis(1_100)).await;
    let second = worker.run_once().await.unwrap();
    assert_eq!(second.gc_completed, 1);
    assert_eq!(second.audit_events_deleted, 1);
    assert_eq!(backend.calls.load(Ordering::SeqCst), 2);
    let status: String =
        sqlx::query_scalar("SELECT status FROM gc_candidates WHERE object_key='bundles/policy-gc'")
            .fetch_one(&mut *pool.acquire().await.unwrap())
            .await
            .unwrap();
    assert_eq!(status, "completed");

    seed_unreferenced_bundle(
        pool,
        "0199ee6c-c777-7000-8000-000000000819",
        "0199ee6c-c777-7000-8000-000000000820",
        "0199ee6c-c777-7000-8000-000000000821",
        "bundles/policy-backup-held",
        "83",
        "gc-backup-held",
    )
    .await;
    sqlx::query(
        "INSERT INTO gc_candidates(object_key,expected_sha256,expected_bytes,reason,eligible_at) \
         VALUES('bundles/policy-backup-held',decode(repeat('83',32),'hex'),128,'reference_removed',transaction_timestamp())",
    )
    .execute(&mut *pool.acquire().await.unwrap())
    .await
    .unwrap();
    sqlx::query(
        "INSERT INTO object_retention_holds(object_key,holder_kind,holder_id) \
         VALUES('bundles/policy-backup-held','backup','0199ee6c-c777-7000-8000-000000000822'::uuid)",
    )
    .execute(&mut *pool.acquire().await.unwrap())
    .await
    .unwrap();
    let held = worker.run_once().await.unwrap();
    assert_eq!(held.gc_claimed, 0);
    assert_eq!(backend.calls.load(Ordering::SeqCst), 2);

    seed_unreferenced_bundle(
        pool,
        "0199ee6c-c777-7000-8000-000000000826",
        "0199ee6c-c777-7000-8000-000000000827",
        "0199ee6c-c777-7000-8000-000000000828",
        "bundles/policy-crash-recovery",
        "85",
        "gc-crash-recovery",
    )
    .await;
    sqlx::query(
        "INSERT INTO gc_candidates(object_key,expected_sha256,expected_bytes,reason,eligible_at) \
         VALUES('bundles/policy-crash-recovery',decode(repeat('85',32),'hex'),128,'reference_removed',transaction_timestamp())",
    )
    .execute(&mut *pool.acquire().await.unwrap())
    .await
    .unwrap();
    let mut claim_connection = pool.acquire().await.unwrap();
    let mut claim_tx = claim_connection.begin().await.unwrap();
    sqlx::query(
        "UPDATE gc_candidates SET status='running',attempts=1,started_at=transaction_timestamp(),updated_at=transaction_timestamp() \
         WHERE object_key='bundles/policy-crash-recovery'",
    )
    .execute(&mut *claim_tx)
    .await
    .unwrap();
    let hold_pool = pool.clone();
    let hold_race = tokio::spawn(async move {
        sqlx::query(
            "INSERT INTO object_retention_holds(object_key,holder_kind,holder_id) \
             VALUES('bundles/policy-crash-recovery','backup','0199ee6c-c777-7000-8000-000000000832'::uuid)",
        )
        .execute(&mut *hold_pool.acquire().await.unwrap())
        .await
    });
    tokio::time::sleep(Duration::from_millis(100)).await;
    assert!(!hold_race.is_finished());
    claim_tx.commit().await.unwrap();
    assert!(hold_race.await.unwrap().is_err());
    let recovered = worker.run_once().await.unwrap();
    assert_eq!(recovered.gc_claimed, 1);
    assert_eq!(recovered.gc_completed, 1);
    assert_eq!(backend.calls.load(Ordering::SeqCst), 3);
    let receipt: (String, String) = sqlx::query_as(
        "SELECT outcome,encode(expected_sha256,'hex') FROM gc_object_deletion_receipts \
         WHERE object_key='bundles/policy-crash-recovery'",
    )
    .fetch_one(&mut *pool.acquire().await.unwrap())
    .await
    .unwrap();
    assert_eq!(receipt, ("deleted".to_owned(), "85".repeat(32)));

    seed_unreferenced_bundle(
        pool,
        "0199ee6c-c777-7000-8000-000000000833",
        "0199ee6c-c777-7000-8000-000000000834",
        "0199ee6c-c777-7000-8000-000000000835",
        "bundles/policy-expired-lease",
        "86",
        "gc-expired-lease",
    )
    .await;
    sqlx::raw_sql(
        "INSERT INTO gc_candidates(object_key,expected_sha256,expected_bytes,reason,eligible_at) \
         VALUES('bundles/policy-expired-lease',decode(repeat('86',32),'hex'),128,'reference_removed',transaction_timestamp()); \
         UPDATE gc_candidates SET status='running',attempts=1,started_at=transaction_timestamp(),updated_at=transaction_timestamp() \
         WHERE object_key='bundles/policy-expired-lease'; \
         INSERT INTO gc_candidate_leases(object_key,lease_owner,lease_expires_at,created_at,updated_at) \
         VALUES('bundles/policy-expired-lease','0199ee6c-c777-7000-8000-000000000836'::uuid,transaction_timestamp()-interval '1 hour',transaction_timestamp()-interval '2 hours',transaction_timestamp()-interval '2 hours')",
    )
    .execute(&mut *pool.acquire().await.unwrap())
    .await
    .unwrap();
    let takeover = worker.run_once().await.unwrap();
    assert_eq!(takeover.gc_claimed, 1);
    assert_eq!(takeover.gc_completed, 1);
    assert_eq!(backend.calls.load(Ordering::SeqCst), 4);

    seed_unreferenced_bundle(
        pool,
        "0199ee6c-c777-7000-8000-000000000837",
        "0199ee6c-c777-7000-8000-000000000838",
        "0199ee6c-c777-7000-8000-000000000839",
        "bundles/policy-replica-a",
        "87",
        "gc-replica-a",
    )
    .await;
    seed_unreferenced_bundle(
        pool,
        "0199ee6c-c777-7000-8000-000000000840",
        "0199ee6c-c777-7000-8000-000000000841",
        "0199ee6c-c777-7000-8000-000000000842",
        "bundles/policy-replica-b",
        "88",
        "gc-replica-b",
    )
    .await;
    sqlx::raw_sql(
        "INSERT INTO gc_candidates(object_key,expected_sha256,expected_bytes,reason,eligible_at) VALUES \
         ('bundles/policy-replica-a',decode(repeat('87',32),'hex'),128,'reference_removed',transaction_timestamp()), \
         ('bundles/policy-replica-b',decode(repeat('88',32),'hex'),128,'reference_removed',transaction_timestamp())",
    )
    .execute(&mut *pool.acquire().await.unwrap())
    .await
    .unwrap();
    let (replica_a, replica_b) = tokio::join!(worker.run_once(), worker.run_once());
    let replica_a = replica_a.unwrap();
    let replica_b = replica_b.unwrap();
    assert_eq!(replica_a.gc_claimed + replica_b.gc_claimed, 2);
    assert_eq!(replica_a.gc_completed + replica_b.gc_completed, 2);
    let replica_receipts: i64 = sqlx::query_scalar(
        "SELECT COUNT(*) FROM gc_object_deletion_receipts \
         WHERE object_key IN ('bundles/policy-replica-a','bundles/policy-replica-b')",
    )
    .fetch_one(&mut *pool.acquire().await.unwrap())
    .await
    .unwrap();
    assert_eq!(replica_receipts, 2);
    assert_eq!(backend.calls.load(Ordering::SeqCst), 6);

    seed_unreferenced_bundle(
        pool,
        "0199ee6c-c777-7000-8000-000000000813",
        "0199ee6c-c777-7000-8000-000000000817",
        "0199ee6c-c777-7000-8000-000000000818",
        "bundles/policy-disabled",
        "82",
        "gc-disabled",
    )
    .await;
    sqlx::query(
        "INSERT INTO gc_candidates(object_key,expected_sha256,expected_bytes,reason,eligible_at) \
         VALUES('bundles/policy-disabled',decode(repeat('82',32),'hex'),128,'reference_removed',transaction_timestamp())",
    )
    .execute(&mut *pool.acquire().await.unwrap())
    .await
    .unwrap();
    update_setting(pool, "object_storage.gc.enabled", json!(false)).await;
    let disabled = worker.run_once().await.unwrap();
    assert_eq!(disabled.gc_claimed, 0);
    assert_eq!(backend.calls.load(Ordering::SeqCst), 6);
}

#[allow(clippy::too_many_arguments)]
async fn seed_unreferenced_bundle(
    pool: &DatabasePool,
    bundle_id: &str,
    project_id: &str,
    session_id: &str,
    object_key: &str,
    digest_byte: &str,
    slug: &str,
) {
    let mut connection = pool.acquire().await.unwrap();
    let mut tx = connection.begin().await.unwrap();
    sqlx::query(
        "INSERT INTO projects(id,owner_user_id,storage_scope_id,slug,name) \
         VALUES($1::uuid,$2::uuid,$3::uuid,$4,'Policy GC fixture')",
    )
    .bind(project_id)
    .bind(USER_ID)
    .bind(SCOPE_ID)
    .bind(slug)
    .execute(&mut *tx)
    .await
    .unwrap();
    sqlx::query(
        "INSERT INTO save_sessions(id,project_id,storage_scope_id,actor_user_id,expected_project_version,expected_bundle_sha256,expected_physical_bytes,expected_logical_bytes,expected_file_count,staging_object_key,upload_mode,expires_at) \
         VALUES($1::uuid,$2::uuid,$3::uuid,$4::uuid,1,decode(repeat($5,32),'hex'),128,64,1,$6,'single',transaction_timestamp()+interval '1 hour')",
    )
    .bind(session_id)
    .bind(project_id)
    .bind(SCOPE_ID)
    .bind(USER_ID)
    .bind(digest_byte)
    .bind(object_key)
    .execute(&mut *tx)
    .await
    .unwrap();
    sqlx::query("UPDATE save_sessions SET state='uploading',updated_at=transaction_timestamp() WHERE id=$1::uuid")
        .bind(session_id).execute(&mut *tx).await.unwrap();
    sqlx::query("UPDATE save_sessions SET state='verifying',updated_at=transaction_timestamp() WHERE id=$1::uuid")
        .bind(session_id).execute(&mut *tx).await.unwrap();
    sqlx::query(
        "INSERT INTO bundles(id,sha256,object_key,physical_bytes,logical_bytes,file_count,format,verified_at) \
         VALUES($1::uuid,decode(repeat($2,32),'hex'),$3,128,64,1,'project-bundle-v1',transaction_timestamp())",
    )
    .bind(bundle_id)
    .bind(digest_byte)
    .bind(object_key)
    .execute(&mut *tx)
    .await
    .unwrap();
    sqlx::query("UPDATE save_sessions SET state='committed',committed_bundle_id=$2::uuid,terminal_at=transaction_timestamp(),updated_at=transaction_timestamp() WHERE id=$1::uuid")
        .bind(session_id).bind(bundle_id).execute(&mut *tx).await.unwrap();
    tx.commit().await.unwrap();
}

async fn verify_live_invitation_policy(pool: &DatabasePool) {
    update_setting(pool, "invitations.default_expiry_hours", json!(24)).await;
    let user_id = UserId::from_uuid(Uuid::parse_str(USER_ID).unwrap()).unwrap();
    let service = InvitationService::new_live_default(pool.clone(), Duration::from_secs(5));
    let audit = InvitationAuditContext::new(
        AuditEventId::new(),
        AuditActor {
            kind: ActorType::User,
            id: user_id.to_string(),
            user_id: Some(user_id),
            display_name: Some("Policy fixture".into()),
        },
        "policy-engine-invitation".into(),
        None,
        "primary".into(),
    );
    let issued = service
        .issue("invited@example.test", user_id, &audit)
        .await
        .unwrap();
    let (invitation, _token) = issued.into_parts();
    let fields = invitation.into_fields();
    assert_eq!(
        (fields.expires_at.into_datetime() - fields.created_at.into_datetime()).whole_seconds(),
        24 * 60 * 60
    );
}

async fn verify_live_organization_invitation_policy(pool: &DatabasePool) {
    const INVITEE_ID: &str = "0199ee6c-c777-7000-8000-000000000843";
    const ORGANIZATION_ID: &str = "0199ee6c-c777-7000-8000-000000000844";
    const SESSION_ID: &str = "0199ee6c-c777-7000-8000-000000000845";
    update_setting(pool, "invitations.default_expiry_hours", json!(36)).await;
    sqlx::raw_sql(
        "INSERT INTO users(id,email,normalized_email,display_name) VALUES \
         ('0199ee6c-c777-7000-8000-000000000843'::uuid,'org-invitee@example.test','org-invitee@example.test','Organization Invitee'); \
         INSERT INTO organizations(id,slug,display_name) VALUES \
         ('0199ee6c-c777-7000-8000-000000000844'::uuid,'policy-live-org','Policy live organization'); \
         INSERT INTO organization_memberships(organization_id,user_id,role) VALUES \
         ('0199ee6c-c777-7000-8000-000000000844'::uuid,'0199ee6c-c777-7000-8000-000000000801'::uuid,'owner'); \
         INSERT INTO sessions(id,user_id,token_hash,idle_expires_at,absolute_expires_at,last_reauthenticated_at) VALUES \
         ('0199ee6c-c777-7000-8000-000000000845'::uuid,'0199ee6c-c777-7000-8000-000000000801'::uuid,decode(repeat('91',32),'hex'),transaction_timestamp()+interval '1 hour',transaction_timestamp()+interval '2 hours',transaction_timestamp())",
    )
    .execute(&mut *pool.acquire().await.unwrap())
    .await
    .unwrap();

    let owner = UserId::from_uuid(Uuid::parse_str(USER_ID).unwrap()).unwrap();
    let service = OrganizationInvitationService::new_live(
        pool.clone(),
        OrganizationInvitationPolicy::default(),
    );
    let issued = service
        .issue(
            OrganizationId::from_uuid(Uuid::parse_str(ORGANIZATION_ID).unwrap()).unwrap(),
            OrganizationInvitationActor::new(
                owner,
                SessionId::from_uuid(Uuid::parse_str(SESSION_ID).unwrap()).unwrap(),
            ),
            NormalizedEmail::parse("org-invitee@example.test".to_owned()).unwrap(),
            OrganizationRole::Member,
            &OrganizationInvitationAuditContext::new(
                AuditEventId::new(),
                owner,
                Some("Policy fixture".into()),
                "policy-engine-organization-invitation".into(),
                None,
            ),
        )
        .await
        .unwrap();
    let (invitation, _token) = issued.into_parts();
    let fields = invitation.into_fields();
    assert_eq!(fields.invitee_user_id.to_string(), INVITEE_ID);
    assert_eq!(
        (fields.expires_at.into_datetime() - fields.created_at.into_datetime()).whole_seconds(),
        36 * 60 * 60
    );
}

async fn verify_live_session_policy(pool: &DatabasePool) {
    update_setting(pool, "sessions.idle_timeout_minutes", json!(60)).await;
    update_setting(pool, "sessions.absolute_timeout_minutes", json!(180)).await;
    let service = SessionService::new(pool.clone(), SessionPolicy::default());
    let issued = service
        .issue(UserId::from_uuid(Uuid::parse_str(USER_ID).unwrap()).unwrap())
        .await
        .unwrap();
    let idle_seconds: i64 = sqlx::query_scalar(
        "SELECT FLOOR(EXTRACT(EPOCH FROM (idle_expires_at-created_at)))::bigint FROM sessions WHERE id=$1::uuid",
    )
    .bind(issued.session().id().to_string())
    .fetch_one(&mut *pool.acquire().await.unwrap())
    .await
    .unwrap();
    assert_eq!(idle_seconds, 60 * 60);

    update_setting(pool, "sessions.idle_timeout_minutes", json!(120)).await;
    service.authenticate(issued.token()).await.unwrap();
    let refreshed_seconds: i64 = sqlx::query_scalar(
        "SELECT FLOOR(EXTRACT(EPOCH FROM (idle_expires_at-last_seen_at)))::bigint FROM sessions WHERE id=$1::uuid",
    )
    .bind(issued.session().id().to_string())
    .fetch_one(&mut *pool.acquire().await.unwrap())
    .await
    .unwrap();
    assert_eq!(refreshed_seconds, 60 * 60);
    let original_absolute_seconds: i64 = sqlx::query_scalar(
        "SELECT FLOOR(EXTRACT(EPOCH FROM (absolute_expires_at-created_at)))::bigint FROM sessions WHERE id=$1::uuid",
    )
    .bind(issued.session().id().to_string())
    .fetch_one(&mut *pool.acquire().await.unwrap())
    .await
    .unwrap();
    assert_eq!(original_absolute_seconds, 180 * 60);

    update_setting(pool, "sessions.absolute_timeout_minutes", json!(240)).await;
    service.authenticate(issued.token()).await.unwrap();
    let unchanged_absolute_seconds: i64 = sqlx::query_scalar(
        "SELECT FLOOR(EXTRACT(EPOCH FROM (absolute_expires_at-created_at)))::bigint FROM sessions WHERE id=$1::uuid",
    )
    .bind(issued.session().id().to_string())
    .fetch_one(&mut *pool.acquire().await.unwrap())
    .await
    .unwrap();
    assert_eq!(unchanged_absolute_seconds, 180 * 60);

    let increased = service
        .issue(UserId::from_uuid(Uuid::parse_str(USER_ID).unwrap()).unwrap())
        .await
        .unwrap();
    let increased_seconds: i64 = sqlx::query_scalar(
        "SELECT FLOOR(EXTRACT(EPOCH FROM (idle_expires_at-created_at)))::bigint FROM sessions WHERE id=$1::uuid",
    )
    .bind(increased.session().id().to_string())
    .fetch_one(&mut *pool.acquire().await.unwrap())
    .await
    .unwrap();
    assert_eq!(increased_seconds, 120 * 60);
    let increased_absolute_seconds: i64 = sqlx::query_scalar(
        "SELECT FLOOR(EXTRACT(EPOCH FROM (absolute_expires_at-created_at)))::bigint FROM sessions WHERE id=$1::uuid",
    )
    .bind(increased.session().id().to_string())
    .fetch_one(&mut *pool.acquire().await.unwrap())
    .await
    .unwrap();
    assert_eq!(increased_absolute_seconds, 240 * 60);

    update_setting(pool, "sessions.idle_timeout_minutes", json!(30)).await;
    update_setting(pool, "sessions.absolute_timeout_minutes", json!(90)).await;
    service.authenticate(increased.token()).await.unwrap();
    let decreased_seconds: i64 = sqlx::query_scalar(
        "SELECT FLOOR(EXTRACT(EPOCH FROM (idle_expires_at-last_seen_at)))::bigint FROM sessions WHERE id=$1::uuid",
    )
    .bind(increased.session().id().to_string())
    .fetch_one(&mut *pool.acquire().await.unwrap())
    .await
    .unwrap();
    assert_eq!(decreased_seconds, 30 * 60);
    let decreased_absolute_seconds: i64 = sqlx::query_scalar(
        "SELECT FLOOR(EXTRACT(EPOCH FROM (absolute_expires_at-created_at)))::bigint FROM sessions WHERE id=$1::uuid",
    )
    .bind(increased.session().id().to_string())
    .fetch_one(&mut *pool.acquire().await.unwrap())
    .await
    .unwrap();
    assert_eq!(decreased_absolute_seconds, 90 * 60);
}

async fn verify_live_quota_policy(pool: &DatabasePool) {
    let scope: String =
        sqlx::query_scalar("SELECT id::text FROM storage_scopes WHERE owner_user_id=$1::uuid")
            .bind(USER_ID)
            .fetch_one(&mut *pool.acquire().await.unwrap())
            .await
            .unwrap();
    update_setting(
        pool,
        "workspace.personal_default_quota_bytes",
        json!(2_097_152),
    )
    .await;
    let service = QuotaService::new_live(pool.clone(), QuotaServicePolicy::default());
    let projection = service
        .projection(
            StorageScopeId::from_uuid(Uuid::parse_str(&scope).unwrap()).unwrap(),
            nuriteo_server::quota::EffectiveQuota::unlimited(),
        )
        .await
        .unwrap();
    assert_eq!(projection.limit_bytes(), Some(2_097_152));

    let project_id = "0199ee6c-c777-7000-8000-000000000823";
    let session_id = "0199ee6c-c777-7000-8000-000000000824";
    sqlx::query(
        "INSERT INTO projects(id,owner_user_id,storage_scope_id,slug,name) \
         VALUES($1::uuid,$2::uuid,$3::uuid,'quota-live','Quota live fixture')",
    )
    .bind(project_id)
    .bind(USER_ID)
    .bind(SCOPE_ID)
    .execute(&mut *pool.acquire().await.unwrap())
    .await
    .unwrap();
    sqlx::query(
        "INSERT INTO save_sessions(id,project_id,storage_scope_id,actor_user_id,expected_project_version,expected_bundle_sha256,expected_physical_bytes,expected_logical_bytes,expected_file_count,staging_object_key,upload_mode,expires_at) \
         VALUES($1::uuid,$2::uuid,$3::uuid,$4::uuid,1,decode(repeat('84',32),'hex'),1500000,1500000,1,'bundles/quota-live','single',transaction_timestamp()+interval '1 hour')",
    )
    .bind(session_id)
    .bind(project_id)
    .bind(SCOPE_ID)
    .bind(USER_ID)
    .execute(&mut *pool.acquire().await.unwrap())
    .await
    .unwrap();
    update_setting(
        pool,
        "workspace.personal_default_quota_bytes",
        json!(1_048_576),
    )
    .await;
    let request = ReservationRequest {
        storage_scope_id: StorageScopeId::from_uuid(Uuid::parse_str(&scope).unwrap()).unwrap(),
        project_id: ProjectId::from_uuid(Uuid::parse_str(project_id).unwrap()).unwrap(),
        save_session_id: SaveSessionId::from_uuid(Uuid::parse_str(session_id).unwrap()).unwrap(),
        requested_bytes: 1_500_000,
        effective_quota: EffectiveQuota::unlimited(),
    };
    assert_eq!(
        service.reserve(request).await.unwrap_err(),
        QuotaServiceError::QuotaExceeded
    );
    update_setting(
        pool,
        "workspace.personal_default_quota_bytes",
        json!(2_097_152),
    )
    .await;
    assert_eq!(
        service
            .reserve(request)
            .await
            .unwrap()
            .projection()
            .reserved_bytes(),
        1_500_000
    );
}

async fn verify_update_and_read_are_serialized(pool: &DatabasePool) {
    let mut connection = pool.acquire().await.unwrap();
    let mut transaction = connection.begin().await.unwrap();
    sqlx::query(
        "UPDATE instance_settings SET value='240'::jsonb,lock_version=lock_version+1,updated_at=transaction_timestamp() \
         WHERE key='sessions.absolute_timeout_minutes'",
    )
    .execute(&mut *transaction)
    .await
    .unwrap();
    sqlx::query(
        "UPDATE instance_settings SET value='120'::jsonb,lock_version=lock_version+1,updated_at=transaction_timestamp() \
         WHERE key='sessions.idle_timeout_minutes'",
    )
    .execute(&mut *transaction)
    .await
    .unwrap();

    let engine = EffectivePolicyEngine::new(pool.clone(), Duration::from_secs(5)).unwrap();
    let reader = tokio::spawn(async move { engine.load().await.unwrap() });
    tokio::time::sleep(Duration::from_millis(100)).await;
    assert!(
        !reader.is_finished(),
        "policy read must wait for the setting update transaction"
    );
    transaction.commit().await.unwrap();
    let snapshot = reader.await.unwrap();
    assert_eq!(
        snapshot.value("sessions.idle_timeout_minutes"),
        Some(&json!(120))
    );
}

async fn update_setting(pool: &DatabasePool, key: &str, value: serde_json::Value) {
    sqlx::query(
        "UPDATE instance_settings SET value=$2::jsonb,lock_version=lock_version+1,updated_at=transaction_timestamp() WHERE key=$1",
    )
    .bind(key)
    .bind(value.to_string())
    .execute(&mut *pool.acquire().await.unwrap())
    .await
    .unwrap();
}

async fn seed_user(pool: &DatabasePool) {
    sqlx::query(
        "INSERT INTO users (id,email,normalized_email,display_name,is_instance_admin) \
         VALUES ($1::uuid,'policy@example.test','policy@example.test','Policy fixture',TRUE)",
    )
    .bind(USER_ID)
    .execute(&mut *pool.acquire().await.unwrap())
    .await
    .unwrap();
    sqlx::query("INSERT INTO storage_scopes (id,owner_user_id) VALUES ($1::uuid,$2::uuid)")
        .bind(SCOPE_ID)
        .bind(USER_ID)
        .execute(&mut *pool.acquire().await.unwrap())
        .await
        .unwrap();
}

async fn fixture_pool() -> DatabasePool {
    let database_url = env::var(DATABASE_URL_ENV).unwrap();
    let ca = fs::read(env::var(DATABASE_CA_ENV).unwrap()).unwrap();
    let tls = DatabaseTlsConfig::verify_full(None, Some(ca), None).unwrap();
    DatabasePool::connect(
        DatabasePoolConfig::new(
            database_url,
            1,
            8,
            Duration::from_secs(5),
            Duration::from_secs(2),
            tls,
        )
        .unwrap(),
    )
    .await
    .unwrap()
}

async fn reset_fixture(pool: &DatabasePool) {
    let mut connection = pool.acquire().await.unwrap();
    connection
        .execute("DROP SCHEMA public CASCADE")
        .await
        .unwrap();
    connection.execute("CREATE SCHEMA public").await.unwrap();
}
