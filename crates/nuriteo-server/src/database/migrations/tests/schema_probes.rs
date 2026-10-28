#![allow(unused_imports)]
use super::access_tokens::*;
use super::forward_migrations::*;
use super::*;
use std::borrow::Cow;

use std::env;

use std::fs;

use std::str::FromStr;

use sqlx::migrate::{Migration, MigrationType};

use sqlx::{Acquire, SqlSafeStr};

use super::super::*;

use crate::database::{DatabasePoolConfig, DatabaseTlsConfig};

use crate::identity::UserId;

use crate::project::ProjectId;

use crate::published_example::{
    CreatePublishedExample, PublishedExampleDeleteConfirmation, PublishedExampleError,
    PublishedExampleName, PublishedExampleService, PublishedExampleServicePolicy,
    PublishedExampleState, PublishedExampleVisibility,
};

use super::{DATABASE_CA_ENV, DATABASE_URL_ENV, TEST_MIGRATION_VERSION, TIMEOUT_MIGRATION_VERSION};
use crate::save::ProjectVersionId;

pub(crate) async fn column_exists(pool: &DatabasePool, relation: &str, column: &str) -> bool {
    let mut connection = pool
        .acquire()
        .await
        .unwrap_or_else(|error| panic!("column query must acquire a connection: {error}"));
    sqlx::query_scalar(
        "SELECT EXISTS (\
             SELECT 1 FROM information_schema.columns \
             WHERE table_schema = 'public' AND table_name = $1 AND column_name = $2\
         )",
    )
    .bind(relation)
    .bind(column)
    .fetch_one(&mut *connection)
    .await
    .unwrap_or_else(|error| panic!("column query must succeed: {error}"))
}

pub(crate) async fn constraint_exists(pool: &DatabasePool, constraint: &str) -> bool {
    sqlx::query_scalar("SELECT EXISTS (SELECT 1 FROM pg_constraint WHERE conname = $1)")
        .bind(constraint)
        .fetch_one(&mut *pool.acquire().await.unwrap())
        .await
        .unwrap()
}

pub(crate) async fn drop_transaction_probe(pool: &DatabasePool) {
    let mut connection = pool
        .acquire()
        .await
        .unwrap_or_else(|error| panic!("cleanup must acquire a connection: {error}"));
    sqlx::query("DROP TABLE IF EXISTS db002_transaction_probe")
        .execute(&mut *connection)
        .await
        .unwrap_or_else(|error| panic!("probe table cleanup must succeed: {error}"));
}

pub(crate) async fn insert_unknown_history(pool: &DatabasePool, version: i64) {
    let mut connection = pool
        .acquire()
        .await
        .unwrap_or_else(|error| panic!("history insert must acquire a connection: {error}"));
    sqlx::query(
        "INSERT INTO _sqlx_migrations \
         (version, description, success, checksum, execution_time) \
         VALUES ($1, 'unknown fixture', TRUE, $2, 0)",
    )
    .bind(version)
    .bind(vec![0_u8; 48])
    .execute(&mut *connection)
    .await
    .unwrap_or_else(|error| panic!("unknown history insert must succeed: {error}"));
}

pub(crate) async fn delete_history(pool: &DatabasePool, version: i64) {
    let mut connection = pool
        .acquire()
        .await
        .unwrap_or_else(|error| panic!("history cleanup must acquire a connection: {error}"));
    sqlx::query("DELETE FROM _sqlx_migrations WHERE version = $1")
        .bind(version)
        .execute(&mut *connection)
        .await
        .unwrap_or_else(|error| panic!("history cleanup must succeed: {error}"));
}
