use std::env;
use std::fs;
use std::future::Future;
use std::pin::Pin;
use std::sync::Arc;
use std::time::Duration;

use nuriteo_server::app::{ShutdownReason, Supervisor, SupervisorConfig};
use nuriteo_server::audit::{ActorType, AuditActor, AuditEventId};
use nuriteo_server::config::{InstanceSettingBootstrap, SystemEnvironment, SystemFileReader};
use nuriteo_server::database::{
    DatabasePool, DatabasePoolConfig, DatabaseTlsConfig, MigrationOptions, run_embedded_migrations,
};
use nuriteo_server::identity::{
    ActivationToken, InvitationActivationError, InvitationActivationFuture, InvitationActivator,
    InvitationAuditContext, InvitationService, InvitationServiceError, InvitationServicePolicy,
    PendingInvitationActivation,
};
use nuriteo_server::instance_settings::InstanceSettingsRepository;
use nuriteo_server::integration::{IntegrationRepository, MasterKeyring};
use nuriteo_server::notification::{
    ClaimedEmail, DatabaseDeliveryEligibility, DatabaseInvitationAttemptTokenIssuer,
    DeliveryBoundaryError, DeliveryEligibility, DeliveryEligibilityDecision, EmailAttemptPreparer,
    EmailOutboxRepository, InvitationAttemptContext, InvitationAttemptTokenIssuer,
    NotificationWorker, NotificationWorkerPolicy, PreparedEmail, ProductionEmailAttemptPreparer,
};
use nuriteo_server::smtp::SmtpEmailSender;
use sha2::{Digest, Sha256};
use sqlx::{Executor, Postgres, Row, Transaction};
use url::Url;

const DATABASE_URL_ENV: &str = "NURITEO_TEST_DATABASE_URL";
const DATABASE_CA_ENV: &str = "NURITEO_TEST_DATABASE_CA";
const SMTP_PORT_ENV: &str = "NURITEO_SMTP_PORT";

#[derive(Debug)]
struct FixturePreparer;

impl EmailAttemptPreparer for FixturePreparer {
    fn prepare<'a>(
        &'a self,
        _email: &'a ClaimedEmail,
        invitation_token: Option<&'a nuriteo_server::notification::InvitationAttemptToken>,
    ) -> Pin<Box<dyn Future<Output = Result<PreparedEmail, DeliveryBoundaryError>> + Send + 'a>>
    {
        Box::pin(async move {
            assert!(invitation_token.is_none());
            PreparedEmail::new(
                "보안 알림 \"quoted\"".to_owned(),
                "첫 줄\n.둘째 줄\n민감 본문 fixture-body-sensitive".to_owned(),
            )
        })
    }
}

#[derive(Debug)]
struct SlowPreparer;

impl EmailAttemptPreparer for SlowPreparer {
    fn prepare<'a>(
        &'a self,
        _email: &'a ClaimedEmail,
        _invitation_token: Option<&'a nuriteo_server::notification::InvitationAttemptToken>,
    ) -> Pin<Box<dyn Future<Output = Result<PreparedEmail, DeliveryBoundaryError>> + Send + 'a>>
    {
        Box::pin(async move {
            tokio::time::sleep(Duration::from_millis(200)).await;
            PreparedEmail::new("Shutdown drain".to_owned(), "bounded body".to_owned())
        })
    }
}

#[tokio::test]
#[ignore = "requires tests/fixtures/notification-worker/run.sh"]
async fn worker_retries_dead_letters_recovers_and_drains_with_actual_tls_smtp() {
    let pool = fixture_pool().await;
    reset_fixture(&pool).await;
    let report = run_embedded_migrations(
        &pool,
        MigrationOptions::new(Duration::from_secs(5), Duration::from_secs(30)).unwrap(),
    )
    .await
    .unwrap();
    assert!(report.latest_version.is_some_and(|version| version >= 45));
    assert_eq!(
        report.latest_version,
        i64::try_from(report.known_migrations).ok()
    );
    let settings_repository =
        InstanceSettingsRepository::new(pool.clone(), Duration::from_secs(5)).unwrap();
    settings_repository
        .materialize(&InstanceSettingBootstrap::empty())
        .await
        .unwrap();
    configure_smtp(&pool).await;
    let effective_settings = settings_repository.load().await.unwrap();
    seed_users(&pool).await;

    let repository = EmailOutboxRepository::new(pool.clone(), Duration::from_secs(1)).unwrap();
    verify_nullable_activation_eligibility(&pool, &repository).await;
    verify_replica_safe_claims(&pool, &repository).await;
    verify_retry_budget_sweep(&pool, &repository).await;

    seed_delivery(&pool, "4101", "crash@example.test", "4102").await;
    let crash_owner = "0199ee6c-c777-7000-8000-000000004191";
    let crash_claim = repository
        .claim(crash_owner, 1, Duration::from_secs(8))
        .await
        .unwrap();
    assert_eq!(crash_claim.len(), 1);

    seed_delivery(&pool, "4111", "retry@example.test", "4112").await;
    seed_delivery(&pool, "4121", "permanent@example.test", "4122").await;
    seed_delivery(&pool, "4131", "ambiguous@example.test", "4132").await;
    seed_delivery(&pool, "4141", "stale@example.test", "4142").await;
    sqlx::query(
        "UPDATE users SET status='disabled',disabled_at=clock_timestamp(),\
         updated_at=clock_timestamp() WHERE normalized_email='stale@example.test'",
    )
    .execute(&mut *pool.acquire().await.unwrap())
    .await
    .unwrap();

    tokio::time::sleep(Duration::from_millis(8_100)).await;
    let integration = IntegrationRepository::new(
        pool.clone(),
        MasterKeyring::load(&SystemEnvironment, &SystemFileReader).unwrap(),
    );
    let smtp = Arc::new(SmtpEmailSender::new(Arc::new(
        integration
            .smtp_config(
                "notification-fixture",
                &effective_settings,
                &SystemEnvironment,
                &SystemFileReader,
            )
            .await
            .unwrap()
            .expect("fixture SMTP config"),
    )));
    let eligibility = Arc::new(DatabaseDeliveryEligibility::new(pool.clone()));
    let policy = NotificationWorkerPolicy::new(
        8,
        4,
        Duration::from_millis(100),
        Duration::from_secs(1),
        Duration::from_secs(8),
    )
    .unwrap();
    let worker = NotificationWorker::new(
        repository.clone(),
        eligibility.clone(),
        Arc::new(FixturePreparer),
        None,
        smtp.clone(),
        policy,
    )
    .unwrap();

    let mut supervisor = Supervisor::new(SupervisorConfig::new(
        Duration::from_secs(5),
        std::num::NonZeroUsize::new(1).unwrap(),
    ));
    worker.register(&mut supervisor).unwrap();
    let signal_pool = pool.clone();
    let signal = async move {
        wait_for_state(&signal_pool, "retry@example.test", "retry_wait").await;
        accelerate_retry(&signal_pool, "retry@example.test").await;
        wait_for_state(&signal_pool, "retry@example.test", "sent").await;
        wait_for_state(&signal_pool, "crash@example.test", "sent").await;
        wait_for_state(&signal_pool, "permanent@example.test", "dead_letter").await;
        wait_for_state(&signal_pool, "ambiguous@example.test", "retry_wait").await;
        wait_for_state(&signal_pool, "stale@example.test", "canceled").await;
        Ok(ShutdownReason::Requested)
    };
    let shutdown = supervisor.run_until(signal).await.unwrap();
    assert_eq!(shutdown.reason(), ShutdownReason::Requested);
    assert_eq!(shutdown.drained_workers(), 1);

    assert_delivery(&pool, "retry@example.test", "sent", 2, Some(250), None).await;
    assert_delivery(
        &pool,
        "permanent@example.test",
        "dead_letter",
        1,
        Some(550),
        Some("permanent"),
    )
    .await;
    assert_delivery(
        &pool,
        "ambiguous@example.test",
        "retry_wait",
        1,
        None,
        Some("ambiguous"),
    )
    .await;
    assert_delivery(&pool, "stale@example.test", "canceled", 1, None, None).await;
    assert_delivery(&pool, "crash@example.test", "sent", 2, Some(250), None).await;
    verify_shutdown_drains_claimed_attempt(&pool, repository, eligibility, smtp, policy).await;

    reset_fixture(&pool).await;
    pool.close(Duration::from_secs(2)).await.unwrap();
}

async fn verify_nullable_activation_eligibility(
    pool: &DatabasePool,
    repository: &EmailOutboxRepository,
) {
    let admin = id("4001").parse().unwrap();
    let issued = InvitationService::new(pool.clone(), InvitationServicePolicy::default())
        .issue(
            "new@example.test",
            admin,
            &InvitationAuditContext::new(
                AuditEventId::new(),
                AuditActor {
                    kind: ActorType::User,
                    id: admin.to_string(),
                    user_id: Some(admin),
                    display_name: Some("Fixture admin".into()),
                },
                "notification-worker-invitation-issue".into(),
                None,
                "primary".into(),
            ),
        )
        .await
        .unwrap();
    let invitation_id = issued.invitation().id().to_string();
    let enqueued: bool = sqlx::query_scalar(
        "SELECT EXISTS(SELECT 1 FROM email_outbox WHERE resource_type='activation_invitation'
         AND resource_id=$1 AND recipient_email='new@example.test' AND state='pending')",
    )
    .bind(&invitation_id)
    .fetch_one(&mut *pool.acquire().await.unwrap())
    .await
    .unwrap();
    assert!(enqueued);
    let owner = "0199ee6c-c777-7000-8000-000000004153";
    let mut jobs = repository
        .claim(owner, 1, Duration::from_secs(3))
        .await
        .unwrap();
    let job = jobs.pop().unwrap();
    assert_eq!(job.notification_id(), None);
    assert_eq!(
        DatabaseDeliveryEligibility::new(pool.clone())
            .revalidate(&job)
            .await
            .unwrap(),
        DeliveryEligibilityDecision::Eligible
    );
    let issuer = DatabaseInvitationAttemptTokenIssuer::new(pool.clone());
    let context = InvitationAttemptContext {
        invitation_id: job.resource_id().to_owned(),
        resource_type: job.resource_type().to_owned(),
        recipient_email: job.recipient_email().to_owned(),
        attempt_count: job.attempt_count(),
    };
    let token = issuer.issue(&context).await.unwrap();
    let first_plaintext = token.expose_for_message().to_owned();
    let first_stored_digest: Vec<u8> =
        sqlx::query_scalar("SELECT token_hash FROM activation_invitations WHERE id=$1::uuid")
            .bind(job.resource_id())
            .fetch_one(&mut *pool.acquire().await.unwrap())
            .await
            .unwrap();
    assert_eq!(
        first_stored_digest,
        Sha256::digest(token.expose_for_message().as_bytes()).as_slice()
    );
    assert!(!String::from_utf8_lossy(&first_stored_digest).contains(token.expose_for_message()));
    let token = issuer
        .issue(&InvitationAttemptContext {
            attempt_count: context.attempt_count + 1,
            ..context.clone()
        })
        .await
        .unwrap();
    let second_stored_digest: Vec<u8> =
        sqlx::query_scalar("SELECT token_hash FROM activation_invitations WHERE id=$1::uuid")
            .bind(job.resource_id())
            .fetch_one(&mut *pool.acquire().await.unwrap())
            .await
            .unwrap();
    assert_ne!(first_stored_digest, second_stored_digest);
    assert_eq!(
        second_stored_digest,
        Sha256::digest(token.expose_for_message().as_bytes()).as_slice()
    );
    let preparer =
        ProductionEmailAttemptPreparer::new(Url::parse("https://nuriteo.example.test/").unwrap());
    let message = preparer.prepare(&job, Some(&token)).await.unwrap();
    let token_from_link = message
        .body()
        .lines()
        .find_map(|line| line.split_once("?token=").map(|(_, token)| token))
        .expect("invitation email must contain a tokenized activation link");
    let service = InvitationService::new(pool.clone(), InvitationServicePolicy::default());
    let stale_result = service
        .accept(
            &ActivationToken::parse(first_plaintext).unwrap(),
            &activation_audit("notification-worker-stale-invitation"),
            &NoopActivator,
        )
        .await;
    assert!(matches!(
        stale_result,
        Err(InvitationServiceError::InvalidInvitation)
    ));
    let accepted = service
        .accept(
            &ActivationToken::parse(token_from_link.to_owned()).unwrap(),
            &activation_audit("notification-worker-invitation-accept"),
            &NoopActivator,
        )
        .await
        .unwrap();
    assert_eq!(accepted.id().to_string(), job.resource_id());
    repository.cancel(owner, &job).await.unwrap();
}

fn activation_audit(correlation_id: &str) -> InvitationAuditContext {
    InvitationAuditContext::new(
        AuditEventId::new(),
        AuditActor {
            kind: ActorType::System,
            id: "notification-worker-fixture".into(),
            user_id: None,
            display_name: None,
        },
        correlation_id.into(),
        None,
        "primary".into(),
    )
}

struct NoopActivator;

impl InvitationActivator for NoopActivator {
    fn activate<'a>(
        &'a self,
        _transaction: &'a mut Transaction<'_, Postgres>,
        _invitation: &'a PendingInvitationActivation,
    ) -> InvitationActivationFuture<'a> {
        Box::pin(async { Ok::<_, InvitationActivationError>(()) })
    }
}

async fn seed_users(pool: &DatabasePool) {
    for (suffix, email) in [
        ("4001", "admin@example.test"),
        ("4102", "crash@example.test"),
        ("4112", "retry@example.test"),
        ("4122", "permanent@example.test"),
        ("4132", "ambiguous@example.test"),
        ("4142", "stale@example.test"),
        ("4152", "replica-one@example.test"),
        ("4162", "replica-two@example.test"),
        ("4172", "attempt-budget@example.test"),
        ("4182", "time-budget@example.test"),
        ("4192", "shutdown@example.test"),
    ] {
        sqlx::query(
            "INSERT INTO users (id,email,normalized_email,display_name)\
             VALUES ($1::uuid,$2,$2,'Fixture')",
        )
        .bind(id(suffix))
        .bind(email)
        .execute(&mut *pool.acquire().await.unwrap())
        .await
        .unwrap();
    }
    sqlx::query("UPDATE users SET is_instance_admin=true WHERE id=$1::uuid")
        .bind(id("4001"))
        .execute(&mut *pool.acquire().await.unwrap())
        .await
        .unwrap();
}

async fn verify_shutdown_drains_claimed_attempt(
    pool: &DatabasePool,
    repository: EmailOutboxRepository,
    eligibility: Arc<DatabaseDeliveryEligibility>,
    smtp: Arc<SmtpEmailSender>,
    policy: NotificationWorkerPolicy,
) {
    seed_delivery(pool, "4191", "shutdown@example.test", "4192").await;
    let worker = NotificationWorker::new(
        repository,
        eligibility,
        Arc::new(SlowPreparer),
        None,
        smtp,
        policy,
    )
    .unwrap();
    let mut supervisor = Supervisor::new(SupervisorConfig::new(
        Duration::from_secs(5),
        std::num::NonZeroUsize::new(1).unwrap(),
    ));
    worker.register(&mut supervisor).unwrap();
    let signal_pool = pool.clone();
    let signal = async move {
        wait_for_state(&signal_pool, "shutdown@example.test", "sending").await;
        Ok(ShutdownReason::Requested)
    };
    let shutdown = supervisor.run_until(signal).await.unwrap();
    assert_eq!(shutdown.drained_workers(), 1);
    assert_delivery(pool, "shutdown@example.test", "sent", 1, Some(250), None).await;
}

async fn verify_replica_safe_claims(pool: &DatabasePool, repository: &EmailOutboxRepository) {
    seed_delivery(pool, "4151", "replica-one@example.test", "4152").await;
    seed_delivery(pool, "4161", "replica-two@example.test", "4162").await;
    let first_owner = "0199ee6c-c777-7000-8000-000000004153";
    let second_owner = "0199ee6c-c777-7000-8000-000000004163";
    let (first, second) = tokio::join!(
        repository.claim(first_owner, 1, Duration::from_secs(3)),
        repository.claim(second_owner, 1, Duration::from_secs(3)),
    );
    let first = first.unwrap();
    let second = second.unwrap();
    assert_eq!(first.len(), 1);
    assert_eq!(second.len(), 1);
    assert_ne!(first[0].id(), second[0].id());
    repository.cancel(first_owner, &first[0]).await.unwrap();
    repository.cancel(second_owner, &second[0]).await.unwrap();
}

async fn verify_retry_budget_sweep(pool: &DatabasePool, repository: &EmailOutboxRepository) {
    seed_delivery(pool, "4171", "attempt-budget@example.test", "4172").await;
    seed_delivery(pool, "4181", "time-budget@example.test", "4182").await;
    let mut connection = pool.acquire().await.unwrap();
    connection
        .execute("ALTER TABLE email_outbox DISABLE TRIGGER email_outbox_update_invariants")
        .await
        .unwrap();
    sqlx::query(
        "UPDATE email_outbox SET state='retry_wait',attempt_count=8,\
         first_attempt_at=created_at,last_attempt_at=created_at,\
         available_at=clock_timestamp()+INTERVAL '1 second',\
         updated_at=clock_timestamp(),last_error_class='transient',lock_version=2 \
         WHERE recipient_email='attempt-budget@example.test'",
    )
    .execute(&mut *connection)
    .await
    .unwrap();
    sqlx::query(
        "UPDATE email_outbox SET state='retry_wait',attempt_count=1,\
         created_at=clock_timestamp()-INTERVAL '26 hours',\
         first_attempt_at=clock_timestamp()-INTERVAL '25 hours',\
         last_attempt_at=clock_timestamp()-INTERVAL '25 hours',\
         available_at=clock_timestamp()+INTERVAL '1 second',updated_at=clock_timestamp(),\
         last_error_class='transient',lock_version=2 \
         WHERE recipient_email='time-budget@example.test'",
    )
    .execute(&mut *connection)
    .await
    .unwrap();
    connection
        .execute("ALTER TABLE email_outbox ENABLE TRIGGER email_outbox_update_invariants")
        .await
        .unwrap();
    drop(connection);

    let owner = "0199ee6c-c777-7000-8000-000000004173";
    assert!(
        repository
            .claim(owner, 2, Duration::from_secs(3))
            .await
            .unwrap()
            .is_empty()
    );
    assert_delivery(
        pool,
        "attempt-budget@example.test",
        "dead_letter",
        8,
        None,
        Some("transient"),
    )
    .await;
    assert_delivery(
        pool,
        "time-budget@example.test",
        "dead_letter",
        1,
        None,
        Some("transient"),
    )
    .await;
}

async fn seed_delivery(pool: &DatabasePool, notification: &str, email: &str, user: &str) {
    sqlx::query(
        "INSERT INTO notifications
         (id,recipient_user_id,classification,event_code,template_id,locale,resource_type,
          resource_id,rendering_data,first_occurred_at,last_occurred_at)
         VALUES ($1::uuid,$2::uuid,'account_access','fixture.delivery','fixture.delivery','ko-KR',
                 'user',$2,'{\"safe\":\"value\"}'::jsonb,CURRENT_TIMESTAMP,CURRENT_TIMESTAMP)",
    )
    .bind(id(notification))
    .bind(id(user))
    .execute(&mut *pool.acquire().await.unwrap())
    .await
    .unwrap();
    sqlx::query(
        "INSERT INTO email_outbox
         (id,notification_id,recipient_user_id,recipient_email,classification,template_id,locale,
          resource_type,resource_id,rendering_data)
         SELECT $1::uuid,id,recipient_user_id,$2,classification,template_id,locale,resource_type,
                resource_id,rendering_data FROM notifications WHERE id=$3::uuid",
    )
    .bind(id(&format!("{}9", &notification[..3])))
    .bind(email)
    .bind(id(notification))
    .execute(&mut *pool.acquire().await.unwrap())
    .await
    .unwrap();
}

fn id(suffix: &str) -> String {
    format!("0199ee6c-c777-7000-8000-00000000{suffix}")
}

async fn wait_for_state(pool: &DatabasePool, email: &str, expected: &str) {
    let mut observed = None;
    for _ in 0..200 {
        observed = sqlx::query_as(
            "SELECT state,attempt_count::int,last_smtp_code,last_error_class,\
                    available_at::text,lease_owner \
             FROM email_outbox WHERE recipient_email=$1 ORDER BY created_at DESC LIMIT 1",
        )
        .bind(email)
        .fetch_optional(&mut *pool.acquire().await.unwrap())
        .await
        .unwrap();
        if observed.as_ref().is_some_and(
            |row: &(
                String,
                i32,
                Option<i32>,
                Option<String>,
                String,
                Option<String>,
            )| { row.0 == expected },
        ) {
            return;
        }
        tokio::time::sleep(Duration::from_millis(25)).await;
    }
    panic!("{email} did not reach {expected}; observed={observed:?}");
}

async fn accelerate_retry(pool: &DatabasePool, email: &str) {
    let mut connection = pool.acquire().await.unwrap();
    connection
        .execute("ALTER TABLE email_outbox DISABLE TRIGGER email_outbox_update_invariants")
        .await
        .unwrap();
    sqlx::query(
        "UPDATE email_outbox SET available_at=updated_at WHERE recipient_email=$1 AND state='retry_wait'",
    )
    .bind(email)
    .execute(&mut *connection)
    .await
    .unwrap();
    connection
        .execute("ALTER TABLE email_outbox ENABLE TRIGGER email_outbox_update_invariants")
        .await
        .unwrap();
}

async fn assert_delivery(
    pool: &DatabasePool,
    email: &str,
    state: &str,
    attempts: i16,
    smtp_code: Option<i32>,
    error_class: Option<&str>,
) {
    let row = sqlx::query(
        "SELECT state,attempt_count,last_smtp_code,last_error_class,lease_owner,lease_expires_at \
         FROM email_outbox WHERE recipient_email=$1 ORDER BY created_at DESC LIMIT 1",
    )
    .bind(email)
    .fetch_one(&mut *pool.acquire().await.unwrap())
    .await
    .unwrap();
    assert_eq!(row.get::<String, _>("state"), state);
    assert_eq!(row.get::<i16, _>("attempt_count"), attempts);
    assert_eq!(row.get::<Option<i32>, _>("last_smtp_code"), smtp_code);
    assert_eq!(
        row.get::<Option<String>, _>("last_error_class").as_deref(),
        error_class
    );
    assert_eq!(row.get::<Option<String>, _>("lease_owner"), None);
    assert_eq!(
        row.get::<Option<time::OffsetDateTime>, _>("lease_expires_at"),
        None
    );
}

async fn reset_fixture(pool: &DatabasePool) {
    pool.acquire()
        .await
        .unwrap()
        .execute("DROP SCHEMA public CASCADE; CREATE SCHEMA public")
        .await
        .unwrap();
}

async fn configure_smtp(pool: &DatabasePool) {
    for (key, value) in [
        ("smtp.enabled", "true".to_owned()),
        ("smtp.host", "\"localhost\"".to_owned()),
        (
            "smtp.port",
            env::var(SMTP_PORT_ENV).expect("fixture SMTP port"),
        ),
        ("smtp.security", "\"implicit-tls\"".to_owned()),
        ("smtp.from_address", "\"noreply@example.test\"".to_owned()),
        ("smtp.from_name", "\"NURITEO Fixture\"".to_owned()),
        ("smtp.preflight_timeout_ms", "5000".to_owned()),
    ] {
        sqlx::query("UPDATE instance_settings SET value=$2::jsonb WHERE key=$1")
            .bind(key)
            .bind(value)
            .execute(&mut *pool.acquire().await.unwrap())
            .await
            .unwrap();
    }
}

async fn fixture_pool() -> DatabasePool {
    let url = env::var(DATABASE_URL_ENV).unwrap();
    let ca = fs::read(env::var(DATABASE_CA_ENV).unwrap()).unwrap();
    DatabasePool::connect(
        DatabasePoolConfig::new(
            url,
            1,
            8,
            Duration::from_secs(5),
            Duration::from_secs(5),
            DatabaseTlsConfig::verify_full(None, Some(ca), None).unwrap(),
        )
        .unwrap(),
    )
    .await
    .unwrap()
}
