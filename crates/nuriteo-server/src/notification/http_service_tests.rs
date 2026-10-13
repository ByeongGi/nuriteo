use std::env;
use std::fs;
use std::time::Duration;

use base64::Engine as _;
use base64::engine::general_purpose::URL_SAFE_NO_PAD;
use sqlx::{Acquire, Row};
use url::Url;
use uuid::Uuid;

use super::{NotificationHttpService, NotificationHttpServiceError};
use crate::config::InstanceSettingBootstrap;
use crate::database::{
    DatabasePool, DatabasePoolConfig, DatabaseTlsConfig, MigrationOptions, run_embedded_migrations,
};
use crate::identity::{
    BrowserMethod, BrowserRequestHeaders, SessionPolicy, SessionRotationKind, SessionService,
    UserId,
};
use crate::instance_settings::InstanceSettingsRepository;

const USER_ID: &str = "0199ee6c-c777-7000-8000-000000038001";
const OTHER_USER_ID: &str = "0199ee6c-c777-7000-8000-000000038002";
const ADMIN_ID: &str = "0199ee6c-c777-7000-8000-000000038003";
const NOTIFICATION_ID: &str = "0199ee6c-c777-7000-8000-000000038011";
const OTHER_NOTIFICATION_ID: &str = "0199ee6c-c777-7000-8000-000000038012";
const DEAD_DELIVERY_ID: &str = "0199ee6c-c777-7000-8000-000000038021";
const PENDING_DELIVERY_ID: &str = "0199ee6c-c777-7000-8000-000000038022";
const SENDING_DELIVERY_ID: &str = "0199ee6c-c777-7000-8000-000000038023";
const ROLLBACK_DELIVERY_ID: &str = "0199ee6c-c777-7000-8000-000000038024";
const PAGED_NOTIFICATION_ID: &str = "0199ee6c-c777-7000-8000-000000038013";
const CONCURRENT_NOTIFICATION_ID: &str = "0199ee6c-c777-7000-8000-000000038014";

#[tokio::test]
#[ignore = "requires tests/fixtures/postgres-notification/run.sh"]
async fn actual_notification_http_is_tenant_safe_versioned_and_idempotent() {
    let pool = fixture_pool().await;
    reset_fixture(&pool).await;
    let report = run_embedded_migrations(
        &pool,
        MigrationOptions::new(Duration::from_secs(5), Duration::from_secs(30)).unwrap(),
    )
    .await
    .unwrap();
    assert_eq!(report.latest_version, Some(40));
    InstanceSettingsRepository::new(pool.clone(), Duration::from_secs(5))
        .unwrap()
        .materialize(&InstanceSettingBootstrap::empty())
        .await
        .unwrap();
    seed(&pool).await;

    let policy = SessionPolicy::default();
    let sessions = SessionService::new(pool.clone(), policy);
    let user = sessions.issue(user_id(USER_ID)).await.unwrap();
    let other = sessions.issue(user_id(OTHER_USER_ID)).await.unwrap();
    let stale_admin = sessions.issue(user_id(ADMIN_ID)).await.unwrap();
    let admin = sessions
        .rotate(stale_admin.token(), SessionRotationKind::Reauthentication)
        .await
        .unwrap();
    let not_recent_admin = sessions.issue(user_id(ADMIN_ID)).await.unwrap();
    let service = NotificationHttpService::production(
        pool.clone(),
        &Url::parse("http://127.0.0.1:3000").unwrap(),
        policy,
    )
    .unwrap();
    let csrf = format!("nrt_csrf_{}", URL_SAFE_NO_PAD.encode([31_u8; 32]));
    let user_cookie = format!(
        "nuriteo_dev_session={}; nuriteo_dev_csrf={csrf}",
        user.token().expose()
    );
    let other_cookie = format!(
        "nuriteo_dev_session={}; nuriteo_dev_csrf={csrf}",
        other.token().expose()
    );
    let admin_cookie = format!(
        "nuriteo_dev_session={}; nuriteo_dev_csrf={csrf}",
        admin.token().expose()
    );
    let not_recent_admin_cookie = format!(
        "nuriteo_dev_session={}; nuriteo_dev_csrf={csrf}",
        not_recent_admin.token().expose()
    );
    let origin = ["http://127.0.0.1:3000"];
    let csrf_headers = [csrf.as_str()];
    let user_cookies = [user_cookie.as_str()];
    let other_cookies = [other_cookie.as_str()];
    let admin_cookies = [admin_cookie.as_str()];
    let not_recent_admin_cookies = [not_recent_admin_cookie.as_str()];

    let user_get = request(BrowserMethod::Get, &[], &user_cookies, &[]);
    let inbox = service
        .inbox(user_get, false, None, Some(25))
        .await
        .unwrap();
    assert_eq!(inbox.items.len(), 1);
    assert_eq!(inbox.items[0].id, NOTIFICATION_ID);
    assert_eq!(inbox.unread_count, 1);
    assert!(!format!("{inbox:?}").contains("private-rendering-value"));
    let other_inbox = service
        .inbox(
            request(BrowserMethod::Get, &[], &other_cookies, &[]),
            false,
            None,
            Some(25),
        )
        .await
        .unwrap();
    assert_eq!(other_inbox.items[0].id, OTHER_NOTIFICATION_ID);

    insert_notification(&pool, PAGED_NOTIFICATION_ID, USER_ID).await;
    let first_page = service.inbox(user_get, false, None, Some(1)).await.unwrap();
    assert_eq!(first_page.items.len(), 1);
    assert_eq!(first_page.unread_count, 2);
    let first_id = first_page.items[0].id.clone();
    sqlx::query(
        "UPDATE notifications SET occurrence_count=occurrence_count+1,\
         last_occurred_at=clock_timestamp(),updated_at=clock_timestamp(),\
         lock_version=lock_version+1 WHERE id=$1::uuid",
    )
    .bind(&first_id)
    .execute(&mut *pool.acquire().await.unwrap())
    .await
    .unwrap();
    tokio::time::sleep(Duration::from_millis(10)).await;
    insert_notification(&pool, CONCURRENT_NOTIFICATION_ID, USER_ID).await;
    let second_page = service
        .inbox(user_get, false, first_page.next_cursor.as_deref(), Some(1))
        .await
        .unwrap();
    assert_eq!(second_page.items.len(), 1);
    assert_ne!(second_page.items[0].id, first_id);
    assert_ne!(second_page.items[0].id, CONCURRENT_NOTIFICATION_ID);
    assert_eq!(second_page.unread_count, 2);

    let user_patch = request(BrowserMethod::Patch, &origin, &user_cookies, &csrf_headers);
    let updated = service
        .update_status(
            user_patch,
            Uuid::parse_str(NOTIFICATION_ID).unwrap(),
            "read",
            1,
        )
        .await
        .unwrap();
    assert_eq!(updated.status, "read");
    assert_eq!(updated.version, 2);
    assert_eq!(
        service
            .update_status(
                user_patch,
                Uuid::parse_str(NOTIFICATION_ID).unwrap(),
                "archived",
                1,
            )
            .await
            .unwrap_err(),
        NotificationHttpServiceError::PreconditionFailed
    );
    assert_eq!(
        service
            .update_status(
                user_patch,
                Uuid::parse_str(OTHER_NOTIFICATION_ID).unwrap(),
                "read",
                1,
            )
            .await
            .unwrap_err(),
        NotificationHttpServiceError::NotFound
    );

    let initial_preferences = service.preferences(user_get).await.unwrap();
    assert!(!initial_preferences.smtp_configured);
    assert!(initial_preferences.critical_security);
    let saved_preferences = service
        .update_preferences(user_patch, false, true, false, 1)
        .await
        .unwrap();
    assert_eq!(saved_preferences.version, 2);
    assert!(saved_preferences.collaboration);
    assert_eq!(
        service
            .update_preferences(user_patch, true, false, false, 1)
            .await
            .unwrap_err(),
        NotificationHttpServiceError::PreconditionFailed
    );

    assert_eq!(
        service
            .deliveries(user_get, None, None, Some(25))
            .await
            .unwrap_err(),
        NotificationHttpServiceError::Forbidden
    );
    let admin_get = request(BrowserMethod::Get, &[], &admin_cookies, &[]);
    let deliveries = service
        .deliveries(admin_get, Some("dead_letter"), None, Some(25))
        .await
        .unwrap();
    assert_eq!(deliveries.items.len(), 1);
    assert_eq!(
        deliveries.items[0].error_class.as_deref(),
        Some("permanent")
    );

    let admin_post = request(BrowserMethod::Post, &origin, &admin_cookies, &csrf_headers);
    let not_recent_admin_post = request(
        BrowserMethod::Post,
        &origin,
        &not_recent_admin_cookies,
        &csrf_headers,
    );
    assert_eq!(
        service
            .cancel_delivery(
                not_recent_admin_post,
                Uuid::parse_str(ROLLBACK_DELIVERY_ID).unwrap(),
                1,
                "notification-stale-reauth-0001",
                "notification-stale-reauth",
            )
            .await
            .unwrap_err(),
        NotificationHttpServiceError::ReauthenticationRequired
    );
    seed_expired_receipts(&pool).await;
    let retried = service
        .retry_delivery(
            admin_post,
            Uuid::parse_str(DEAD_DELIVERY_ID).unwrap(),
            3,
            "notification-actual-retry-0001",
            "notification-actual-retry",
        )
        .await
        .unwrap();
    assert_eq!(retried.state, "pending");
    let expired_receipts: i64 = sqlx::query_scalar(
        "SELECT COUNT(*) FROM notification_admin_operation_receipts \
         WHERE expires_at<=transaction_timestamp()",
    )
    .fetch_one(&mut *pool.acquire().await.unwrap())
    .await
    .unwrap();
    assert_eq!(expired_receipts, 50);
    let replayed = service
        .retry_delivery(
            admin_post,
            Uuid::parse_str(DEAD_DELIVERY_ID).unwrap(),
            3,
            "notification-actual-retry-0001",
            "notification-actual-replay",
        )
        .await
        .unwrap();
    assert_eq!(replayed.id, retried.id);
    let retry_count: i64 = sqlx::query_scalar(
        "SELECT COUNT(*) FROM email_outbox WHERE id<>$1::uuid AND resource_id='retry-target'",
    )
    .bind(DEAD_DELIVERY_ID)
    .fetch_one(&mut *pool.acquire().await.unwrap())
    .await
    .unwrap();
    assert_eq!(retry_count, 1);
    assert_eq!(
        service
            .cancel_delivery(
                admin_post,
                Uuid::parse_str(DEAD_DELIVERY_ID).unwrap(),
                3,
                "notification-actual-retry-0001",
                "notification-actual-mismatch",
            )
            .await
            .unwrap_err(),
        NotificationHttpServiceError::Conflict
    );
    let canceled = service
        .cancel_delivery(
            admin_post,
            Uuid::parse_str(PENDING_DELIVERY_ID).unwrap(),
            1,
            "notification-actual-cancel-0001",
            "notification-actual-cancel",
        )
        .await
        .unwrap();
    assert_eq!(canceled.state, "canceled");
    assert_eq!(canceled.version, 2);
    assert_eq!(
        service
            .cancel_delivery(
                admin_post,
                Uuid::parse_str(SENDING_DELIVERY_ID).unwrap(),
                2,
                "notification-sending-cancel-0001",
                "notification-smtp-acceptance-race",
            )
            .await
            .unwrap_err(),
        NotificationHttpServiceError::Conflict
    );
    sqlx::query(
        "UPDATE email_outbox SET state='sent',sent_at=transaction_timestamp(),\
         lease_owner=NULL,lease_expires_at=NULL,last_smtp_code=250,last_error_class=NULL,\
         updated_at=clock_timestamp(),lock_version=lock_version+1 WHERE id=$1::uuid",
    )
    .bind(SENDING_DELIVERY_ID)
    .execute(&mut *pool.acquire().await.unwrap())
    .await
    .unwrap();
    let sending_race_state: String =
        sqlx::query_scalar("SELECT state FROM email_outbox WHERE id=$1::uuid")
            .bind(SENDING_DELIVERY_ID)
            .fetch_one(&mut *pool.acquire().await.unwrap())
            .await
            .unwrap();
    assert_eq!(sending_race_state, "sent");

    verify_lock_timeout(&pool, &service, &user_cookie, &csrf).await;
    verify_audit_failure_rolls_back(&pool, &service, admin_post).await;
    let audit: Vec<String> = sqlx::query("SELECT metadata::text FROM audit_events WHERE action_code LIKE 'notification.delivery_%' ORDER BY action_code")
        .fetch_all(&mut *pool.acquire().await.unwrap())
        .await.unwrap().into_iter().map(|row| row.get("metadata")).collect();
    assert_eq!(audit.len(), 2);
    assert!(
        audit
            .iter()
            .all(|value| !value.contains("private-rendering-value"))
    );

    reset_fixture(&pool).await;
    pool.close(Duration::from_secs(2)).await.unwrap();
}

async fn insert_notification(pool: &DatabasePool, id: &str, user: &str) {
    sqlx::query(
        "INSERT INTO notifications(id,recipient_user_id,classification,event_code,template_id,\
         locale,resource_type,resource_id,rendering_data,first_occurred_at,last_occurred_at) \
         VALUES($1::uuid,$2::uuid,'account_access','identity.password.changed',\
         'identity.password_changed','en','user',$2::text,'{}'::jsonb,\
         transaction_timestamp(),transaction_timestamp())",
    )
    .bind(id)
    .bind(user)
    .execute(&mut *pool.acquire().await.unwrap())
    .await
    .unwrap();
}

async fn seed_expired_receipts(pool: &DatabasePool) {
    sqlx::query(
        "INSERT INTO notification_admin_operation_receipts \
         (actor_user_id,idempotency_key,operation,target_email_outbox_id,\
          result_email_outbox_id,created_at,expires_at) \
         SELECT $1::uuid,'expired-receipt-'||lpad(value::text,4,'0'),'retry',$2::uuid,$2::uuid,\
         transaction_timestamp()-INTERVAL '20 minutes',\
         transaction_timestamp()-INTERVAL '10 minutes' FROM generate_series(1,150) value",
    )
    .bind(ADMIN_ID)
    .bind(DEAD_DELIVERY_ID)
    .execute(&mut *pool.acquire().await.unwrap())
    .await
    .unwrap();
}

async fn verify_lock_timeout(
    pool: &DatabasePool,
    service: &NotificationHttpService,
    cookie: &str,
    csrf: &str,
) {
    let mut connection = pool.acquire().await.unwrap();
    let mut lock = connection.begin().await.unwrap();
    sqlx::query("SELECT id FROM notifications WHERE id=$1::uuid FOR UPDATE")
        .bind(NOTIFICATION_ID)
        .fetch_one(&mut *lock)
        .await
        .unwrap();
    let started = std::time::Instant::now();
    let result = service
        .update_status(
            request(
                BrowserMethod::Patch,
                &["http://127.0.0.1:3000"],
                &[cookie],
                &[csrf],
            ),
            Uuid::parse_str(NOTIFICATION_ID).unwrap(),
            "archived",
            2,
        )
        .await;
    assert_eq!(
        result.unwrap_err(),
        NotificationHttpServiceError::Unavailable
    );
    assert!(started.elapsed() < Duration::from_secs(3));
    lock.rollback().await.unwrap();
}

async fn verify_audit_failure_rolls_back(
    pool: &DatabasePool,
    service: &NotificationHttpService,
    admin_post: BrowserRequestHeaders<'_>,
) {
    sqlx::raw_sql(
        "CREATE FUNCTION reject_notification_audit() RETURNS trigger LANGUAGE plpgsql AS $$\
         BEGIN IF NEW.target_id='0199ee6c-c777-7000-8000-000000038024' THEN \
         RAISE EXCEPTION 'fixture audit failure'; END IF; RETURN NEW; END; $$;\
         CREATE TRIGGER reject_notification_audit BEFORE INSERT ON audit_events \
         FOR EACH ROW EXECUTE FUNCTION reject_notification_audit();",
    )
    .execute(&mut *pool.acquire().await.unwrap())
    .await
    .unwrap();
    assert_eq!(
        service
            .cancel_delivery(
                admin_post,
                Uuid::parse_str(ROLLBACK_DELIVERY_ID).unwrap(),
                1,
                "notification-audit-rollback-0001",
                "notification-audit-rollback",
            )
            .await
            .unwrap_err(),
        NotificationHttpServiceError::Unavailable
    );
    let state: String = sqlx::query_scalar("SELECT state FROM email_outbox WHERE id=$1::uuid")
        .bind(ROLLBACK_DELIVERY_ID)
        .fetch_one(&mut *pool.acquire().await.unwrap())
        .await
        .unwrap();
    assert_eq!(state, "pending");
    let receipt: i64 = sqlx::query_scalar(
        "SELECT COUNT(*) FROM notification_admin_operation_receipts \
         WHERE idempotency_key='notification-audit-rollback-0001'",
    )
    .fetch_one(&mut *pool.acquire().await.unwrap())
    .await
    .unwrap();
    assert_eq!(receipt, 0);
}

const fn request<'a>(
    method: BrowserMethod,
    origins: &'a [&'a str],
    cookies: &'a [&'a str],
    csrf: &'a [&'a str],
) -> BrowserRequestHeaders<'a> {
    BrowserRequestHeaders {
        method,
        origins,
        cookie_headers: cookies,
        csrf_headers: csrf,
    }
}

async fn seed(pool: &DatabasePool) {
    sqlx::query(
        "INSERT INTO users(id,email,normalized_email,display_name,is_instance_admin) VALUES \
         ($1::uuid,'notification@example.test','notification@example.test','Notification User',FALSE),\
         ($2::uuid,'other@example.test','other@example.test','Other User',FALSE),\
         ($3::uuid,'notification-admin@example.test','notification-admin@example.test','Notification Admin',TRUE)",
    )
    .bind(USER_ID)
    .bind(OTHER_USER_ID)
    .bind(ADMIN_ID)
    .execute(&mut *pool.acquire().await.unwrap())
    .await
    .unwrap();
    for (id, user, event) in [
        (NOTIFICATION_ID, USER_ID, "identity.password.changed"),
        (
            OTHER_NOTIFICATION_ID,
            OTHER_USER_ID,
            "identity.password.changed",
        ),
    ] {
        sqlx::query(
            "INSERT INTO notifications(id,recipient_user_id,classification,event_code,template_id,locale,resource_type,resource_id,rendering_data,first_occurred_at,last_occurred_at) \
             VALUES($1::uuid,$2::uuid,'account_access',$3,'identity.password_changed','en','user',$2::text,'{\"displayName\":\"private-rendering-value\"}'::jsonb,transaction_timestamp(),transaction_timestamp())",
        )
        .bind(id)
        .bind(user)
        .bind(event)
        .execute(&mut *pool.acquire().await.unwrap())
        .await
        .unwrap();
    }
    sqlx::query(
        "INSERT INTO email_outbox(id,recipient_email,classification,template_id,locale,resource_type,resource_id,rendering_data) VALUES \
         ($1::uuid,'notification@example.test','account_access','identity.password_changed','en','user','retry-target','{\"displayName\":\"private-rendering-value\"}'::jsonb),\
         ($2::uuid,'notification@example.test','account_access','identity.password_changed','en','user','cancel-target','{}'::jsonb),\
         ($3::uuid,'notification@example.test','account_access','identity.password.changed','en','user','sending-target','{}'::jsonb),\
         ($4::uuid,'notification@example.test','account_access','identity.password.changed','en','user','rollback-target','{}'::jsonb)",
    )
    .bind(DEAD_DELIVERY_ID)
    .bind(PENDING_DELIVERY_ID)
    .bind(SENDING_DELIVERY_ID)
    .bind(ROLLBACK_DELIVERY_ID)
    .execute(&mut *pool.acquire().await.unwrap())
    .await
    .unwrap();
    sqlx::query(
        "UPDATE email_outbox SET state='sending',attempt_count=1,\
         first_attempt_at=transaction_timestamp(),last_attempt_at=transaction_timestamp(),\
         lease_owner='0199ee6c-c777-7000-8000-000000038098',\
         lease_expires_at=transaction_timestamp()+INTERVAL '1 minute',\
         updated_at=transaction_timestamp(),lock_version=2 WHERE id=$1::uuid",
    )
    .bind(SENDING_DELIVERY_ID)
    .execute(&mut *pool.acquire().await.unwrap())
    .await
    .unwrap();
    sqlx::query(
        "UPDATE email_outbox SET state='sending',attempt_count=1,first_attempt_at=transaction_timestamp(),last_attempt_at=transaction_timestamp(),lease_owner='0199ee6c-c777-7000-8000-000000038099',lease_expires_at=transaction_timestamp()+INTERVAL '1 minute',updated_at=transaction_timestamp(),lock_version=2 WHERE id=$1::uuid",
    )
    .bind(DEAD_DELIVERY_ID)
    .execute(&mut *pool.acquire().await.unwrap())
    .await
    .unwrap();
    sqlx::query(
        "UPDATE email_outbox SET state='dead_letter',lease_owner=NULL,lease_expires_at=NULL,last_smtp_code=550,last_error_class='permanent',updated_at=transaction_timestamp(),lock_version=3 WHERE id=$1::uuid",
    )
    .bind(DEAD_DELIVERY_ID)
    .execute(&mut *pool.acquire().await.unwrap())
    .await
    .unwrap();
}

fn user_id(value: &str) -> UserId {
    value.parse().unwrap()
}

async fn fixture_pool() -> DatabasePool {
    let tls = DatabaseTlsConfig::verify_full(
        None,
        Some(fs::read(env::var("NURITEO_TEST_DATABASE_CA").unwrap()).unwrap()),
        None,
    )
    .unwrap();
    DatabasePool::connect(
        DatabasePoolConfig::new(
            env::var("NURITEO_TEST_DATABASE_URL").unwrap(),
            1,
            8,
            Duration::from_secs(5),
            Duration::from_secs(5),
            tls,
        )
        .unwrap(),
    )
    .await
    .unwrap()
}

async fn reset_fixture(pool: &DatabasePool) {
    sqlx::raw_sql("DROP SCHEMA public CASCADE; CREATE SCHEMA public;")
        .execute(&mut *pool.acquire().await.unwrap())
        .await
        .unwrap();
}
