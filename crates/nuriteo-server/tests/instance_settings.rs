use std::collections::BTreeMap;
use std::env;
use std::ffi::OsString;
use std::fs;
use std::io;
use std::path::Path;
use std::time::Duration;

use nuriteo_server::config::{
    BootstrapSettingOrigin, Config, Environment, FileReader, INSTANCE_SETTING_DEFINITIONS,
    INSTANCE_SETTING_REGISTRY_VERSION, InstanceSettingBootstrap,
};
use nuriteo_server::database::{
    DatabasePool, DatabasePoolConfig, DatabaseTlsConfig, MigrationOptions, run_embedded_migrations,
};
use nuriteo_server::instance_settings::{
    InstanceSettingsError, InstanceSettingsRepository, PersistedBootstrapOrigin,
};
use serde_json::{Value, json};
use sqlx::Executor;

const DATABASE_URL_ENV: &str = "NURITEO_TEST_DATABASE_URL";
const DATABASE_CA_ENV: &str = "NURITEO_TEST_DATABASE_CA";

#[tokio::test]
#[ignore = "requires the pinned PostgreSQL TLS fixture; run tests/fixtures/postgres-instance-settings/run.sh"]
async fn instance_settings_are_materialized_once_validated_and_database_authoritative() {
    let pool = fixture_pool().await;
    reset_fixture(&pool).await;
    let report = run_embedded_migrations(
        &pool,
        MigrationOptions::new(Duration::from_secs(5), Duration::from_secs(30)).unwrap(),
    )
    .await
    .unwrap();
    assert_eq!(report.latest_version, Some(40));

    let repository = InstanceSettingsRepository::new(pool.clone(), Duration::from_secs(5)).unwrap();
    let first_bootstrap = bootstrap(14, 3, 120);
    let first = repository.materialize(&first_bootstrap).await.unwrap();
    assert_eq!(first.len(), INSTANCE_SETTING_DEFINITIONS.len());
    assert_eq!(
        first.get("security.mfa_grace_period_days").unwrap().value(),
        &json!(3)
    );
    assert_eq!(
        first
            .get("security.mfa_grace_period_days")
            .unwrap()
            .bootstrap_origin(),
        PersistedBootstrapOrigin::Environment
    );
    assert_eq!(
        first.get("tokens.default_expiry_days").unwrap().value(),
        &json!(120)
    );
    assert_eq!(
        first
            .get("tokens.default_expiry_days")
            .unwrap()
            .bootstrap_origin(),
        PersistedBootstrapOrigin::File
    );
    assert_eq!(
        first
            .get("audit.retention_days")
            .unwrap()
            .bootstrap_origin(),
        PersistedBootstrapOrigin::Default
    );

    let changed_bootstrap = bootstrap(21, 5, 180);
    let database_wins = repository.materialize(&changed_bootstrap).await.unwrap();
    assert_eq!(database_wins, first);
    assert_eq!(repository.load().await.unwrap(), first);

    verify_v1_registry_upgrade(&pool).await;
    verify_exact_v2_registry_upgrade(&pool).await;
    verify_database_precedes_invalid_bootstrap(&pool).await;
    verify_concurrent_first_materialization_is_not_mixed(&pool).await;
    verify_corruption_fails_closed(&pool).await;
    verify_database_constraints(&pool).await;

    reset_fixture(&pool).await;
    pool.close(Duration::from_secs(2)).await.unwrap();
}

async fn verify_database_precedes_invalid_bootstrap(pool: &DatabasePool) {
    let repository = InstanceSettingsRepository::new(pool.clone(), Duration::from_secs(5)).unwrap();
    let report = Config::load(
        &FixtureEnvironment(vec![
            (
                OsString::from("NURITEO_EXTERNAL_URL"),
                OsString::from("https://nuriteo.example.test"),
            ),
            (
                OsString::from("NURITEO_MFA_GRACE_PERIOD_DAYS"),
                OsString::from("must-not-appear"),
            ),
        ]),
        &NoFiles,
    )
    .unwrap();
    assert!(
        repository
            .materialize(&report.instance_settings)
            .await
            .is_ok()
    );

    sqlx::query("TRUNCATE instance_settings")
        .execute(&mut *acquire(pool).await)
        .await
        .unwrap();
    assert_eq!(
        repository.materialize(&report.instance_settings).await,
        Err(InstanceSettingsError::InvalidPersistedValue)
    );
    repository
        .materialize(&InstanceSettingBootstrap::empty())
        .await
        .unwrap();
}

async fn verify_v1_registry_upgrade(pool: &DatabasePool) {
    for definition in INSTANCE_SETTING_DEFINITIONS
        .iter()
        .filter(|definition| definition.introduced_in > 1)
    {
        sqlx::query("DELETE FROM instance_settings WHERE key = $1")
            .bind(definition.key)
            .execute(&mut *acquire(pool).await)
            .await
            .unwrap();
    }
    sqlx::query("UPDATE instance_settings SET registry_version = 1")
        .execute(&mut *acquire(pool).await)
        .await
        .unwrap();
    let repository = InstanceSettingsRepository::new(pool.clone(), Duration::from_secs(5)).unwrap();
    let upgraded = repository
        .materialize(&InstanceSettingBootstrap::empty())
        .await
        .unwrap();
    assert_eq!(
        upgraded.registry_version(),
        INSTANCE_SETTING_REGISTRY_VERSION
    );
    assert_eq!(upgraded.get("smtp.enabled").unwrap().value(), &json!(false));
    assert_eq!(
        upgraded.get("smtp.host").unwrap().bootstrap_origin(),
        PersistedBootstrapOrigin::Default
    );
    assert_eq!(
        upgraded
            .get("sessions.absolute_timeout_minutes")
            .unwrap()
            .value(),
        &json!(43_200)
    );
    assert_eq!(
        nuriteo_server::smtp::SmtpPublicSettings::from_effective(&upgraded).unwrap(),
        None
    );
    sqlx::query("UPDATE instance_settings SET value = 'true'::jsonb WHERE key = 'smtp.enabled'")
        .execute(&mut *acquire(pool).await)
        .await
        .unwrap();
    let enabled = repository.load().await.unwrap();
    let public = nuriteo_server::smtp::SmtpPublicSettings::from_effective(&enabled)
        .unwrap()
        .unwrap();
    assert!(format!("{public:?}").contains("localhost"));
}

async fn verify_exact_v2_registry_upgrade(pool: &DatabasePool) {
    sqlx::query(
        "UPDATE instance_settings SET value = '444'::jsonb \
         WHERE key = 'invitations.default_expiry_hours'",
    )
    .execute(&mut *acquire(pool).await)
    .await
    .unwrap();
    for definition in INSTANCE_SETTING_DEFINITIONS
        .iter()
        .filter(|definition| definition.introduced_in > 2)
    {
        sqlx::query("DELETE FROM instance_settings WHERE key = $1")
            .bind(definition.key)
            .execute(&mut *acquire(pool).await)
            .await
            .unwrap();
    }
    sqlx::query("UPDATE instance_settings SET registry_version = 2")
        .execute(&mut *acquire(pool).await)
        .await
        .unwrap();

    let repository = InstanceSettingsRepository::new(pool.clone(), Duration::from_secs(5)).unwrap();
    let upgraded = repository
        .materialize(&InstanceSettingBootstrap::empty())
        .await
        .unwrap();
    assert_eq!(
        upgraded
            .get("invitations.default_expiry_hours")
            .unwrap()
            .value(),
        &json!(444)
    );
    assert_eq!(
        upgraded
            .get("workspace.personal_default_quota_bytes")
            .unwrap()
            .value(),
        &Value::Null
    );
    assert_eq!(
        upgraded
            .get("workspace.personal_default_quota_bytes")
            .unwrap()
            .bootstrap_origin(),
        PersistedBootstrapOrigin::Default
    );
}

struct FixtureEnvironment(Vec<(OsString, OsString)>);

impl Environment for FixtureEnvironment {
    fn entries(&self) -> Vec<(OsString, OsString)> {
        self.0.clone()
    }
}

struct NoFiles;

impl FileReader for NoFiles {
    fn read(&self, _path: &Path, _limit: usize) -> io::Result<Vec<u8>> {
        Err(io::Error::new(
            io::ErrorKind::NotFound,
            "fixture has no files",
        ))
    }
}

fn bootstrap(file_grace: u64, environment_grace: u64, token_days: u64) -> InstanceSettingBootstrap {
    let bootstrap = InstanceSettingBootstrap::new(
        BTreeMap::from([
            (
                "security.mfa_grace_period_days".to_owned(),
                json!(file_grace),
            ),
            ("tokens.default_expiry_days".to_owned(), json!(token_days)),
        ]),
        BTreeMap::from([(
            "security.mfa_grace_period_days".to_owned(),
            json!(environment_grace),
        )]),
    )
    .unwrap();
    assert_eq!(
        bootstrap
            .resolve(
                nuriteo_server::config::instance_setting_definition(
                    "security.mfa_grace_period_days",
                )
                .unwrap(),
            )
            .unwrap()
            .1,
        BootstrapSettingOrigin::Environment
    );
    bootstrap
}

async fn verify_concurrent_first_materialization_is_not_mixed(pool: &DatabasePool) {
    sqlx::query("TRUNCATE instance_settings")
        .execute(&mut *acquire(pool).await)
        .await
        .unwrap();
    let first_repository =
        InstanceSettingsRepository::new(pool.clone(), Duration::from_secs(5)).unwrap();
    let second_repository =
        InstanceSettingsRepository::new(pool.clone(), Duration::from_secs(5)).unwrap();
    let first_bootstrap = bootstrap(4, 4, 40);
    let second_bootstrap = bootstrap(8, 8, 80);

    let (first, second) = tokio::join!(
        first_repository.materialize(&first_bootstrap),
        second_repository.materialize(&second_bootstrap)
    );
    let first = first.unwrap();
    let second = second.unwrap();
    assert_eq!(first, second);
    let grace = first.get("security.mfa_grace_period_days").unwrap().value();
    let token = first.get("tokens.default_expiry_days").unwrap().value();
    assert!(
        (grace == &json!(4) && token == &json!(40)) || (grace == &json!(8) && token == &json!(80))
    );
}

async fn verify_corruption_fails_closed(pool: &DatabasePool) {
    let repository = InstanceSettingsRepository::new(pool.clone(), Duration::from_secs(5)).unwrap();

    sqlx::query("DELETE FROM instance_settings WHERE key = 'tokens.default_expiry_days'")
        .execute(&mut *acquire(pool).await)
        .await
        .unwrap();
    assert_eq!(
        repository.load().await,
        Err(InstanceSettingsError::IncompletePersistedSet)
    );

    sqlx::query(
        "INSERT INTO instance_settings \
         (key, registry_version, value, bootstrap_origin) \
         VALUES ('security.unknown', 1, 'true'::jsonb, 'default')",
    )
    .execute(&mut *acquire(pool).await)
    .await
    .unwrap();
    assert_eq!(
        repository.load().await,
        Err(InstanceSettingsError::UnknownPersistedKey)
    );

    sqlx::query("DELETE FROM instance_settings WHERE key = 'security.unknown'")
        .execute(&mut *acquire(pool).await)
        .await
        .unwrap();
    sqlx::query(
        "INSERT INTO instance_settings \
         (key, registry_version, value, bootstrap_origin) \
         VALUES ('tokens.default_expiry_days', 3, '90'::jsonb, 'default')",
    )
    .execute(&mut *acquire(pool).await)
    .await
    .unwrap();
    sqlx::query(
        "UPDATE instance_settings SET value = '999'::jsonb \
         WHERE key = 'tokens.default_expiry_days'",
    )
    .execute(&mut *acquire(pool).await)
    .await
    .unwrap();
    assert_eq!(
        repository.load().await,
        Err(InstanceSettingsError::InvalidPersistedValue)
    );

    sqlx::query(
        "UPDATE instance_settings SET value = '365'::jsonb \
         WHERE key = 'tokens.default_expiry_days'",
    )
    .execute(&mut *acquire(pool).await)
    .await
    .unwrap();
    sqlx::query(
        "UPDATE instance_settings SET value = '30'::jsonb \
         WHERE key = 'tokens.maximum_expiry_days'",
    )
    .execute(&mut *acquire(pool).await)
    .await
    .unwrap();
    assert_eq!(
        repository.load().await,
        Err(InstanceSettingsError::InvalidPersistedValue)
    );

    sqlx::query(
        "UPDATE instance_settings SET value = '90'::jsonb, registry_version = 4 \
         WHERE key = 'tokens.default_expiry_days'",
    )
    .execute(&mut *acquire(pool).await)
    .await
    .unwrap();
    assert_eq!(
        repository.load().await,
        Err(InstanceSettingsError::UnsupportedRegistryVersion)
    );
}

async fn verify_database_constraints(pool: &DatabasePool) {
    for statement in [
        "UPDATE instance_settings SET lock_version = 0 WHERE key = 'audit.retention_days'",
        "UPDATE instance_settings SET bootstrap_origin = 'secret' WHERE key = 'audit.retention_days'",
        "UPDATE instance_settings SET updated_at = created_at - INTERVAL '1 second' WHERE key = 'audit.retention_days'",
    ] {
        assert!(
            sqlx::query(statement)
                .execute(&mut *acquire(pool).await)
                .await
                .is_err()
        );
    }
}

async fn fixture_pool() -> DatabasePool {
    let database_url = env::var(DATABASE_URL_ENV).unwrap();
    let ca = fs::read(env::var(DATABASE_CA_ENV).unwrap()).unwrap();
    let tls = DatabaseTlsConfig::verify_full(None, Some(ca), None).unwrap();
    let config = DatabasePoolConfig::new(
        database_url,
        1,
        8,
        Duration::from_secs(5),
        Duration::from_secs(2),
        tls,
    )
    .unwrap();
    DatabasePool::connect(config).await.unwrap()
}

async fn reset_fixture(pool: &DatabasePool) {
    let mut connection = acquire(pool).await;
    connection
        .execute("DROP SCHEMA public CASCADE")
        .await
        .unwrap();
    connection.execute("CREATE SCHEMA public").await.unwrap();
}

async fn acquire(pool: &DatabasePool) -> sqlx::pool::PoolConnection<sqlx::Postgres> {
    pool.acquire().await.unwrap()
}
