use std::env;
use std::fs;
use std::time::Duration;

use nuriteo_server::config::InstanceSettingBootstrap;
use nuriteo_server::database::{
    DatabasePool, DatabasePoolConfig, DatabaseTlsConfig, MigrationOptions, MigrationReport,
    SchemaReadiness, check_schema_readiness, run_embedded_migrations,
};
use nuriteo_server::identity::{NormalizedEmail, Timestamp, UserId};
use nuriteo_server::instance_settings::InstanceSettingsRepository;
use nuriteo_server::notification::{
    EmailChannelPreference, EmailOutboxId, Notification, NotificationClassification,
    NotificationDelivery, NotificationFields, NotificationId, NotificationPayload,
    NotificationValidationError, NotificationWriteErrorCategory, NotificationWriter,
};
use serde_json::json;
use sqlx::{Acquire, Executor, Row};
use uuid::Uuid;

const DATABASE_URL_ENV: &str = "NURITEO_TEST_DATABASE_URL";
const DATABASE_CA_ENV: &str = "NURITEO_TEST_DATABASE_CA";

#[tokio::test]
#[ignore = "requires the pinned PostgreSQL TLS fixture; run tests/fixtures/postgres-notification/run.sh"]
async fn notification_outbox_is_transactional_bounded_and_secret_safe() {
    let pool = fixture_pool().await;
    reset_fixture(&pool).await;
    assert_eq!(
        readiness(&pool).await,
        SchemaReadiness::Pending {
            current: None,
            target: 36,
        }
    );
    let report = migrate(&pool).await;
    assert_eq!(
        report,
        MigrationReport {
            latest_version: Some(40),
            known_migrations: 40,
        }
    );
    assert_eq!(migrate(&pool).await, report);
    assert_eq!(
        readiness(&pool).await,
        SchemaReadiness::Ready { version: 36 }
    );

    seed_user(&pool).await;
    InstanceSettingsRepository::new(pool.clone(), Duration::from_secs(5))
        .expect("settings repository")
        .materialize(&InstanceSettingBootstrap::empty())
        .await
        .expect("settings materialization");
    verify_authoritative_email_policy_and_preference_race(&pool).await;
    set_smtp_enabled(&pool, true).await;
    verify_transaction_bound_enqueue(&pool).await;
    verify_failure_rolls_back_both_rows(&pool).await;
    verify_explicit_rollback(&pool).await;
    verify_secret_and_lifecycle_constraints(&pool).await;
    verify_terminal_delivery_retention_and_state_machine(&pool).await;
    verify_linked_message_consistency(&pool).await;
    verify_compact_payload_boundary_parity(&pool).await;
    verify_schema_shape(&pool).await;

    reset_fixture(&pool).await;
    pool.close(Duration::from_secs(2))
        .await
        .unwrap_or_else(|_| panic!("notification fixture pool must close"));
}

async fn verify_authoritative_email_policy_and_preference_race(pool: &DatabasePool) {
    let smtp_disabled = delivery(
        NotificationId::new(),
        EmailOutboxId::new(),
        NotificationClassification::AccountAccess,
    );
    let smtp_disabled_id = smtp_disabled.notification().id().to_string();
    enqueue_and_commit(pool, &smtp_disabled).await;
    assert_eq!(count_for(pool, "notifications", &smtp_disabled_id).await, 1);
    assert_eq!(count_for(pool, "email_outbox", &smtp_disabled_id).await, 0);

    set_smtp_enabled(pool, true).await;
    sqlx::query(
        "INSERT INTO notification_email_preferences \
         (user_id,account_access,collaboration,operations) VALUES ($1::uuid,FALSE,FALSE,FALSE)",
    )
    .bind(fixture_user_id().to_string())
    .execute(&mut *acquire(pool).await)
    .await
    .expect("disabled preference must insert");

    let account_disabled = delivery(
        NotificationId::new(),
        EmailOutboxId::new(),
        NotificationClassification::AccountAccess,
    );
    let account_disabled_id = account_disabled.notification().id().to_string();
    enqueue_and_commit(pool, &account_disabled).await;
    assert_eq!(
        count_for(pool, "email_outbox", &account_disabled_id).await,
        0
    );

    let critical = delivery(
        NotificationId::new(),
        EmailOutboxId::new(),
        NotificationClassification::CriticalSecurity,
    );
    let critical_id = critical.notification().id().to_string();
    enqueue_and_commit(pool, &critical).await;
    assert_eq!(count_for(pool, "email_outbox", &critical_id).await, 1);

    let mut preference_connection = acquire(pool).await;
    let mut preference_tx = preference_connection.begin().await.expect("preference tx");
    sqlx::query(
        "UPDATE notification_email_preferences SET collaboration=TRUE,\
         updated_at=transaction_timestamp(),lock_version=lock_version+1 WHERE user_id=$1::uuid",
    )
    .bind(fixture_user_id().to_string())
    .execute(&mut *preference_tx)
    .await
    .expect("preference update must hold serialization lock");
    let collaboration = NotificationDelivery::new(
        notification(
            NotificationId::new(),
            NotificationClassification::Collaboration,
        ),
        false,
        EmailChannelPreference::Default,
        None,
        None,
    )
    .expect("caller may omit a disabled candidate channel");
    let collaboration_id = collaboration.notification().id().to_string();
    let writer_pool = pool.clone();
    let writer = tokio::spawn(async move {
        let mut connection = acquire(&writer_pool).await;
        let mut tx = connection.begin().await.expect("writer tx");
        NotificationWriter::enqueue(&mut tx, &collaboration)
            .await
            .expect("writer must reconcile authoritative preference");
        tx.commit().await.expect("writer commit");
    });
    tokio::time::sleep(Duration::from_millis(100)).await;
    assert!(
        !writer.is_finished(),
        "enqueue must wait for the preference mutation"
    );
    preference_tx.commit().await.expect("preference commit");
    writer.await.expect("writer task");
    assert_eq!(count_for(pool, "email_outbox", &collaboration_id).await, 1);

    let mut settings_connection = acquire(pool).await;
    let mut settings_tx = settings_connection.begin().await.expect("settings tx");
    sqlx::query(
        "UPDATE instance_settings SET value='false'::jsonb,\
         updated_at=transaction_timestamp(),lock_version=lock_version+1 WHERE key='smtp.enabled'",
    )
    .execute(&mut *settings_tx)
    .await
    .expect("SMTP update must hold its row lock");
    let critical_after_disable = delivery(
        NotificationId::new(),
        EmailOutboxId::new(),
        NotificationClassification::CriticalSecurity,
    );
    let critical_after_disable_id = critical_after_disable.notification().id().to_string();
    let smtp_writer_pool = pool.clone();
    let smtp_writer = tokio::spawn(async move {
        let mut connection = acquire(&smtp_writer_pool).await;
        let mut tx = connection.begin().await.expect("SMTP writer tx");
        NotificationWriter::enqueue(&mut tx, &critical_after_disable)
            .await
            .expect("writer must reconcile authoritative SMTP state");
        tx.commit().await.expect("SMTP writer commit");
    });
    tokio::time::sleep(Duration::from_millis(100)).await;
    assert!(
        !smtp_writer.is_finished(),
        "enqueue must wait for the SMTP setting mutation"
    );
    settings_tx.commit().await.expect("SMTP setting commit");
    smtp_writer.await.expect("SMTP writer task");
    assert_eq!(
        count_for(pool, "email_outbox", &critical_after_disable_id).await,
        0
    );
    set_smtp_enabled(pool, true).await;
    sqlx::query(
        "UPDATE notification_email_preferences SET account_access=TRUE,\
         updated_at=transaction_timestamp(),lock_version=lock_version+1 WHERE user_id=$1::uuid",
    )
    .bind(fixture_user_id().to_string())
    .execute(&mut *acquire(pool).await)
    .await
    .expect("account preference reset");
}

async fn enqueue_and_commit(pool: &DatabasePool, delivery: &NotificationDelivery) {
    let mut connection = acquire(pool).await;
    let mut tx = connection.begin().await.expect("enqueue tx");
    NotificationWriter::enqueue(&mut tx, delivery)
        .await
        .expect("enqueue must succeed");
    tx.commit().await.expect("enqueue commit");
}

async fn set_smtp_enabled(pool: &DatabasePool, enabled: bool) {
    sqlx::query(
        "UPDATE instance_settings SET value=to_jsonb($1::boolean),\
         updated_at=transaction_timestamp(),lock_version=lock_version+1 WHERE key='smtp.enabled'",
    )
    .bind(enabled)
    .execute(&mut *acquire(pool).await)
    .await
    .expect("SMTP setting must update");
}

async fn verify_transaction_bound_enqueue(pool: &DatabasePool) {
    let delivery = delivery(
        NotificationId::new(),
        EmailOutboxId::new(),
        NotificationClassification::AccountAccess,
    );
    let notification_id = delivery.notification().id().to_string();
    let mut connection = acquire(pool).await;
    let mut transaction = connection.begin().await.expect("transaction must begin");
    NotificationWriter::enqueue(&mut transaction, &delivery)
        .await
        .expect("notification and email must enqueue");
    transaction.commit().await.expect("transaction must commit");

    assert_eq!(count_for(pool, "notifications", &notification_id).await, 1);
    assert_eq!(count_for(pool, "email_outbox", &notification_id).await, 1);
    let row = sqlx::query(
        "SELECT n.status, n.action_state, e.state, e.attempt_count, e.recipient_email
         FROM notifications n JOIN email_outbox e ON e.notification_id = n.id
         WHERE n.id = $1::uuid",
    )
    .bind(&notification_id)
    .fetch_one(&mut *acquire(pool).await)
    .await
    .expect("enqueued rows must load");
    assert_eq!(row.get::<String, _>("status"), "unread");
    assert_eq!(row.get::<String, _>("action_state"), "none");
    assert_eq!(row.get::<String, _>("state"), "pending");
    assert_eq!(row.get::<i16, _>("attempt_count"), 0);
    assert_eq!(
        row.get::<String, _>("recipient_email"),
        "member@example.test"
    );

    let protected_delete = sqlx::query("DELETE FROM notifications WHERE id = $1::uuid")
        .bind(&notification_id)
        .execute(&mut *acquire(pool).await)
        .await;
    assert!(
        protected_delete.is_err(),
        "pending outbox protects its notification"
    );
}

async fn verify_failure_rolls_back_both_rows(pool: &DatabasePool) {
    let shared_outbox_id = EmailOutboxId::new();
    let first = delivery(
        NotificationId::new(),
        shared_outbox_id,
        NotificationClassification::AccountAccess,
    );
    let mut connection = acquire(pool).await;
    let mut transaction = connection
        .begin()
        .await
        .expect("seed transaction must begin");
    NotificationWriter::enqueue(&mut transaction, &first)
        .await
        .expect("seed delivery must enqueue");
    transaction
        .commit()
        .await
        .expect("seed transaction must commit");

    let second = delivery(
        NotificationId::new(),
        shared_outbox_id,
        NotificationClassification::CriticalSecurity,
    );
    let second_id = second.notification().id().to_string();
    let mut connection = acquire(pool).await;
    let mut transaction = connection
        .begin()
        .await
        .expect("probe transaction must begin");
    let failure = NotificationWriter::enqueue(&mut transaction, &second)
        .await
        .expect_err("duplicate outbox identifier must reject the enqueue");
    assert_eq!(
        failure.category(),
        NotificationWriteErrorCategory::Constraint
    );
    transaction
        .rollback()
        .await
        .expect("probe transaction must roll back");
    assert_eq!(count_for(pool, "notifications", &second_id).await, 0);
    assert_eq!(count_for(pool, "email_outbox", &second_id).await, 0);
}

async fn verify_explicit_rollback(pool: &DatabasePool) {
    let delivery = NotificationDelivery::new(
        notification(
            NotificationId::new(),
            NotificationClassification::Collaboration,
        ),
        false,
        EmailChannelPreference::Enabled,
        None,
        None,
    )
    .expect("SMTP-disabled delivery has no email");
    let id = delivery.notification().id().to_string();
    let mut connection = acquire(pool).await;
    let mut transaction = connection.begin().await.expect("transaction must begin");
    NotificationWriter::enqueue(&mut transaction, &delivery)
        .await
        .expect("inbox row must enqueue");
    transaction
        .rollback()
        .await
        .expect("transaction must roll back");
    assert_eq!(count_for(pool, "notifications", &id).await, 0);
}

async fn verify_secret_and_lifecycle_constraints(pool: &DatabasePool) {
    assert_rejected(
        pool,
        "INSERT INTO notifications
         (id, recipient_user_id, classification, event_code, template_id, locale,
          resource_type, resource_id, rendering_data, first_occurred_at, last_occurred_at)
         VALUES ('0199ee6c-c777-7000-8000-000000003101',
                 '0199ee6c-c777-7000-8000-000000003001', 'collaboration',
                 'organization.invited', 'organization.invited', 'ko-KR',
                 'organization', 'org-1',
                 '{\"nested\":[[{\"invitationToken\":\"raw-secret\"}]]}'::jsonb,
                 CURRENT_TIMESTAMP, CURRENT_TIMESTAMP)",
        "nested token-shaped rendering data",
    )
    .await;
    assert_rejected(
        pool,
        "INSERT INTO notifications
         (id, recipient_user_id, classification, event_code, template_id, locale,
          resource_type, resource_id, rendering_data, first_occurred_at, last_occurred_at)
         VALUES ('0199ee6c-c777-7000-8000-000000003103',
                 '0199ee6c-c777-7000-8000-000000003001', 'collaboration',
                 'organization.invited', 'organization.invited', 'ko-KR',
                 'organization', 'org-1',
                 '{\"a\":{\"b\":{\"c\":{\"d\":{\"e\":{\"f\":{\"g\":{\"h\":{\"i\":1}}}}}}}}}'::jsonb,
                 CURRENT_TIMESTAMP, CURRENT_TIMESTAMP)",
        "rendering data deeper than eight levels",
    )
    .await;

    let pending_id = NotificationId::new().to_string();
    sqlx::query(
        "INSERT INTO notifications
         (id, recipient_user_id, classification, event_code, template_id, locale,
          resource_type, resource_id, action_state, first_occurred_at, last_occurred_at)
         VALUES ($1::uuid, '0199ee6c-c777-7000-8000-000000003001',
                 'account_access', 'mfa.deadline', 'mfa.deadline', 'en-US',
                 'user', '0199ee6c-c777-7000-8000-000000003001', 'pending',
                 CURRENT_TIMESTAMP, CURRENT_TIMESTAMP)",
    )
    .bind(&pending_id)
    .execute(&mut *acquire(pool).await)
    .await
    .expect("pending action notification must insert");
    sqlx::query(
        "UPDATE notifications SET action_state = 'resolved', resolved_at = CURRENT_TIMESTAMP,
         status = 'read', updated_at = CURRENT_TIMESTAMP, lock_version = lock_version + 1
         WHERE id = $1::uuid",
    )
    .bind(&pending_id)
    .execute(&mut *acquire(pool).await)
    .await
    .expect("action notification must resolve");
    let invalid_lock = sqlx::query(
        "UPDATE notifications SET status = 'archived', updated_at = CURRENT_TIMESTAMP
         WHERE id = $1::uuid",
    )
    .bind(&pending_id)
    .execute(&mut *acquire(pool).await)
    .await;
    assert!(
        invalid_lock.is_err(),
        "exact notification lock advancement must reject"
    );
    assert_rejected_bound(
        pool,
        "UPDATE notifications SET action_state = 'pending', resolved_at = NULL,
         updated_at = CURRENT_TIMESTAMP, lock_version = lock_version + 1
         WHERE id = $1::uuid",
        &pending_id,
        "terminal action reversal",
    )
    .await;
    sqlx::query(
        "UPDATE notifications SET occurrence_count = 2,
         last_occurred_at = last_occurred_at + INTERVAL '1 second',
         updated_at = updated_at + INTERVAL '1 second', lock_version = lock_version + 1
         WHERE id = $1::uuid",
    )
    .bind(&pending_id)
    .execute(&mut *acquire(pool).await)
    .await
    .expect("notification recurrence history must advance");
    assert_rejected_bound(
        pool,
        "UPDATE notifications SET occurrence_count = occurrence_count - 1,
         updated_at = updated_at + INTERVAL '1 second', lock_version = lock_version + 1
         WHERE id = $1::uuid",
        &pending_id,
        "notification occurrence history decrease",
    )
    .await;

    assert_rejected(
        pool,
        "INSERT INTO email_outbox
         (id, recipient_email, classification, template_id, locale, resource_type,
          resource_id, rendering_data)
         VALUES ('0199ee6c-c777-7000-8000-000000003102', 'new@example.test',
                 'collaboration', 'organization.invited', 'ko-KR', 'organization', 'org-1',
                 '{\"activationUrl\":\"https://example.test/raw-secret\"}'::jsonb)",
        "outbox activation URL",
    )
    .await;
}

async fn verify_terminal_delivery_retention_and_state_machine(pool: &DatabasePool) {
    let outbox_id = EmailOutboxId::new();
    let outbox_id_text = outbox_id.to_string();
    let dead_letter_id = EmailOutboxId::new().to_string();
    let canceled_id = EmailOutboxId::new().to_string();
    let delivery = delivery(
        NotificationId::new(),
        outbox_id,
        NotificationClassification::AccountAccess,
    );
    let notification_id = delivery.notification().id().to_string();
    let mut connection = acquire(pool).await;
    let mut transaction = connection.begin().await.expect("transaction must begin");
    NotificationWriter::enqueue(&mut transaction, &delivery)
        .await
        .expect("delivery must enqueue");
    transaction.commit().await.expect("delivery must commit");

    assert_rejected_bound(
        pool,
        "UPDATE email_outbox SET state = 'sending',
         lease_owner = 'worker-invalid', lease_expires_at = clock_timestamp() + INTERVAL '30 seconds',
         updated_at = clock_timestamp(), lock_version = lock_version + 1
         WHERE notification_id = $1::uuid",
        &notification_id,
        "claim without an attempt record",
    )
    .await;
    sqlx::query(
        "UPDATE email_outbox SET state = 'sending', attempt_count = 1,
         first_attempt_at = clock_timestamp(), last_attempt_at = clock_timestamp(),
         lease_owner = '0199ee6c-c777-7000-8000-000000003101', \
         lease_expires_at = clock_timestamp() + INTERVAL '30 seconds',
         updated_at = clock_timestamp(), lock_version = lock_version + 1
         WHERE notification_id = $1::uuid",
    )
    .bind(&notification_id)
    .execute(&mut *acquire(pool).await)
    .await
    .expect("pending delivery must claim exactly one attempt");
    sqlx::query(
        "UPDATE email_outbox SET state = 'sent', sent_at = clock_timestamp(),
         lease_owner = NULL, lease_expires_at = NULL, last_smtp_code = 250,
         last_error_class = NULL, updated_at = clock_timestamp(), lock_version = lock_version + 1
         WHERE notification_id = $1::uuid",
    )
    .bind(&notification_id)
    .execute(&mut *acquire(pool).await)
    .await
    .expect("sending delivery must become sent");

    for additional_id in [&dead_letter_id, &canceled_id] {
        sqlx::query(
            "INSERT INTO email_outbox
             (id, notification_id, recipient_user_id, recipient_email, classification,
              template_id, locale, resource_type, resource_id, rendering_data)
             SELECT $1::uuid, id, recipient_user_id, 'member@example.test', classification,
                    template_id, locale, resource_type, resource_id, rendering_data
             FROM notifications WHERE id = $2::uuid",
        )
        .bind(additional_id)
        .bind(&notification_id)
        .execute(&mut *acquire(pool).await)
        .await
        .expect("additional terminal-path delivery must insert");
    }
    sqlx::query(
        "UPDATE email_outbox SET state = 'canceled', updated_at = clock_timestamp(),
         lock_version = lock_version + 1 WHERE id = $1::uuid",
    )
    .bind(&canceled_id)
    .execute(&mut *acquire(pool).await)
    .await
    .expect("pending delivery may be canceled");
    sqlx::query(
        "UPDATE email_outbox SET state = 'sending', attempt_count = 1,
         first_attempt_at = clock_timestamp(), last_attempt_at = clock_timestamp(),
         lease_owner = '0199ee6c-c777-7000-8000-000000003101', \
         lease_expires_at = clock_timestamp() + INTERVAL '30 seconds',
         updated_at = clock_timestamp(), lock_version = lock_version + 1
         WHERE id = $1::uuid",
    )
    .bind(&dead_letter_id)
    .execute(&mut *acquire(pool).await)
    .await
    .expect("dead-letter path must claim its first attempt");
    sqlx::query(
        "UPDATE email_outbox SET state = 'retry_wait',
         available_at = clock_timestamp() + INTERVAL '1 minute',
         lease_owner = NULL, lease_expires_at = NULL, last_smtp_code = 421,
         last_error_class = 'transient', updated_at = clock_timestamp(),
         lock_version = lock_version + 1 WHERE id = $1::uuid",
    )
    .bind(&dead_letter_id)
    .execute(&mut *acquire(pool).await)
    .await
    .expect("transient delivery failure must enter retry wait");
    sqlx::query(
        "UPDATE email_outbox SET state = 'sending', attempt_count = 2,
         last_attempt_at = clock_timestamp(), \
         lease_owner = '0199ee6c-c777-7000-8000-000000003102',
         lease_expires_at = clock_timestamp() + INTERVAL '30 seconds',
         updated_at = clock_timestamp(), lock_version = lock_version + 1
         WHERE id = $1::uuid",
    )
    .bind(&dead_letter_id)
    .execute(&mut *acquire(pool).await)
    .await
    .expect("retry delivery must claim exactly one additional attempt");
    sqlx::query(
        "UPDATE email_outbox SET state = 'dead_letter', lease_owner = NULL,
         lease_expires_at = NULL, last_smtp_code = 550,
         last_error_class = 'permanent', updated_at = clock_timestamp(),
         lock_version = lock_version + 1 WHERE id = $1::uuid",
    )
    .bind(&dead_letter_id)
    .execute(&mut *acquire(pool).await)
    .await
    .expect("permanent retry failure must enter dead letter");

    assert_rejected_bound(
        pool,
        "UPDATE email_outbox SET state = 'pending', sent_at = NULL,
         last_smtp_code = NULL, updated_at = clock_timestamp(), lock_version = lock_version + 1
         WHERE notification_id = $1::uuid",
        &notification_id,
        "sent delivery replay",
    )
    .await;
    sqlx::query("DELETE FROM notifications WHERE id = $1::uuid")
        .bind(&notification_id)
        .execute(&mut *acquire(pool).await)
        .await
        .expect("terminal delivery permits notification retention delete");
    assert_terminal_outbox_detached(pool, &outbox_id_text, "sent", 1).await;
    assert_terminal_outbox_detached(pool, &dead_letter_id, "dead_letter", 2).await;
    assert_terminal_outbox_detached(pool, &canceled_id, "canceled", 0).await;

    let terminal_mutation = sqlx::query(
        "UPDATE email_outbox SET available_at = available_at + INTERVAL '1 second',
         updated_at = updated_at + INTERVAL '1 second', lock_version = lock_version + 1
         WHERE id = $1::uuid",
    )
    .bind(&outbox_id_text)
    .execute(&mut *acquire(pool).await)
    .await;
    assert!(
        terminal_mutation.is_err(),
        "terminal delivery scheduling history must be immutable"
    );
}

async fn assert_terminal_outbox_detached(
    pool: &DatabasePool,
    outbox_id: &str,
    expected_state: &str,
    expected_attempts: i16,
) {
    let row = sqlx::query(
        "SELECT notification_id::text AS notification_id,
                recipient_user_id::text AS recipient_user_id, state, attempt_count
         FROM email_outbox WHERE id = $1::uuid",
    )
    .bind(outbox_id)
    .fetch_one(&mut *acquire(pool).await)
    .await
    .expect("terminal delivery history must remain");
    assert_eq!(row.get::<Option<String>, _>("notification_id"), None);
    assert_eq!(row.get::<Option<String>, _>("recipient_user_id"), None);
    assert_eq!(row.get::<String, _>("state"), expected_state);
    assert_eq!(row.get::<i16, _>("attempt_count"), expected_attempts);
}

async fn verify_linked_message_consistency(pool: &DatabasePool) {
    let notification_id = NotificationId::new().to_string();
    sqlx::query(
        "INSERT INTO notifications
         (id, recipient_user_id, classification, event_code, template_id, locale,
          resource_type, resource_id, rendering_data, first_occurred_at, last_occurred_at)
         VALUES ($1::uuid, '0199ee6c-c777-7000-8000-000000003001', 'collaboration',
                 'organization.invited', 'organization.invited', 'ko-KR', 'organization',
                 'org-1', '{\"organization\":\"Example\"}'::jsonb,
                 CURRENT_TIMESTAMP, CURRENT_TIMESTAMP)",
    )
    .bind(&notification_id)
    .execute(&mut *acquire(pool).await)
    .await
    .expect("linked notification must insert");
    assert_rejected_bound(
        pool,
        "INSERT INTO email_outbox
         (id, notification_id, recipient_user_id, recipient_email, classification,
          template_id, locale, resource_type, resource_id, rendering_data)
         VALUES ('0199ee6c-c777-7000-8000-000000003105', $1::uuid,
                 '0199ee6c-c777-7000-8000-000000003001', 'member@example.test',
                 'account_access', 'organization.invited', 'ko-KR', 'organization', 'org-1',
                 '{\"organization\":\"Example\"}'::jsonb)",
        &notification_id,
        "linked outbox classification mismatch",
    )
    .await;
}

async fn verify_compact_payload_boundary_parity(pool: &DatabasePool) {
    let at_limit = json!({
        "a": "x".repeat(4_096),
        "b": "x".repeat(4_096),
        "c": "x".repeat(4_096),
        "d": "x".repeat(4_067),
    });
    let over_limit = json!({
        "a": "x".repeat(4_096),
        "b": "x".repeat(4_096),
        "c": "x".repeat(4_096),
        "d": "x".repeat(4_068),
    });
    assert_eq!(serde_json::to_vec(&at_limit).unwrap().len(), 16_384);
    assert_eq!(serde_json::to_vec(&over_limit).unwrap().len(), 16_385);
    assert!(NotificationPayload::new(at_limit.clone()).is_ok());
    assert_eq!(
        NotificationPayload::new(over_limit.clone()),
        Err(NotificationValidationError::PayloadTooLarge)
    );
    let database_at: i64 =
        sqlx::query_scalar("SELECT notification_payload_compact_octets($1::jsonb)")
            .bind(at_limit.to_string())
            .fetch_one(&mut *acquire(pool).await)
            .await
            .expect("database compact size must load");
    let database_over: i64 =
        sqlx::query_scalar("SELECT notification_payload_compact_octets($1::jsonb)")
            .bind(over_limit.to_string())
            .fetch_one(&mut *acquire(pool).await)
            .await
            .expect("database compact size must load");
    assert_eq!(database_at, 16_384);
    assert_eq!(database_over, 16_385);

    let at_limit_id = NotificationId::new().to_string();
    sqlx::query(
        "INSERT INTO notifications
         (id, recipient_user_id, classification, event_code, template_id, locale,
          resource_type, resource_id, rendering_data, first_occurred_at, last_occurred_at)
         VALUES ($1::uuid, '0199ee6c-c777-7000-8000-000000003001', 'operations',
                 'payload.boundary', 'payload.boundary', 'en-US', 'system', 'boundary',
                 $2::jsonb, CURRENT_TIMESTAMP, CURRENT_TIMESTAMP)",
    )
    .bind(&at_limit_id)
    .bind(at_limit.to_string())
    .execute(&mut *acquire(pool).await)
    .await
    .expect("exactly 16 KiB compact rendering data must insert");

    let over_limit_id = NotificationId::new().to_string();
    let over_limit_insert = sqlx::query(
        "INSERT INTO notifications
         (id, recipient_user_id, classification, event_code, template_id, locale,
          resource_type, resource_id, rendering_data, first_occurred_at, last_occurred_at)
         VALUES ($1::uuid, '0199ee6c-c777-7000-8000-000000003001', 'operations',
                 'payload.boundary', 'payload.boundary', 'en-US', 'system', 'boundary',
                 $2::jsonb, CURRENT_TIMESTAMP, CURRENT_TIMESTAMP)",
    )
    .bind(&over_limit_id)
    .bind(over_limit.to_string())
    .execute(&mut *acquire(pool).await)
    .await;
    assert!(
        over_limit_insert.is_err(),
        "16 KiB plus one compact byte must be rejected by PostgreSQL"
    );
}

async fn verify_schema_shape(pool: &DatabasePool) {
    for table in ["notifications", "email_outbox"] {
        let columns: Vec<String> = sqlx::query_scalar(
            "SELECT column_name FROM information_schema.columns
             WHERE table_schema = current_schema() AND table_name = $1 ORDER BY column_name",
        )
        .bind(table)
        .fetch_all(&mut *acquire(pool).await)
        .await
        .unwrap_or_else(|error| panic!("{table} columns must load: {error}"));
        for forbidden in [
            "token",
            "password",
            "credential",
            "secret",
            "session",
            "email_body",
            "invitation_url",
        ] {
            assert!(
                columns.iter().all(|column| !column.contains(forbidden)),
                "{table} must not expose a {forbidden} column"
            );
        }
    }
}

fn delivery(
    notification_id: NotificationId,
    outbox_id: EmailOutboxId,
    classification: NotificationClassification,
) -> NotificationDelivery {
    NotificationDelivery::new(
        notification(notification_id, classification),
        true,
        EmailChannelPreference::Default,
        Some(outbox_id),
        Some(NormalizedEmail::from_email("member@example.test").expect("fixture email")),
    )
    .expect("classification enables email by default")
}

fn notification(id: NotificationId, classification: NotificationClassification) -> Notification {
    Notification::new(NotificationFields {
        id,
        recipient_user_id: fixture_user_id(),
        classification,
        event_code: "identity.access.changed".to_owned(),
        template_id: "identity.access_changed".to_owned(),
        locale: "ko-KR".to_owned(),
        resource_type: "user".to_owned(),
        resource_id: fixture_user_id().to_string(),
        rendering_data: NotificationPayload::new(json!({"actorDisplayName": "Admin"}))
            .expect("safe fixture data"),
        requires_action: false,
        occurred_at: Timestamp::from_unix_timestamp(1_759_795_200).expect("fixture timestamp"),
    })
    .expect("fixture notification")
}

fn fixture_user_id() -> UserId {
    UserId::from_uuid(
        Uuid::parse_str("0199ee6c-c777-7000-8000-000000003001").expect("fixture UUID"),
    )
    .expect("UUIDv7 user ID")
}

async fn seed_user(pool: &DatabasePool) {
    execute(
        pool,
        "INSERT INTO users (id, email, normalized_email, display_name)
         VALUES ('0199ee6c-c777-7000-8000-000000003001',
                 'member@example.test', 'member@example.test', 'Member')",
        "fixture user",
    )
    .await;
}

async fn count_for(pool: &DatabasePool, table: &str, notification_id: &str) -> i64 {
    let statement = if table == "notifications" {
        "SELECT COUNT(*) FROM notifications WHERE id = $1::uuid"
    } else {
        "SELECT COUNT(*) FROM email_outbox WHERE notification_id = $1::uuid"
    };
    sqlx::query_scalar(statement)
        .bind(notification_id)
        .fetch_one(&mut *acquire(pool).await)
        .await
        .unwrap_or_else(|error| panic!("{table} count must load: {error}"))
}

async fn assert_rejected(pool: &DatabasePool, statement: &'static str, contract: &str) {
    let result = sqlx::query(statement)
        .execute(&mut *acquire(pool).await)
        .await;
    assert!(result.is_err(), "{contract} must be rejected");
}

async fn assert_rejected_bound(
    pool: &DatabasePool,
    statement: &'static str,
    value: &str,
    contract: &str,
) {
    let result = sqlx::query(statement)
        .bind(value)
        .execute(&mut *acquire(pool).await)
        .await;
    assert!(result.is_err(), "{contract} must be rejected");
}

async fn execute(pool: &DatabasePool, statement: &'static str, contract: &str) {
    sqlx::query(statement)
        .execute(&mut *acquire(pool).await)
        .await
        .unwrap_or_else(|error| panic!("{contract} must succeed: {error}"));
}

async fn migrate(pool: &DatabasePool) -> MigrationReport {
    run_embedded_migrations(
        pool,
        MigrationOptions::new(Duration::from_secs(5), Duration::from_secs(30))
            .expect("fixture migration policy"),
    )
    .await
    .unwrap_or_else(|error| panic!("fixture migrations must succeed: {error}"))
}

async fn readiness(pool: &DatabasePool) -> SchemaReadiness {
    check_schema_readiness(pool)
        .await
        .unwrap_or_else(|error| panic!("fixture readiness must succeed: {error}"))
}

async fn acquire(pool: &DatabasePool) -> sqlx::pool::PoolConnection<sqlx::Postgres> {
    pool.acquire()
        .await
        .unwrap_or_else(|error| panic!("fixture must acquire a connection: {error}"))
}

async fn reset_fixture(pool: &DatabasePool) {
    let mut connection = acquire(pool).await;
    connection
        .execute("DROP SCHEMA public CASCADE; CREATE SCHEMA public")
        .await
        .unwrap_or_else(|error| panic!("fixture schema reset must succeed: {error}"));
}

async fn fixture_pool() -> DatabasePool {
    let database_url = env::var(DATABASE_URL_ENV).expect("fixture database URL must be set");
    let ca_path = env::var(DATABASE_CA_ENV).expect("fixture CA path must be set");
    let ca_pem = fs::read(&ca_path)
        .unwrap_or_else(|error| panic!("fixture CA {ca_path} must be readable: {error}"));
    let tls = DatabaseTlsConfig::verify_full(None, Some(ca_pem), None)
        .expect("fixture TLS config must be valid");
    let config = DatabasePoolConfig::new(
        database_url,
        1,
        4,
        Duration::from_secs(5),
        Duration::from_secs(5),
        tls,
    )
    .expect("fixture pool config must be valid");
    DatabasePool::connect(config)
        .await
        .unwrap_or_else(|error| panic!("fixture pool must connect: {error}"))
}
