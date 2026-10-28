use std::borrow::Cow;

use std::env;

use std::fs;

use std::str::FromStr;


use sqlx::migrate::{Migration, MigrationType};

use sqlx::{Acquire, SqlSafeStr};


use super::*;

use crate::database::{DatabasePoolConfig, DatabaseTlsConfig};

use crate::identity::UserId;

use crate::project::ProjectId;

use crate::published_example::{
    CreatePublishedExample, PublishedExampleDeleteConfirmation, PublishedExampleError,
    PublishedExampleName, PublishedExampleService, PublishedExampleServicePolicy,
    PublishedExampleState, PublishedExampleVisibility,
};

use crate::save::ProjectVersionId;


const DATABASE_URL_ENV: &str = "NURITEO_TEST_DATABASE_URL";

const DATABASE_CA_ENV: &str = "NURITEO_TEST_DATABASE_CA";

const TEST_MIGRATION_VERSION: i64 = 9_001;

const TIMEOUT_MIGRATION_VERSION: i64 = 9_002;

mod forward_migrations;
pub(crate) use forward_migrations::*;
mod access_tokens;
pub(crate) use access_tokens::*;
mod schema_probes;
pub(crate) use schema_probes::*;
