#![expect(
    unused_imports,
    reason = "imports are repeated for the split test modules"
)]
use std::env;

use std::fs;

use std::time::Duration;

use nuriteo_server::database::{
    DatabasePool, DatabasePoolConfig, DatabaseTlsConfig, MigrationOptions, MigrationReport,
    SchemaReadiness, check_schema_readiness, run_embedded_migrations,
};

use sqlx::{Acquire, Executor};

use tokio::time;

const DATABASE_URL_ENV: &str = "NURITEO_TEST_DATABASE_URL";

const DATABASE_CA_ENV: &str = "NURITEO_TEST_DATABASE_CA";

#[path = "project_bundle_schema/working_head.rs"]
mod working_head;
pub(crate) use working_head::*;
#[path = "project_bundle_schema/constraints.rs"]
mod constraints;
pub(crate) use constraints::*;
#[path = "project_bundle_schema/postgres.rs"]
mod postgres;
pub(crate) use postgres::*;
