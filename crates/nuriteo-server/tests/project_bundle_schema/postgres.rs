#![allow(unused_imports)]
use super::constraints::*;
use super::working_head::*;
use super::*;
use std::env;

use std::fs;

use std::time::Duration;

use nuriteo_server::database::{
    DatabasePool, DatabasePoolConfig, DatabaseTlsConfig, MigrationOptions, MigrationReport,
    SchemaReadiness, check_schema_readiness, run_embedded_migrations,
};

use sqlx::{Acquire, Executor};

use super::{DATABASE_CA_ENV, DATABASE_URL_ENV};
use tokio::time;

pub(crate) async fn wait_for_database_block(
    pool: &DatabasePool,
    holder_pid: i32,
    contender_pid: i32,
) -> bool {
    let deadline = time::Instant::now() + Duration::from_secs(2);
    let mut observer = pool.acquire().await.unwrap();
    loop {
        let remaining = deadline.saturating_duration_since(time::Instant::now());
        if remaining.is_zero() {
            return false;
        }
        let observation = time::timeout(
            remaining,
            sqlx::query_scalar::<_, bool>(
                "SELECT $1::integer = ANY(pg_blocking_pids($2::integer))",
            )
            .bind(holder_pid)
            .bind(contender_pid)
            .fetch_one(&mut *observer),
        )
        .await;
        let Ok(Ok(blocked)) = observation else {
            return false;
        };
        if blocked {
            return true;
        }
        time::sleep(Duration::from_millis(25)).await;
    }
}

pub(crate) async fn execute(pool: &DatabasePool, statement: &'static str) {
    sqlx::query(statement)
        .execute(&mut *pool.acquire().await.unwrap())
        .await
        .unwrap_or_else(|error| panic!("fixture statement failed: {statement}\n{error}"));
}

pub(crate) async fn migrate(pool: &DatabasePool) -> MigrationReport {
    run_embedded_migrations(
        pool,
        MigrationOptions::new(Duration::from_secs(5), Duration::from_secs(30)).unwrap(),
    )
    .await
    .unwrap()
}

pub(crate) async fn reset_fixture(pool: &DatabasePool) {
    let mut connection = pool.acquire().await.unwrap();
    connection
        .execute("DROP SCHEMA public CASCADE")
        .await
        .unwrap();
    connection.execute("CREATE SCHEMA public").await.unwrap();
}

pub(crate) async fn fixture_pool() -> DatabasePool {
    let database_url = env::var(DATABASE_URL_ENV).unwrap();
    let ca = fs::read(env::var(DATABASE_CA_ENV).unwrap()).unwrap();
    let tls = DatabaseTlsConfig::verify_full(None, Some(ca), None).unwrap();
    DatabasePool::connect(
        DatabasePoolConfig::new(
            database_url,
            0,
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
