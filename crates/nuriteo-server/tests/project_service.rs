#![expect(
    unused_imports,
    reason = "imports are repeated for the split test modules"
)]
use std::env;

use std::fs;

use std::time::Duration;

use nuriteo_server::audit::AuditEventId;

use nuriteo_server::database::{
    DatabasePool, DatabasePoolConfig, DatabaseTlsConfig, MigrationOptions, run_embedded_migrations,
};

use nuriteo_server::identity::UserId;

use nuriteo_server::organization::OrganizationId;

use nuriteo_server::project::{
    EffectiveProjectRole, ProjectAccessError, ProjectAccessRepository, ProjectAuditContext,
    ProjectDeleteConfirmation, ProjectId, ProjectName, ProjectOwner, ProjectPageLimit,
    ProjectRepository, ProjectRepositoryError, ProjectRole, ProjectRoleMutationResult,
    ProjectRolePageLimit, ProjectService, ProjectServiceError, ProjectServicePolicy, ProjectSlug,
    ProjectState, ProjectTemplate, ProjectVersion,
};

use sqlx::{Acquire, Executor, Postgres, Transaction};

use tokio::time as tokio_time;

const DATABASE_URL_ENV: &str = "NURITEO_TEST_DATABASE_URL";

const DATABASE_CA_ENV: &str = "NURITEO_TEST_DATABASE_CA";

const OWNER: &str = "0199ee6c-c777-7000-8000-000000006001";

const MEMBER: &str = "0199ee6c-c777-7000-8000-000000006002";

const MEMBER_TWO: &str = "0199ee6c-c777-7000-8000-000000006003";

const OUTSIDER: &str = "0199ee6c-c777-7000-8000-000000006004";

const DISABLED: &str = "0199ee6c-c777-7000-8000-000000006005";

const ORGANIZATION: &str = "0199ee6c-c777-7000-8000-000000006010";

const PERSONAL_SCOPE: &str = "0199ee6c-c777-7000-8000-000000006020";

const ORGANIZATION_SCOPE: &str = "0199ee6c-c777-7000-8000-000000006021";

#[path = "project_service/atomicity.rs"]
mod atomicity;
pub(crate) use atomicity::*;
#[path = "project_service/races.rs"]
mod races;
pub(crate) use races::*;
