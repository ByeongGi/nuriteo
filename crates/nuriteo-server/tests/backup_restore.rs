use std::env;
use std::fs;
use std::path::PathBuf;

use aws_sdk_s3::config::{BehaviorVersion, Credentials, Region};
use aws_sdk_s3::primitives::ByteStream;
use aws_sdk_s3::types::ServerSideEncryption;
use aws_smithy_http_client::pool::{Client as PoolClient, ConnectionPool};
use aws_smithy_http_client::tls::rustls_provider::CryptoMode;
use aws_smithy_http_client::tls::{self, TlsContext, TrustStore};
use bytes::Bytes;
use nuriteo_server::backup::{
    BackupCreateCoordinator, BackupDestination, BackupDestinationRuntime, BackupReadCoordinator,
    BackupRestoreCoordinator, BackupRestoreError, CommandPgDump, PgDumpCommandConfig,
    PortableLimits, RestoreRuntime,
};
use nuriteo_server::config::{SystemEnvironment, SystemFileReader};
use nuriteo_server::database::{DatabasePool, DatabaseRuntimeConfig, run_embedded_migrations};
use nuriteo_server::object_storage::{
    ObjectKey, ObjectStorageConfig, OperationLimits, PutRequest, S3ObjectStore,
};
use nuriteo_server::{CommandStatus, run_async};
use sha2::{Digest, Sha256};
use sqlx::Executor;
use uuid::Uuid;

const USER_ID: &str = "0199ee6c-c777-7000-8000-000000022001";
const SCOPE_ID: &str = "0199ee6c-c777-7000-8000-000000022002";
const PROJECT_ID: &str = "0199ee6c-c777-7000-8000-000000022003";
const SAVE_SESSION_ID: &str = "0199ee6c-c777-7000-8000-000000022004";
const BUNDLE_ID: &str = "0199ee6c-c777-7000-8000-000000022005";
const SESSION_ID: &str = "0199ee6c-c777-7000-8000-000000022006";
const AUDIT_EVENT_ID: &str = "0199ee6c-c777-7000-8000-000000022007";
const HISTORY_PROMOTION_ID: &str = "0199ee6c-c777-7000-8000-000000022008";
const HISTORY_REFERENCE_ID: &str = "0199ee6c-c777-7000-8000-000000022009";
const OBJECT_KEY: &str = "bundles/restore-drill";

#[tokio::test]
#[ignore = "requires tests/fixtures/backup-restore/run.sh"]
async fn encrypted_backup_restores_into_isolated_database_and_bucket() {
    let environment = SystemEnvironment;
    let files = SystemFileReader;
    let source_runtime = DatabaseRuntimeConfig::load(&environment, &files).unwrap();
    let source_pool = DatabasePool::connect(source_runtime.pool_config())
        .await
        .unwrap();
    let restore_runtime = RestoreRuntime::load(&environment, &files).unwrap();
    let target_close_timeout = restore_runtime.database.close_timeout();
    let target_pool = DatabasePool::connect(restore_runtime.database.pool_config())
        .await
        .unwrap();
    reset_database(&source_pool).await;
    reset_database(&target_pool).await;
    let migration = run_embedded_migrations(&source_pool, source_runtime.migration_options())
        .await
        .unwrap();
    let schema_version = migration.latest_version.expect("schema has migrations");

    let ca_pem = fs::read(required_path("NURITEO_TEST_S3_CA_FILE")).unwrap();
    let fixture_client = prepare_buckets(&ca_pem).await;
    let primary_config = ObjectStorageConfig::load(&environment, &files).unwrap();
    let primary = S3ObjectStore::new(&primary_config, OperationLimits::default())
        .await
        .unwrap();
    let body = vec![0x5a; 128];
    let digest: [u8; 32] = Sha256::digest(&body).into();
    primary
        .put(PutRequest {
            key: ObjectKey::parse(OBJECT_KEY.to_owned()).unwrap(),
            body: Bytes::from(body.clone()),
            content_type: Some("application/octet-stream".to_owned()),
        })
        .await
        .unwrap();
    seed_source(&source_pool, digest, body.len()).await;

    let backup_runtime = BackupDestinationRuntime::load(&environment, &files).unwrap();
    let destination =
        BackupDestination::new(backup_runtime.config, &backup_runtime.credential).unwrap();
    let generation_id = Uuid::now_v7();
    let scratch = required_path("NURITEO_BACKUP_SCRATCH_DIR");
    let dump = PgDumpCommandConfig::load(
        &environment,
        &files,
        scratch.join(format!("database-{generation_id}.dump")),
    )
    .unwrap();
    let created = BackupCreateCoordinator::new(source_pool.clone(), primary, destination.clone())
        .create(
            generation_id,
            schema_version,
            postgres_major(&source_pool).await,
            CommandPgDump::new(dump),
            &scratch,
        )
        .await
        .unwrap();
    assert_eq!(created.entries, 2);
    let manifest_key = destination.manifest_object_key(generation_id);
    let payload_key = destination.payload_object_key(digest);

    let reader =
        BackupReadCoordinator::new(source_pool.clone(), destination, PortableLimits::default());
    let verified = reader
        .verify(&generation_id.to_string(), &scratch)
        .await
        .unwrap();
    assert_eq!(verified.entries, 2);
    let staged = reader
        .stage(&generation_id.to_string(), &scratch)
        .await
        .unwrap();

    let target_storage = S3ObjectStore::new(&restore_runtime.storage, OperationLimits::default())
        .await
        .unwrap();
    drop(restore_runtime);
    let mut stdout = Vec::new();
    let mut stderr = Vec::new();
    let generation_id_text = generation_id.to_string();
    let status = run_async(
        ["backup", "drill", generation_id_text.as_str()],
        &mut stdout,
        &mut stderr,
    )
    .await
    .unwrap();
    assert_eq!(
        status,
        CommandStatus::Success,
        "{}",
        String::from_utf8_lossy(&stderr)
    );
    let output = String::from_utf8(stdout).unwrap();
    assert!(output.contains(&format!("backup drill complete: {generation_id}")));
    assert!(output.contains("entries=2"));
    assert_restored_database(&target_pool).await;
    assert_eq!(
        target_storage
            .get(&ObjectKey::parse(OBJECT_KEY.to_owned()).unwrap())
            .await
            .unwrap()
            .body,
        Bytes::from(body)
    );

    let second_runtime = RestoreRuntime::load(&environment, &files).unwrap();
    let second_storage = S3ObjectStore::new(&second_runtime.storage, OperationLimits::default())
        .await
        .unwrap();
    let error = BackupRestoreCoordinator::new(
        source_pool.clone(),
        target_pool.clone(),
        second_storage,
        second_runtime,
    )
    .restore(&staged)
    .await
    .expect_err("a populated restore target must fail closed");
    assert_eq!(error, BackupRestoreError::TargetNotEmpty);
    verify_corrupt_and_missing_objects_fail_closed(
        &fixture_client,
        &reader,
        generation_id,
        &manifest_key,
        &payload_key,
        &scratch,
    )
    .await;

    source_pool
        .close(source_runtime.close_timeout())
        .await
        .unwrap();
    target_pool.close(target_close_timeout).await.unwrap();
}

async fn prepare_buckets(ca_pem: &[u8]) -> aws_sdk_s3::Client {
    let endpoint = env::var("NURITEO_S3_ENDPOINT").unwrap();
    let access_key = env::var("NURITEO_S3_ACCESS_KEY_ID").unwrap();
    let secret_key = env::var("NURITEO_S3_SECRET_ACCESS_KEY").unwrap();
    let context = TlsContext::builder()
        .with_trust_store(TrustStore::default().with_pem_certificate(ca_pem.to_vec()))
        .build()
        .unwrap();
    let pool = ConnectionPool::builder()
        .tls_provider(tls::Provider::Rustls(CryptoMode::Ring))
        .tls_context(context)
        .build_https()
        .unwrap();
    let client = aws_sdk_s3::Client::from_conf(
        aws_sdk_s3::Config::builder()
            .behavior_version(BehaviorVersion::latest())
            .endpoint_url(endpoint)
            .region(Region::new("us-east-1"))
            .force_path_style(true)
            .credentials_provider(Credentials::new(
                access_key,
                secret_key,
                None,
                None,
                "backup-restore-fixture",
            ))
            .http_client(PoolClient::new(&pool).unwrap())
            .build(),
    );
    for bucket in ["nuriteo-primary", "nuriteo-backup", "nuriteo-restore"] {
        client.create_bucket().bucket(bucket).send().await.unwrap();
    }
    install_delete_deny(&client).await;
    client
}

async fn install_delete_deny(client: &aws_sdk_s3::Client) {
    let policy = r#"{"Version":"2012-10-17","Statement":[{"Sid":"DenyBackupDelete","Effect":"Deny","Principal":"*","Action":["s3:DeleteObject","s3:DeleteObjectVersion"],"Resource":"arn:aws:s3:::nuriteo-backup/instance-1/backups/*"}]}"#;
    client
        .put_bucket_policy()
        .bucket("nuriteo-backup")
        .policy(policy)
        .send()
        .await
        .unwrap();
}

async fn verify_corrupt_and_missing_objects_fail_closed(
    client: &aws_sdk_s3::Client,
    reader: &BackupReadCoordinator,
    generation_id: Uuid,
    manifest_key: &str,
    payload_key: &str,
    scratch: &std::path::Path,
) {
    let original_manifest = client
        .get_object()
        .bucket("nuriteo-backup")
        .key(manifest_key)
        .send()
        .await
        .unwrap()
        .body
        .collect()
        .await
        .unwrap()
        .into_bytes();
    client
        .delete_bucket_policy()
        .bucket("nuriteo-backup")
        .send()
        .await
        .unwrap();
    put_fixture_object(client, manifest_key, b"corrupt-manifest".to_vec()).await;
    let error = reader
        .verify(&generation_id.to_string(), scratch)
        .await
        .expect_err("a corrupted manifest must fail closed");
    assert_eq!(error.category(), "destination");

    put_fixture_object(client, manifest_key, original_manifest.to_vec()).await;
    client
        .delete_object()
        .bucket("nuriteo-backup")
        .key(payload_key)
        .send()
        .await
        .unwrap();
    let error = reader
        .verify(&generation_id.to_string(), scratch)
        .await
        .expect_err("a missing payload must fail closed");
    assert_eq!(error.category(), "destination");
    install_delete_deny(client).await;
}

async fn put_fixture_object(client: &aws_sdk_s3::Client, key: &str, body: Vec<u8>) {
    client
        .put_object()
        .bucket("nuriteo-backup")
        .key(key)
        .server_side_encryption(ServerSideEncryption::Aes256)
        .body(ByteStream::from(body))
        .send()
        .await
        .unwrap();
}

async fn reset_database(pool: &DatabasePool) {
    pool.acquire()
        .await
        .unwrap()
        .execute("DROP SCHEMA public CASCADE; CREATE SCHEMA public")
        .await
        .unwrap();
}

async fn seed_source(pool: &DatabasePool, digest: [u8; 32], bytes: usize) {
    let physical_bytes = i64::try_from(bytes).unwrap();
    let mut connection = pool.acquire().await.unwrap();
    connection.execute("BEGIN").await.unwrap();
    sqlx::query(
        "INSERT INTO users(id,email,normalized_email,display_name,is_instance_admin)
         VALUES($1::uuid,'restore@example.test','restore@example.test','Restore fixture',TRUE)",
    )
    .bind(USER_ID)
    .execute(&mut *connection)
    .await
    .unwrap();
    sqlx::query("INSERT INTO storage_scopes(id,owner_user_id) VALUES($1::uuid,$2::uuid)")
        .bind(SCOPE_ID)
        .bind(USER_ID)
        .execute(&mut *connection)
        .await
        .unwrap();
    sqlx::query(
        "INSERT INTO projects(id,owner_user_id,storage_scope_id,slug,name)
         VALUES($1::uuid,$2::uuid,$3::uuid,'restore-drill','Restore drill')",
    )
    .bind(PROJECT_ID)
    .bind(USER_ID)
    .bind(SCOPE_ID)
    .execute(&mut *connection)
    .await
    .unwrap();
    sqlx::query(
        "INSERT INTO save_sessions(
             id,project_id,storage_scope_id,actor_user_id,expected_project_version,
             expected_bundle_sha256,expected_physical_bytes,expected_logical_bytes,
             expected_file_count,staging_object_key,upload_mode,expires_at)
         VALUES($1::uuid,$2::uuid,$3::uuid,$4::uuid,1,$5,$6,$6,1,$7,'single',
                transaction_timestamp()+interval '1 hour')",
    )
    .bind(SAVE_SESSION_ID)
    .bind(PROJECT_ID)
    .bind(SCOPE_ID)
    .bind(USER_ID)
    .bind(digest.as_slice())
    .bind(physical_bytes)
    .bind(OBJECT_KEY)
    .execute(&mut *connection)
    .await
    .unwrap();
    for state in ["uploading", "verifying"] {
        sqlx::query(
            "UPDATE save_sessions SET state=$2,updated_at=transaction_timestamp()
             WHERE id=$1::uuid",
        )
        .bind(SAVE_SESSION_ID)
        .bind(state)
        .execute(&mut *connection)
        .await
        .unwrap();
    }
    sqlx::query(
        "INSERT INTO bundles(
             id,sha256,object_key,physical_bytes,logical_bytes,file_count,format,verified_at)
         VALUES($1::uuid,$2,$3,$4,$4,1,'project-bundle-v1',transaction_timestamp())",
    )
    .bind(BUNDLE_ID)
    .bind(digest.as_slice())
    .bind(OBJECT_KEY)
    .bind(physical_bytes)
    .execute(&mut *connection)
    .await
    .unwrap();
    sqlx::query(
        "UPDATE save_sessions SET state='committed',committed_bundle_id=$2::uuid,
         terminal_at=transaction_timestamp(),updated_at=transaction_timestamp()
         WHERE id=$1::uuid",
    )
    .bind(SAVE_SESSION_ID)
    .bind(BUNDLE_ID)
    .execute(&mut *connection)
    .await
    .unwrap();
    sqlx::query(
        "INSERT INTO project_bundle_admissions(
             project_id,storage_scope_id,bundle_id,source_save_session_id,save_session_id)
         VALUES($1::uuid,$2::uuid,$3::uuid,$4::uuid,$4::uuid)",
    )
    .bind(PROJECT_ID)
    .bind(SCOPE_ID)
    .bind(BUNDLE_ID)
    .bind(SAVE_SESSION_ID)
    .execute(&mut *connection)
    .await
    .unwrap();
    sqlx::query(
        "UPDATE projects SET working_head_bundle_id=$2::uuid,lock_version=lock_version+1,
         updated_at=transaction_timestamp() WHERE id=$1::uuid",
    )
    .bind(PROJECT_ID)
    .bind(BUNDLE_ID)
    .execute(&mut *connection)
    .await
    .unwrap();
    sqlx::query(
        "INSERT INTO sessions(
             id,user_id,token_hash,idle_expires_at,absolute_expires_at,last_reauthenticated_at)
         VALUES($1::uuid,$2::uuid,decode(repeat('22',32),'hex'),
                transaction_timestamp()+interval '1 hour',
                transaction_timestamp()+interval '2 hours',transaction_timestamp())",
    )
    .bind(SESSION_ID)
    .bind(USER_ID)
    .execute(&mut *connection)
    .await
    .unwrap();
    sqlx::query(
        "INSERT INTO audit_events(id,actor_type,actor_id,actor_user_id,actor_display_name,
         action_code,target_type,target_id,scope_type,scope_id,result,correlation_id,metadata)
         VALUES($1::uuid,'user',$2,$2::uuid,'Restore fixture','project.history_promoted',
                'project_history_reference',$3,'project',$4,'succeeded','fixture:backup-audit',
                '{\"source\":\"backup-restore-fixture\"}'::jsonb)",
    )
    .bind(AUDIT_EVENT_ID)
    .bind(USER_ID)
    .bind(HISTORY_REFERENCE_ID)
    .bind(PROJECT_ID)
    .execute(&mut *connection)
    .await
    .unwrap();
    sqlx::query(
        "INSERT INTO project_history_promotions(
         id,project_id,actor_user_id,idempotency_digest,reference_kind,reference_id,bundle_id,
         expected_project_version,resulting_project_version,changed,audit_event_id)
         VALUES($1::uuid,$2::uuid,$3::uuid,decode(repeat('42',32),'hex'),'version',$4::uuid,
                $5::uuid,1,2,TRUE,$6::uuid)",
    )
    .bind(HISTORY_PROMOTION_ID)
    .bind(PROJECT_ID)
    .bind(USER_ID)
    .bind(HISTORY_REFERENCE_ID)
    .bind(BUNDLE_ID)
    .bind(AUDIT_EVENT_ID)
    .execute(&mut *connection)
    .await
    .unwrap();
    connection.execute("COMMIT").await.unwrap();
}

async fn assert_restored_database(pool: &DatabasePool) {
    let project: (String, i64) =
        sqlx::query_as("SELECT slug,lock_version FROM projects WHERE id=$1::uuid")
            .bind(PROJECT_ID)
            .fetch_one(&mut *pool.acquire().await.unwrap())
            .await
            .unwrap();
    assert_eq!(project, ("restore-drill".to_owned(), 2));
    let session: (bool, Option<String>) = sqlx::query_as(
        "SELECT revoked_at IS NOT NULL,revocation_reason FROM sessions WHERE id=$1::uuid",
    )
    .bind(SESSION_ID)
    .fetch_one(&mut *pool.acquire().await.unwrap())
    .await
    .unwrap();
    assert_eq!(session, (true, Some("backup_restore".to_owned())));
    let recovery: (String, Option<String>) =
        sqlx::query_as("SELECT state,reason FROM instance_recovery_state WHERE singleton")
            .fetch_one(&mut *pool.acquire().await.unwrap())
            .await
            .unwrap();
    assert_eq!(
        recovery,
        (
            "needs_reconfiguration".to_owned(),
            Some("missing_recovery_kit".to_owned())
        )
    );
    let restored_audit: (String, String) = sqlx::query_as(
        "SELECT event.action_code,promotion.audit_event_id::text
         FROM audit_events event JOIN project_history_promotions promotion
           ON promotion.audit_event_id=event.id
         WHERE event.id=$1::uuid AND promotion.id=$2::uuid",
    )
    .bind(AUDIT_EVENT_ID)
    .bind(HISTORY_PROMOTION_ID)
    .fetch_one(&mut *pool.acquire().await.unwrap())
    .await
    .unwrap();
    assert_eq!(
        restored_audit,
        (
            "project.history_promoted".to_owned(),
            AUDIT_EVENT_ID.to_owned()
        )
    );
    let smtp_enable = sqlx::query(
        "INSERT INTO instance_settings(key,registry_version,value,bootstrap_origin)
         VALUES('smtp.enabled',4,'true'::jsonb,'default')
         ON CONFLICT(key) DO UPDATE SET value=EXCLUDED.value,
             lock_version=instance_settings.lock_version+1,
             updated_at=transaction_timestamp()",
    )
    .execute(&mut *pool.acquire().await.unwrap())
    .await;
    assert!(
        smtp_enable.is_err(),
        "limited recovery must block SMTP activation"
    );
}

async fn postgres_major(pool: &DatabasePool) -> i32 {
    let version: String = sqlx::query_scalar("SHOW server_version_num")
        .fetch_one(&mut *pool.acquire().await.unwrap())
        .await
        .unwrap();
    version.parse::<i32>().unwrap() / 10_000
}

fn required_path(name: &str) -> PathBuf {
    let path = PathBuf::from(env::var(name).unwrap());
    assert!(path.is_absolute());
    path
}
