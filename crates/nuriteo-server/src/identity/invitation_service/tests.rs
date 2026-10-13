use super::*;

use std::env;
use std::fs;
use std::sync::Arc;

use crate::database::{
    DatabasePoolConfig, DatabaseTlsConfig, MigrationOptions, run_embedded_migrations,
};
use crate::workspace::PersonalStorageScopeRepository;

const DATABASE_URL_ENV: &str = "NURITEO_TEST_DATABASE_URL";
const DATABASE_CA_ENV: &str = "NURITEO_TEST_DATABASE_CA";

#[test]
fn policy_bounds_are_explicit() {
    let policy = InvitationServicePolicy::default();
    assert_eq!(policy.expiry(), InvitationExpiryPolicy::default());
    assert_eq!(policy.operation_timeout(), Duration::from_secs(5));
    for timeout in [MIN_OPERATION_TIMEOUT, MAX_OPERATION_TIMEOUT] {
        assert!(InvitationServicePolicy::new(InvitationExpiryPolicy::default(), timeout).is_ok());
    }
    for timeout in [
        MIN_OPERATION_TIMEOUT - Duration::from_millis(1),
        MAX_OPERATION_TIMEOUT + Duration::from_millis(1),
    ] {
        assert_eq!(
            InvitationServicePolicy::new(InvitationExpiryPolicy::default(), timeout),
            Err(InvitationServicePolicyError::InvalidOperationTimeout)
        );
    }
}

#[test]
fn service_errors_never_contain_invitation_or_database_context() {
    let token = ActivationToken::generate().unwrap_or_else(|error| panic!("{error}"));
    for error in [
        InvitationServiceError::AlreadyPending,
        InvitationServiceError::InvalidInvitation,
        InvitationServiceError::InvitationNotPending,
        InvitationServiceError::ActivationFailed,
        InvitationServiceError::AuditUnavailable,
        InvitationServiceError::DatabaseUnavailable,
        InvitationServiceError::OperationTimeout,
    ] {
        let rendered = format!("{error:?}: {error}");
        assert!(!rendered.contains(token.expose()));
        assert!(!rendered.contains("postgres://"));
    }
}

#[tokio::test]
#[ignore = "requires the pinned PostgreSQL TLS fixture; run tests/fixtures/postgres-invitation-service/run.sh"]
async fn real_postgres_enforces_atomic_invitation_lifecycle() {
    let pool = fixture_pool().await;
    reset_fixture(&pool).await;
    migrate(&pool).await;
    let admin = UserId::new();
    insert_admin(&pool, admin).await;
    let service = InvitationService::new(pool.clone(), InvitationServicePolicy::default());

    verify_issue_reissue_revoke(&pool, &service, admin).await;
    verify_activation_and_audit_rollback(&pool, &service, admin).await;
    verify_concurrent_issue(&pool, &service, admin).await;
    verify_competing_terminal_transitions(&pool, &service, admin).await;

    reset_fixture(&pool).await;
    pool.close(Duration::from_secs(2))
        .await
        .unwrap_or_else(|_| panic!("invitation service fixture pool must close"));
}

async fn verify_issue_reissue_revoke(
    pool: &DatabasePool,
    service: &InvitationService,
    admin: UserId,
) {
    let issued = service
        .issue(
            "Member@Example.test",
            admin,
            &admin_audit(admin, AuditEventId::new(), "issue"),
        )
        .await
        .unwrap_or_else(|error| panic!("issue must succeed: {error}"));
    let issued_id = issued.invitation().id();
    assert_eq!(
        issued.invitation().status(),
        ActivationInvitationStatus::Pending
    );
    assert_secret_absent(pool, issued.token()).await;

    assert_eq!(
        service
            .issue(
                "member@example.test",
                admin,
                &admin_audit(admin, AuditEventId::new(), "duplicate-issue"),
            )
            .await
            .map(|_| ()),
        Err(InvitationServiceError::AlreadyPending)
    );
    assert_eq!(pending_count(pool, "member@example.test").await, 1);

    let reissued = service
        .reissue(
            issued_id,
            &admin_audit(admin, AuditEventId::new(), "reissue"),
        )
        .await
        .unwrap_or_else(|error| panic!("reissue must succeed: {error}"));
    let replacement_id = reissued.invitation().id();
    assert_eq!(status(pool, issued_id).await, "superseded");
    assert_eq!(replacement(pool, issued_id).await, Some(replacement_id));
    assert_eq!(pending_count(pool, "member@example.test").await, 1);
    assert_secret_absent(pool, reissued.token()).await;

    let noop = NoopActivator;
    assert_eq!(
        service
            .accept(
                issued.token(),
                &system_audit(AuditEventId::new(), "superseded-token"),
                &noop,
            )
            .await,
        Err(InvitationServiceError::InvalidInvitation)
    );

    assert_eq!(
        service
            .revoke(
                replacement_id,
                &admin_audit(admin, AuditEventId::new(), "revoke"),
            )
            .await,
        Ok(InvitationRevokeResult::Revoked)
    );
    assert_eq!(
        service
            .revoke(
                replacement_id,
                &admin_audit(admin, AuditEventId::new(), "revoke-repeat"),
            )
            .await,
        Ok(InvitationRevokeResult::AlreadyInactive)
    );
    assert_eq!(status(pool, replacement_id).await, "revoked");
}

async fn verify_activation_and_audit_rollback(
    pool: &DatabasePool,
    service: &InvitationService,
    admin: UserId,
) {
    let issued = service
        .issue(
            "activate@example.test",
            admin,
            &admin_audit(admin, AuditEventId::new(), "activation-issue"),
        )
        .await
        .unwrap_or_else(|error| panic!("activation invitation must issue: {error}"));
    let id = issued.invitation().id();
    let user_id = UserId::new();
    let failing = UserCredentialActivator {
        user_id,
        fail_after_write: true,
    };
    assert_eq!(
        service
            .accept(
                issued.token(),
                &system_audit(AuditEventId::new(), "activation-fails"),
                &failing,
            )
            .await,
        Err(InvitationServiceError::ActivationFailed)
    );
    assert_eq!(status(pool, id).await, "pending");
    assert!(!user_exists(pool, user_id).await);
    assert!(!scope_exists(pool, user_id).await);

    let duplicate_audit_id = AuditEventId::new();
    seed_audit_event(pool, duplicate_audit_id).await;
    let activating = UserCredentialActivator {
        user_id,
        fail_after_write: false,
    };
    assert_eq!(
        service
            .accept(
                issued.token(),
                &system_audit(duplicate_audit_id, "audit-fails"),
                &activating,
            )
            .await,
        Err(InvitationServiceError::AuditUnavailable)
    );
    assert_eq!(status(pool, id).await, "pending");
    assert!(!user_exists(pool, user_id).await);
    assert!(!scope_exists(pool, user_id).await);

    let accepted = service
        .accept(
            issued.token(),
            &system_audit(AuditEventId::new(), "activation-success"),
            &activating,
        )
        .await
        .unwrap_or_else(|error| panic!("atomic activation must succeed: {error}"));
    assert_eq!(accepted.status(), ActivationInvitationStatus::Accepted);
    assert!(user_exists(pool, user_id).await);
    assert!(credential_exists(pool, user_id).await);
    assert!(scope_exists(pool, user_id).await);
    assert_eq!(status(pool, id).await, "accepted");
    assert_secret_absent(pool, issued.token()).await;

    assert_eq!(
        service
            .accept(
                issued.token(),
                &system_audit(AuditEventId::new(), "activation-replay"),
                &NoopActivator,
            )
            .await,
        Err(InvitationServiceError::InvalidInvitation)
    );
}

async fn verify_concurrent_issue(pool: &DatabasePool, service: &InvitationService, admin: UserId) {
    let first = tokio::spawn({
        let service = service.clone();
        async move {
            service
                .issue(
                    "race-issue@example.test",
                    admin,
                    &admin_audit(admin, AuditEventId::new(), "race-issue-1"),
                )
                .await
        }
    });
    let second = tokio::spawn({
        let service = service.clone();
        async move {
            service
                .issue(
                    "race-issue@example.test",
                    admin,
                    &admin_audit(admin, AuditEventId::new(), "race-issue-2"),
                )
                .await
        }
    });
    let outcomes = [
        first
            .await
            .unwrap_or_else(|_| panic!("first issue task must join")),
        second
            .await
            .unwrap_or_else(|_| panic!("second issue task must join")),
    ];
    assert_eq!(outcomes.iter().filter(|outcome| outcome.is_ok()).count(), 1);
    assert_eq!(
        outcomes
            .iter()
            .filter(|outcome| matches!(outcome, Err(InvitationServiceError::AlreadyPending)))
            .count(),
        1
    );
    assert_eq!(pending_count(pool, "race-issue@example.test").await, 1);
}

async fn verify_competing_terminal_transitions(
    pool: &DatabasePool,
    service: &InvitationService,
    admin: UserId,
) {
    let issued = service
        .issue(
            "race-terminal@example.test",
            admin,
            &admin_audit(admin, AuditEventId::new(), "race-terminal-issue"),
        )
        .await
        .unwrap_or_else(|error| panic!("race invitation must issue: {error}"));
    let (invitation, token) = issued.into_parts();
    let id = invitation.id();
    let token = Arc::new(token);

    let accept = tokio::spawn({
        let service = service.clone();
        let token = Arc::clone(&token);
        async move {
            service
                .accept(
                    &token,
                    &system_audit(AuditEventId::new(), "race-accept"),
                    &UserCredentialActivator {
                        user_id: UserId::new(),
                        fail_after_write: false,
                    },
                )
                .await
                .is_ok()
        }
    });
    let reissue = tokio::spawn({
        let service = service.clone();
        async move {
            service
                .reissue(id, &admin_audit(admin, AuditEventId::new(), "race-reissue"))
                .await
                .is_ok()
        }
    });
    let revoke = tokio::spawn({
        let service = service.clone();
        async move {
            service
                .revoke(id, &admin_audit(admin, AuditEventId::new(), "race-revoke"))
                .await
                .is_ok_and(|value| value == InvitationRevokeResult::Revoked)
        }
    });
    let successes = [
        accept
            .await
            .unwrap_or_else(|_| panic!("accept race task must join")),
        reissue
            .await
            .unwrap_or_else(|_| panic!("reissue race task must join")),
        revoke
            .await
            .unwrap_or_else(|_| panic!("revoke race task must join")),
    ];
    assert_eq!(successes.into_iter().filter(|success| *success).count(), 1);
    assert_ne!(status(pool, id).await, "pending");
}

struct NoopActivator;

impl InvitationActivator for NoopActivator {
    fn activate<'a>(
        &'a self,
        _transaction: &'a mut Transaction<'_, Postgres>,
        _invitation: &'a PendingInvitationActivation,
    ) -> InvitationActivationFuture<'a> {
        Box::pin(async { Ok(()) })
    }
}

struct UserCredentialActivator {
    user_id: UserId,
    fail_after_write: bool,
}

impl InvitationActivator for UserCredentialActivator {
    fn activate<'a>(
        &'a self,
        transaction: &'a mut Transaction<'_, Postgres>,
        invitation: &'a PendingInvitationActivation,
    ) -> InvitationActivationFuture<'a> {
        Box::pin(async move {
            let email = invitation.normalized_email().as_str();
            sqlx::query(
                "INSERT INTO users (id, email, normalized_email, display_name) \
                 VALUES ($1::uuid, $2, $2, 'Invited member')",
            )
            .bind(self.user_id.to_string())
            .bind(email)
            .execute(&mut **transaction)
            .await
            .map_err(|_| InvitationActivationError::DatabaseUnavailable)?;
            sqlx::query(
                "INSERT INTO local_password_credentials (user_id, password_verifier) \
                 VALUES ($1::uuid, $2)",
            )
            .bind(self.user_id.to_string())
            .bind("$argon2id$v=19$m=19456,t=2,p=1$c2FsdHNhbHQ$dmVyaWZpZXJvdXRwdXRieXRlcw")
            .execute(&mut **transaction)
            .await
            .map_err(|_| InvitationActivationError::DatabaseUnavailable)?;
            let now = Timestamp::from_datetime(OffsetDateTime::now_utc())
                .map_err(|_| InvitationActivationError::InvariantViolation)?;
            PersonalStorageScopeRepository::provision(transaction, self.user_id, now)
                .await
                .map_err(|_| InvitationActivationError::DatabaseUnavailable)?;
            if self.fail_after_write {
                return Err(InvitationActivationError::Rejected);
            }
            Ok(())
        })
    }
}

fn admin_audit(admin: UserId, event_id: AuditEventId, correlation: &str) -> InvitationAuditContext {
    InvitationAuditContext::new(
        event_id,
        AuditActor {
            kind: ActorType::User,
            id: admin.to_string(),
            user_id: Some(admin),
            display_name: Some("Fixture admin".into()),
        },
        correlation.into(),
        None,
        "primary".into(),
    )
}

fn system_audit(event_id: AuditEventId, correlation: &str) -> InvitationAuditContext {
    InvitationAuditContext::new(
        event_id,
        AuditActor {
            kind: ActorType::System,
            id: "activation".into(),
            user_id: None,
            display_name: None,
        },
        correlation.into(),
        None,
        "primary".into(),
    )
}

async fn fixture_pool() -> DatabasePool {
    let database_url = env::var(DATABASE_URL_ENV)
        .unwrap_or_else(|_| panic!("{DATABASE_URL_ENV} must be set by the fixture"));
    let ca_path = env::var(DATABASE_CA_ENV)
        .unwrap_or_else(|_| panic!("{DATABASE_CA_ENV} must be set by the fixture"));
    let ca = fs::read(ca_path).unwrap_or_else(|_| panic!("fixture CA must be readable"));
    let tls = DatabaseTlsConfig::verify_full(None, Some(ca), None)
        .unwrap_or_else(|_| panic!("fixture TLS must be valid"));
    let config = DatabasePoolConfig::new(
        database_url,
        0,
        12,
        Duration::from_secs(5),
        Duration::from_secs(5),
        tls,
    )
    .unwrap_or_else(|_| panic!("fixture database configuration must be valid"));
    DatabasePool::connect(config)
        .await
        .unwrap_or_else(|_| panic!("fixture database must connect"))
}

async fn migrate(pool: &DatabasePool) {
    run_embedded_migrations(
        pool,
        MigrationOptions::new(Duration::from_secs(3), Duration::from_secs(20))
            .unwrap_or_else(|_| panic!("fixture migration options must be valid")),
    )
    .await
    .unwrap_or_else(|_| panic!("embedded migrations must succeed"));
}

async fn insert_admin(pool: &DatabasePool, admin: UserId) {
    sqlx::query(
        "INSERT INTO users \
         (id, email, normalized_email, display_name, status, is_instance_admin) \
         VALUES ($1::uuid, 'admin@example.test', 'admin@example.test', \
                 'Fixture admin', 'active', TRUE)",
    )
    .bind(admin.to_string())
    .execute(
        &mut *pool
            .acquire()
            .await
            .unwrap_or_else(|_| panic!("fixture acquire")),
    )
    .await
    .unwrap_or_else(|_| panic!("fixture admin must be inserted"));
}

async fn seed_audit_event(pool: &DatabasePool, event_id: AuditEventId) {
    let mut connection = pool
        .acquire()
        .await
        .unwrap_or_else(|_| panic!("fixture acquire"));
    let mut transaction = connection
        .begin()
        .await
        .unwrap_or_else(|_| panic!("audit seed transaction must begin"));
    let event = AuditEvent::new(AuditEventFields {
        id: event_id,
        occurred_at: Timestamp::from_datetime(OffsetDateTime::now_utc())
            .unwrap_or_else(|_| panic!("fixture timestamp")),
        actor: AuditActor {
            kind: ActorType::System,
            id: "fixture".into(),
            user_id: None,
            display_name: None,
        },
        action_code: "fixture.seed".into(),
        target: AuditTarget {
            kind: "activation_invitation".into(),
            id: "fixture".into(),
        },
        scope: AuditScope {
            kind: ScopeType::Instance,
            id: "primary".into(),
        },
        result: AuditResult::Succeeded,
        reason_code: None,
        correlation_id: "fixture-seed".into(),
        source_ip: None,
        schema_version: 1,
        changed_fields: Vec::new(),
        metadata: AuditMetadata::new(json!({})).unwrap_or_else(|_| panic!("fixture metadata")),
    })
    .unwrap_or_else(|_| panic!("fixture audit event must be valid"));
    AuditWriter::append(&mut transaction, &event)
        .await
        .unwrap_or_else(|_| panic!("fixture audit event must append"));
    transaction
        .commit()
        .await
        .unwrap_or_else(|_| panic!("fixture audit event must commit"));
}

async fn status(pool: &DatabasePool, id: ActivationInvitationId) -> String {
    sqlx::query_scalar("SELECT status FROM activation_invitations WHERE id = $1::uuid")
        .bind(id.to_string())
        .fetch_one(
            &mut *pool
                .acquire()
                .await
                .unwrap_or_else(|_| panic!("fixture acquire")),
        )
        .await
        .unwrap_or_else(|_| panic!("invitation status must be readable"))
}

async fn replacement(
    pool: &DatabasePool,
    id: ActivationInvitationId,
) -> Option<ActivationInvitationId> {
    sqlx::query_scalar::<_, Option<String>>(
        "SELECT replaced_by_invitation_id::text FROM activation_invitations WHERE id = $1::uuid",
    )
    .bind(id.to_string())
    .fetch_one(
        &mut *pool
            .acquire()
            .await
            .unwrap_or_else(|_| panic!("fixture acquire")),
    )
    .await
    .unwrap_or_else(|_| panic!("replacement lineage must be readable"))
    .map(|value| {
        value
            .parse()
            .unwrap_or_else(|_| panic!("replacement ID must be valid"))
    })
}

async fn pending_count(pool: &DatabasePool, email: &str) -> i64 {
    sqlx::query_scalar(
        "SELECT COUNT(*) FROM activation_invitations \
         WHERE normalized_email = $1 AND status = 'pending'",
    )
    .bind(email)
    .fetch_one(
        &mut *pool
            .acquire()
            .await
            .unwrap_or_else(|_| panic!("fixture acquire")),
    )
    .await
    .unwrap_or_else(|_| panic!("pending count must be readable"))
}

async fn user_exists(pool: &DatabasePool, id: UserId) -> bool {
    sqlx::query_scalar("SELECT EXISTS(SELECT 1 FROM users WHERE id = $1::uuid)")
        .bind(id.to_string())
        .fetch_one(
            &mut *pool
                .acquire()
                .await
                .unwrap_or_else(|_| panic!("fixture acquire")),
        )
        .await
        .unwrap_or_else(|_| panic!("user existence must be readable"))
}

async fn scope_exists(pool: &DatabasePool, id: UserId) -> bool {
    sqlx::query_scalar("SELECT EXISTS(SELECT 1 FROM storage_scopes WHERE owner_user_id = $1::uuid)")
        .bind(id.to_string())
        .fetch_one(
            &mut *pool
                .acquire()
                .await
                .unwrap_or_else(|_| panic!("fixture acquire")),
        )
        .await
        .unwrap_or_else(|_| panic!("scope existence must be readable"))
}

async fn credential_exists(pool: &DatabasePool, id: UserId) -> bool {
    sqlx::query_scalar(
        "SELECT EXISTS(SELECT 1 FROM local_password_credentials WHERE user_id = $1::uuid)",
    )
    .bind(id.to_string())
    .fetch_one(
        &mut *pool
            .acquire()
            .await
            .unwrap_or_else(|_| panic!("fixture acquire")),
    )
    .await
    .unwrap_or_else(|_| panic!("credential existence must be readable"))
}

async fn assert_secret_absent(pool: &DatabasePool, token: &ActivationToken) {
    let invitation_rows: String = sqlx::query_scalar(
        "SELECT COALESCE(json_agg(row_to_json(i))::text, '[]') FROM activation_invitations i",
    )
    .fetch_one(
        &mut *pool
            .acquire()
            .await
            .unwrap_or_else(|_| panic!("fixture acquire")),
    )
    .await
    .unwrap_or_else(|_| panic!("invitation rows must be readable"));
    let audit_rows: String = sqlx::query_scalar(
        "SELECT COALESCE(json_agg(row_to_json(a))::text, '[]') FROM audit_events a",
    )
    .fetch_one(
        &mut *pool
            .acquire()
            .await
            .unwrap_or_else(|_| panic!("fixture acquire")),
    )
    .await
    .unwrap_or_else(|_| panic!("audit rows must be readable"));
    assert!(!invitation_rows.contains(token.expose()));
    assert!(!audit_rows.contains(token.expose()));
}

async fn reset_fixture(pool: &DatabasePool) {
    let mut connection = pool
        .acquire()
        .await
        .unwrap_or_else(|_| panic!("fixture acquire"));
    for statement in [
        "DROP TABLE IF EXISTS organization_memberships CASCADE",
        "DROP TABLE IF EXISTS organizations CASCADE",
        "DROP TABLE IF EXISTS storage_scopes CASCADE",
        "DROP TABLE IF EXISTS local_auth_failures CASCADE",
        "DROP TABLE IF EXISTS activation_invitations CASCADE",
        "DROP TABLE IF EXISTS audit_events CASCADE",
        "DROP TABLE IF EXISTS sessions CASCADE",
        "DROP TABLE IF EXISTS oidc_identities CASCADE",
        "DROP TABLE IF EXISTS oidc_providers CASCADE",
        "DROP TABLE IF EXISTS local_password_credentials CASCADE",
        "DROP TABLE IF EXISTS users CASCADE",
        "DROP TABLE IF EXISTS _sqlx_migrations CASCADE",
    ] {
        sqlx::query(statement)
            .execute(&mut *connection)
            .await
            .unwrap_or_else(|_| panic!("fixture reset must succeed"));
    }
}
