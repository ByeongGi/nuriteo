use std::env;

use std::fs;

use std::str::FromStr;

use std::time::Duration;


use nuriteo_server::database::{
    DatabasePool, DatabasePoolConfig, DatabaseTlsConfig, MigrationOptions, run_embedded_migrations,
};

use nuriteo_server::identity::{Timestamp, UserId};

use nuriteo_server::project::{
    EffectiveProjectRole, ProjectAccessError, ProjectAccessRepository, ProjectId, ProjectRole,
};

use sqlx::{Acquire, Executor, Postgres, Transaction};

use tokio::sync::oneshot;

use tokio::time;


const DATABASE_URL_ENV: &str = "NURITEO_TEST_DATABASE_URL";

const DATABASE_CA_ENV: &str = "NURITEO_TEST_DATABASE_CA";

const OWNER: &str = "0199ee6c-c777-7000-8000-000000005001";

const MEMBER: &str = "0199ee6c-c777-7000-8000-000000005002";

const UNGRANTED: &str = "0199ee6c-c777-7000-8000-000000005003";

const OUTSIDER: &str = "0199ee6c-c777-7000-8000-000000005004";

const DISABLED: &str = "0199ee6c-c777-7000-8000-000000005005";

const ORGANIZATION: &str = "0199ee6c-c777-7000-8000-000000005010";

const PERSONAL_SCOPE: &str = "0199ee6c-c777-7000-8000-000000005020";

const ORGANIZATION_SCOPE: &str = "0199ee6c-c777-7000-8000-000000005021";

const PERSONAL_PROJECT: &str = "0199ee6c-c777-7000-8000-000000005030";

const ARCHIVED_PERSONAL_PROJECT: &str = "0199ee6c-c777-7000-8000-000000005031";

const ORGANIZATION_PROJECT: &str = "0199ee6c-c777-7000-8000-000000005032";

const ARCHIVED_ORGANIZATION_PROJECT: &str = "0199ee6c-c777-7000-8000-000000005033";

const DELETION_PROJECT: &str = "0199ee6c-c777-7000-8000-000000005034";

const CONCURRENT_DELETE_PROJECT: &str = "0199ee6c-c777-7000-8000-000000005035";

const READ_TEAM: &str = "0199ee6c-c777-7000-8000-000000005060";

const WRITE_TEAM: &str = "0199ee6c-c777-7000-8000-000000005061";

const ADMIN_TEAM: &str = "0199ee6c-c777-7000-8000-000000005062";

#[path = "project_access/roles.rs"]
mod roles;
pub(crate) use roles::*;
#[path = "project_access/races.rs"]
mod races;
pub(crate) use races::*;
