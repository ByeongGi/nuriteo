use std::fmt;
use std::str::FromStr;
use std::time::Duration;

use ::time::OffsetDateTime;
use sha2::{Digest, Sha256};
use sqlx::{Acquire, Postgres, Transaction};
use tokio::time::{self, Instant};
use unicode_normalization::UnicodeNormalization;
use uuid::{Uuid, Variant, Version};

use crate::database::{DatabaseError, DatabasePool};
use crate::identity::{Timestamp, UserId};
use crate::project::{
    EffectiveProjectRole, ProjectAccessError, ProjectAccessRepository, ProjectId, ProjectOwner,
    ProjectVersion,
};
use crate::quota::QuotaRepository;
use crate::save::IdempotencyKey;
use crate::workspace::StorageScopeId;

const MIN_TIMEOUT: Duration = Duration::from_millis(100);
const MAX_TIMEOUT: Duration = Duration::from_secs(30);
const SQL_MARGIN: Duration = Duration::from_millis(25);
pub const DEFAULT_PROJECT_VERSION_PAGE_SIZE: u16 = 50;
pub const MAX_PROJECT_VERSION_PAGE_SIZE: u16 = 100;

#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub struct ProjectVersionServicePolicy {
    operation_timeout: Duration,
}

impl ProjectVersionServicePolicy {
    pub fn new(operation_timeout: Duration) -> Result<Self, ProjectVersionError> {
        if !(MIN_TIMEOUT..=MAX_TIMEOUT).contains(&operation_timeout) {
            return Err(ProjectVersionError::InvalidInput);
        }
        Ok(Self { operation_timeout })
    }
}

impl Default for ProjectVersionServicePolicy {
    fn default() -> Self {
        Self {
            operation_timeout: Duration::from_secs(5),
        }
    }
}

#[derive(Clone, Copy, PartialEq, Eq, PartialOrd, Ord, Hash)]
pub struct ProjectVersionId(Uuid);

impl ProjectVersionId {
    #[must_use]
    pub fn new() -> Self {
        Self(Uuid::now_v7())
    }

    pub fn from_uuid(value: Uuid) -> Result<Self, ProjectVersionError> {
        if value.is_nil()
            || value.get_version() != Some(Version::SortRand)
            || value.get_variant() != Variant::RFC4122
        {
            return Err(ProjectVersionError::InvalidInput);
        }
        Ok(Self(value))
    }
}

impl Default for ProjectVersionId {
    fn default() -> Self {
        Self::new()
    }
}

impl fmt::Debug for ProjectVersionId {
    fn fmt(&self, formatter: &mut fmt::Formatter<'_>) -> fmt::Result {
        formatter
            .debug_tuple("ProjectVersionId")
            .field(&self.0)
            .finish()
    }
}

impl fmt::Display for ProjectVersionId {
    fn fmt(&self, formatter: &mut fmt::Formatter<'_>) -> fmt::Result {
        self.0.fmt(formatter)
    }
}

impl FromStr for ProjectVersionId {
    type Err = ProjectVersionError;

    fn from_str(value: &str) -> Result<Self, Self::Err> {
        Uuid::parse_str(value)
            .map_err(|_| ProjectVersionError::InvalidInput)
            .and_then(Self::from_uuid)
    }
}

#[derive(Clone, Debug, PartialEq, Eq)]
pub struct ProjectVersionName(String);

impl ProjectVersionName {
    pub fn new(value: String) -> Result<Self, ProjectVersionError> {
        if value != value.nfc().collect::<String>()
            || value != value.trim()
            || !(1..=200).contains(&value.chars().count())
            || value.chars().any(char::is_control)
        {
            return Err(ProjectVersionError::InvalidInput);
        }
        Ok(Self(value))
    }

    #[must_use]
    pub fn as_str(&self) -> &str {
        &self.0
    }
}

#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub struct ProjectVersionPageLimit(u16);

impl ProjectVersionPageLimit {
    pub fn new(value: u16) -> Result<Self, ProjectVersionError> {
        if !(1..=MAX_PROJECT_VERSION_PAGE_SIZE).contains(&value) {
            return Err(ProjectVersionError::InvalidInput);
        }
        Ok(Self(value))
    }

    #[must_use]
    pub const fn get(self) -> u16 {
        self.0
    }
}

#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub struct ProjectVersionPageKey {
    created_at: OffsetDateTime,
    id: ProjectVersionId,
}

impl ProjectVersionPageKey {
    #[must_use]
    pub const fn new(created_at: OffsetDateTime, id: ProjectVersionId) -> Self {
        Self { created_at, id }
    }

    #[must_use]
    pub const fn created_at(self) -> OffsetDateTime {
        self.created_at
    }

    #[must_use]
    pub const fn id(self) -> ProjectVersionId {
        self.id
    }
}

#[derive(Clone, Debug, PartialEq, Eq)]
pub struct ExplicitProjectVersion {
    id: ProjectVersionId,
    project_id: ProjectId,
    bundle_id: Uuid,
    name: ProjectVersionName,
    actor_user_id: UserId,
    source_project_version: ProjectVersion,
    created_at: Timestamp,
    sha256: [u8; 32],
    physical_bytes: u64,
    logical_bytes: u64,
    file_count: u32,
    format: String,
}

impl ExplicitProjectVersion {
    #[must_use]
    pub const fn id(&self) -> ProjectVersionId {
        self.id
    }
    #[must_use]
    pub const fn project_id(&self) -> ProjectId {
        self.project_id
    }
    #[must_use]
    pub const fn bundle_id(&self) -> Uuid {
        self.bundle_id
    }
    #[must_use]
    pub fn name(&self) -> &ProjectVersionName {
        &self.name
    }
    #[must_use]
    pub const fn actor_user_id(&self) -> UserId {
        self.actor_user_id
    }
    #[must_use]
    pub const fn source_project_version(&self) -> ProjectVersion {
        self.source_project_version
    }
    #[must_use]
    pub const fn created_at(&self) -> Timestamp {
        self.created_at
    }
    #[must_use]
    pub const fn sha256(&self) -> &[u8; 32] {
        &self.sha256
    }
    #[must_use]
    pub const fn physical_bytes(&self) -> u64 {
        self.physical_bytes
    }
    #[must_use]
    pub const fn logical_bytes(&self) -> u64 {
        self.logical_bytes
    }
    #[must_use]
    pub const fn file_count(&self) -> u32 {
        self.file_count
    }
    #[must_use]
    pub fn format(&self) -> &str {
        &self.format
    }
}

#[derive(Clone, Debug, PartialEq, Eq)]
pub struct CreateProjectVersion {
    pub owner: ProjectOwner,
    pub project_id: ProjectId,
    pub actor_user_id: UserId,
    pub expected_project_version: ProjectVersion,
    pub name: ProjectVersionName,
    pub idempotency_key: IdempotencyKey,
}

#[derive(Clone, Debug, PartialEq, Eq)]
pub struct CreateProjectVersionOutcome {
    version: ExplicitProjectVersion,
    idempotent_retry: bool,
}

impl CreateProjectVersionOutcome {
    #[must_use]
    pub fn version(&self) -> &ExplicitProjectVersion {
        &self.version
    }
    #[must_use]
    pub const fn is_idempotent_retry(&self) -> bool {
        self.idempotent_retry
    }
}

#[derive(Clone, Debug, PartialEq, Eq)]
pub struct ProjectVersionPage {
    versions: Vec<ExplicitProjectVersion>,
    next_key: Option<ProjectVersionPageKey>,
}

impl ProjectVersionPage {
    #[must_use]
    pub fn versions(&self) -> &[ExplicitProjectVersion] {
        &self.versions
    }
    #[must_use]
    pub const fn next_key(&self) -> Option<ProjectVersionPageKey> {
        self.next_key
    }
}

#[derive(Clone, Copy, Debug, PartialEq, Eq)]
#[non_exhaustive]
pub enum ProjectVersionError {
    InvalidInput,
    NotFound,
    Forbidden,
    ProjectUnavailable,
    StaleProjectVersion,
    WorkingHeadUnavailable,
    IdempotencyConflict,
    NameConflict,
    OperationTimeout,
    DatabaseUnavailable,
    CommitOutcomeUnknown,
    InvariantViolation,
}

impl fmt::Display for ProjectVersionError {
    fn fmt(&self, formatter: &mut fmt::Formatter<'_>) -> fmt::Result {
        formatter.write_str(match self {
            Self::InvalidInput => "Project Version input is invalid",
            Self::NotFound => "Project was not found",
            Self::Forbidden => "Project Version request is forbidden",
            Self::ProjectUnavailable => "Project cannot create Versions in its current state",
            Self::StaleProjectVersion => "project version is stale",
            Self::WorkingHeadUnavailable => "Project has no available Working Head",
            Self::IdempotencyConflict => "idempotency key conflicts with another Version request",
            Self::NameConflict => "Project Version name already exists",
            Self::OperationTimeout => "Project Version operation timed out",
            Self::DatabaseUnavailable => "Project Version persistence is unavailable",
            Self::CommitOutcomeUnknown => "Project Version commit outcome is unknown",
            Self::InvariantViolation => "Project Version persistence state is invalid",
        })
    }
}

impl std::error::Error for ProjectVersionError {}

#[derive(Clone, Debug)]
pub struct ProjectVersionService {
    pool: DatabasePool,
    policy: ProjectVersionServicePolicy,
}

impl ProjectVersionService {
    #[must_use]
    pub const fn new(pool: DatabasePool, policy: ProjectVersionServicePolicy) -> Self {
        Self { pool, policy }
    }

    pub async fn create(
        &self,
        request: CreateProjectVersion,
    ) -> Result<CreateProjectVersionOutcome, ProjectVersionError> {
        let deadline = Deadline::new(self.policy.operation_timeout);
        let mut connection = deadline
            .run(self.pool.acquire())
            .await?
            .map_err(map_database_error)?;
        let mut transaction = deadline
            .run(connection.begin())
            .await?
            .map_err(map_sql_error)?;
        configure(&mut transaction, deadline).await?;

        let scope = project_scope_hint(&mut transaction, request.project_id, deadline).await?;
        if !deadline
            .run(QuotaRepository::lock_storage_scope(&mut transaction, scope))
            .await?
            .map_err(map_sql_error)?
        {
            return Err(ProjectVersionError::NotFound);
        }

        let role = deadline
            .run(ProjectAccessRepository::resolve_effective_role_for_update(
                &mut transaction,
                request.project_id,
                request.actor_user_id,
            ))
            .await?
            .map_err(map_access_error)?;
        if role == EffectiveProjectRole::None {
            return Err(ProjectVersionError::NotFound);
        }
        if role < EffectiveProjectRole::Write {
            return Err(ProjectVersionError::Forbidden);
        }

        let project = load_project(&mut transaction, request.project_id, deadline).await?;
        validate_project_identity(&project, request.owner, scope)?;
        require_active_project(&project)?;
        let digest = idempotency_digest(&request);
        if let Some(version) = load_idempotent(
            &mut transaction,
            request.project_id,
            request.actor_user_id,
            &digest,
            deadline,
        )
        .await?
        {
            if version.name != request.name
                || version.source_project_version != request.expected_project_version
            {
                return Err(ProjectVersionError::IdempotencyConflict);
            }
            commit(transaction, deadline).await?;
            return Ok(CreateProjectVersionOutcome {
                version,
                idempotent_retry: true,
            });
        }
        if project.lock_version != request.expected_project_version.get() {
            return Err(ProjectVersionError::StaleProjectVersion);
        }
        let bundle_id = project
            .working_head_bundle_id
            .ok_or(ProjectVersionError::WorkingHeadUnavailable)?;
        let id = ProjectVersionId::new();
        let row = deadline
            .run(
                sqlx::query_as::<_, VersionRow>(
                    "INSERT INTO project_bundle_refs \
                     (id,project_id,storage_scope_id,bundle_id,kind,version_name,actor_user_id,\
                      idempotency_digest,source_project_version,created_at) \
                     VALUES ($1::uuid,$2::uuid,$3::uuid,$4::uuid,'version',$5,$6::uuid,$7,$8,\
                             transaction_timestamp()) \
                     RETURNING id::text,project_id::text,bundle_id::text,version_name,\
                               actor_user_id::text,source_project_version,created_at,\
                               (SELECT sha256 FROM bundles WHERE id=bundle_id),\
                               (SELECT physical_bytes FROM bundles WHERE id=bundle_id),\
                               (SELECT logical_bytes FROM bundles WHERE id=bundle_id),\
                               (SELECT file_count FROM bundles WHERE id=bundle_id),\
                               (SELECT format FROM bundles WHERE id=bundle_id)",
                )
                .bind(id.to_string())
                .bind(request.project_id.to_string())
                .bind(scope.to_string())
                .bind(bundle_id.to_string())
                .bind(request.name.as_str())
                .bind(request.actor_user_id.to_string())
                .bind(digest.as_slice())
                .bind(request.expected_project_version.get())
                .fetch_one(&mut *transaction),
            )
            .await?
            .map_err(map_insert_error)?;
        let version = decode_version(row)?;

        deadline
            .run(
                sqlx::query(
                    "DELETE FROM gc_candidates candidate USING bundles bundle \
                     WHERE bundle.id=$1::uuid AND candidate.object_key=bundle.object_key \
                       AND candidate.status IN ('queued','retry_wait','failed')",
                )
                .bind(bundle_id.to_string())
                .execute(&mut *transaction),
            )
            .await?
            .map_err(map_sql_error)?;
        commit(transaction, deadline).await?;
        Ok(CreateProjectVersionOutcome {
            version,
            idempotent_retry: false,
        })
    }

    pub async fn list(
        &self,
        actor_user_id: UserId,
        owner: ProjectOwner,
        project_id: ProjectId,
        limit: ProjectVersionPageLimit,
        after: Option<ProjectVersionPageKey>,
    ) -> Result<ProjectVersionPage, ProjectVersionError> {
        let deadline = Deadline::new(self.policy.operation_timeout);
        let mut connection = deadline
            .run(self.pool.acquire())
            .await?
            .map_err(map_database_error)?;
        let mut transaction = deadline
            .run(connection.begin())
            .await?
            .map_err(map_sql_error)?;
        configure(&mut transaction, deadline).await?;
        let role = deadline
            .run(ProjectAccessRepository::resolve_effective_role(
                &mut transaction,
                project_id,
                actor_user_id,
            ))
            .await?
            .map_err(map_access_error)?;
        if role == EffectiveProjectRole::None {
            return Err(ProjectVersionError::NotFound);
        }
        let project = load_project(&mut transaction, project_id, deadline).await?;
        validate_project_identity(&project, owner, project.storage_scope_id)?;
        if !matches!(project.state.as_str(), "active" | "archived") {
            return Err(ProjectVersionError::InvariantViolation);
        }
        let (after_time, after_id) = after
            .map(|key| (Some(key.created_at()), Some(key.id().to_string())))
            .unwrap_or((None, None));
        let rows = deadline
            .run(
                sqlx::query_as::<_, VersionRow>(
                    "SELECT reference.id::text,reference.project_id::text,reference.bundle_id::text,\
                            reference.version_name,reference.actor_user_id::text,\
                            reference.source_project_version,reference.created_at,bundle.sha256,\
                            bundle.physical_bytes,bundle.logical_bytes,bundle.file_count,bundle.format \
                     FROM project_bundle_refs reference \
                     JOIN bundles bundle ON bundle.id=reference.bundle_id \
                     WHERE reference.project_id=$1::uuid AND reference.kind='version' \
                       AND ($2::timestamptz IS NULL OR (reference.created_at,reference.id)<($2,$3::uuid)) \
                     ORDER BY reference.created_at DESC,reference.id DESC LIMIT $4",
                )
                .bind(project_id.to_string())
                .bind(after_time)
                .bind(after_id)
                .bind(i64::from(limit.get()) + 1)
                .fetch_all(&mut *transaction),
            )
            .await?
            .map_err(map_sql_error)?;
        let mut versions = rows
            .into_iter()
            .map(decode_version)
            .collect::<Result<Vec<_>, _>>()?;
        let has_more = versions.len() > usize::from(limit.get());
        versions.truncate(usize::from(limit.get()));
        let next_key = if has_more {
            let last = versions
                .last()
                .ok_or(ProjectVersionError::InvariantViolation)?;
            Some(ProjectVersionPageKey::new(
                last.created_at().into_datetime(),
                last.id(),
            ))
        } else {
            None
        };
        commit(transaction, deadline).await?;
        Ok(ProjectVersionPage { versions, next_key })
    }
}

#[derive(Debug)]
struct ProjectRow {
    state: String,
    lock_version: i64,
    storage_scope_id: StorageScopeId,
    owner_user_id: Option<String>,
    owner_organization_id: Option<String>,
    working_head_bundle_id: Option<Uuid>,
}

type VersionRow = (
    String,
    String,
    String,
    String,
    String,
    i64,
    OffsetDateTime,
    Vec<u8>,
    i64,
    i64,
    i32,
    String,
);

async fn project_scope_hint(
    transaction: &mut Transaction<'_, Postgres>,
    project_id: ProjectId,
    deadline: Deadline,
) -> Result<StorageScopeId, ProjectVersionError> {
    let value: Option<String> = deadline
        .run(
            sqlx::query_scalar("SELECT storage_scope_id::text FROM projects WHERE id=$1::uuid")
                .bind(project_id.to_string())
                .fetch_optional(&mut **transaction),
        )
        .await?
        .map_err(map_sql_error)?;
    value
        .ok_or(ProjectVersionError::NotFound)?
        .parse()
        .map_err(|_| ProjectVersionError::InvariantViolation)
}

async fn load_project(
    transaction: &mut Transaction<'_, Postgres>,
    project_id: ProjectId,
    deadline: Deadline,
) -> Result<ProjectRow, ProjectVersionError> {
    type Row = (
        String,
        i64,
        String,
        Option<String>,
        Option<String>,
        Option<String>,
    );
    let row: Option<Row> = deadline
        .run(
            sqlx::query_as(
                "SELECT state,lock_version,storage_scope_id::text,owner_user_id::text,\
                        owner_organization_id::text,working_head_bundle_id::text \
                 FROM projects WHERE id=$1::uuid",
            )
            .bind(project_id.to_string())
            .fetch_optional(&mut **transaction),
        )
        .await?
        .map_err(map_sql_error)?;
    let Some(row) = row else {
        return Err(ProjectVersionError::NotFound);
    };
    Ok(ProjectRow {
        state: row.0,
        lock_version: row.1,
        storage_scope_id: row
            .2
            .parse()
            .map_err(|_| ProjectVersionError::InvariantViolation)?,
        owner_user_id: row.3,
        owner_organization_id: row.4,
        working_head_bundle_id: row
            .5
            .map(|value| Uuid::parse_str(&value))
            .transpose()
            .map_err(|_| ProjectVersionError::InvariantViolation)?,
    })
}

fn validate_project_identity(
    project: &ProjectRow,
    owner: ProjectOwner,
    expected_scope: StorageScopeId,
) -> Result<(), ProjectVersionError> {
    let owner_matches = match owner {
        ProjectOwner::User(id) => {
            let id = id.to_string();
            project.owner_user_id.as_deref() == Some(id.as_str())
                && project.owner_organization_id.is_none()
        }
        ProjectOwner::Organization(id) => {
            let id = id.to_string();
            project.owner_organization_id.as_deref() == Some(id.as_str())
                && project.owner_user_id.is_none()
        }
    };
    if !owner_matches || project.storage_scope_id != expected_scope {
        return Err(ProjectVersionError::NotFound);
    }
    Ok(())
}

fn require_active_project(project: &ProjectRow) -> Result<(), ProjectVersionError> {
    if project.state != "active" {
        return Err(ProjectVersionError::ProjectUnavailable);
    }
    Ok(())
}

async fn load_idempotent(
    transaction: &mut Transaction<'_, Postgres>,
    project_id: ProjectId,
    actor_user_id: UserId,
    digest: &[u8; 32],
    deadline: Deadline,
) -> Result<Option<ExplicitProjectVersion>, ProjectVersionError> {
    let row = deadline
        .run(
            sqlx::query_as::<_, VersionRow>(
                "SELECT reference.id::text,reference.project_id::text,reference.bundle_id::text,\
                        reference.version_name,reference.actor_user_id::text,\
                        reference.source_project_version,reference.created_at,bundle.sha256,\
                        bundle.physical_bytes,bundle.logical_bytes,bundle.file_count,bundle.format \
                 FROM project_bundle_refs reference \
                 JOIN bundles bundle ON bundle.id=reference.bundle_id \
                 WHERE reference.project_id=$1::uuid AND reference.actor_user_id=$2::uuid \
                   AND reference.kind='version' AND reference.idempotency_digest=$3",
            )
            .bind(project_id.to_string())
            .bind(actor_user_id.to_string())
            .bind(digest.as_slice())
            .fetch_optional(&mut **transaction),
        )
        .await?
        .map_err(map_sql_error)?;
    row.map(decode_version).transpose()
}

fn decode_version(row: VersionRow) -> Result<ExplicitProjectVersion, ProjectVersionError> {
    let sha256: [u8; 32] = row
        .7
        .try_into()
        .map_err(|_| ProjectVersionError::InvariantViolation)?;
    if row.11 != "project-bundle-v1" {
        return Err(ProjectVersionError::InvariantViolation);
    }
    Ok(ExplicitProjectVersion {
        id: row.0.parse()?,
        project_id: row
            .1
            .parse()
            .map_err(|_| ProjectVersionError::InvariantViolation)?,
        bundle_id: Uuid::parse_str(&row.2).map_err(|_| ProjectVersionError::InvariantViolation)?,
        name: ProjectVersionName::new(row.3)
            .map_err(|_| ProjectVersionError::InvariantViolation)?,
        actor_user_id: row
            .4
            .parse()
            .map_err(|_| ProjectVersionError::InvariantViolation)?,
        source_project_version: ProjectVersion::new(row.5)
            .map_err(|_| ProjectVersionError::InvariantViolation)?,
        created_at: Timestamp::from_datetime(row.6)
            .map_err(|_| ProjectVersionError::InvariantViolation)?,
        sha256,
        physical_bytes: u64::try_from(row.8)
            .map_err(|_| ProjectVersionError::InvariantViolation)?,
        logical_bytes: u64::try_from(row.9).map_err(|_| ProjectVersionError::InvariantViolation)?,
        file_count: u32::try_from(row.10).map_err(|_| ProjectVersionError::InvariantViolation)?,
        format: row.11,
    })
}

fn idempotency_digest(request: &CreateProjectVersion) -> [u8; 32] {
    let mut digest = Sha256::new();
    digest.update(b"nuriteo-explicit-project-version-key-v1\0");
    digest.update(request.project_id.to_string().as_bytes());
    digest.update(b"\0");
    digest.update(request.actor_user_id.to_string().as_bytes());
    digest.update(b"\0");
    digest.update(request.idempotency_key.expose_for_hmac());
    digest.finalize().into()
}

async fn configure(
    transaction: &mut Transaction<'_, Postgres>,
    deadline: Deadline,
) -> Result<(), ProjectVersionError> {
    let timeout = deadline
        .remaining()?
        .saturating_sub(SQL_MARGIN)
        .max(Duration::from_millis(1));
    let milliseconds = timeout.as_millis().min(i64::MAX as u128);
    deadline
        .run(
            sqlx::query(
                "SELECT set_config('lock_timeout',$1,true),set_config('statement_timeout',$1,true)",
            )
            .bind(format!("{milliseconds}ms"))
            .execute(&mut **transaction),
        )
        .await?
        .map_err(map_sql_error)?;
    Ok(())
}

async fn commit(
    transaction: Transaction<'_, Postgres>,
    deadline: Deadline,
) -> Result<(), ProjectVersionError> {
    match time::timeout_at(deadline.0, transaction.commit()).await {
        Ok(Ok(())) => Ok(()),
        Ok(Err(error)) if error.as_database_error().is_some() => Err(map_sql_error(error)),
        Ok(Err(_)) | Err(_) => Err(ProjectVersionError::CommitOutcomeUnknown),
    }
}

fn map_database_error(error: DatabaseError) -> ProjectVersionError {
    match error {
        DatabaseError::AcquireTimeout => ProjectVersionError::OperationTimeout,
        _ => ProjectVersionError::DatabaseUnavailable,
    }
}

fn map_access_error(error: ProjectAccessError) -> ProjectVersionError {
    match error {
        ProjectAccessError::OperationTimeout => ProjectVersionError::OperationTimeout,
        ProjectAccessError::PersistenceUnavailable => ProjectVersionError::DatabaseUnavailable,
        ProjectAccessError::InvalidPersistedState => ProjectVersionError::InvariantViolation,
        ProjectAccessError::ProjectUnavailable
        | ProjectAccessError::ProjectNotOrganizationOwned
        | ProjectAccessError::MemberUnavailable
        | ProjectAccessError::AlreadyGranted => ProjectVersionError::NotFound,
    }
}

fn map_insert_error(error: sqlx::Error) -> ProjectVersionError {
    if let Some(database) = error.as_database_error() {
        match database.constraint() {
            Some("project_bundle_refs_version_name_unique") => {
                return ProjectVersionError::NameConflict;
            }
            Some("project_bundle_refs_version_idempotency_unique") => {
                return ProjectVersionError::IdempotencyConflict;
            }
            _ => {}
        }
    }
    map_sql_error(error)
}

fn map_sql_error(error: sqlx::Error) -> ProjectVersionError {
    match error
        .as_database_error()
        .and_then(|error| error.code())
        .as_deref()
    {
        Some("57014" | "55P03") => ProjectVersionError::OperationTimeout,
        Some("23503" | "23514") => ProjectVersionError::InvariantViolation,
        _ => ProjectVersionError::DatabaseUnavailable,
    }
}

#[derive(Clone, Copy)]
struct Deadline(Instant);

impl Deadline {
    fn new(timeout: Duration) -> Self {
        Self(Instant::now() + timeout)
    }

    fn remaining(self) -> Result<Duration, ProjectVersionError> {
        self.0
            .checked_duration_since(Instant::now())
            .filter(|duration| !duration.is_zero())
            .ok_or(ProjectVersionError::OperationTimeout)
    }

    async fn run<T>(self, future: impl Future<Output = T>) -> Result<T, ProjectVersionError> {
        time::timeout_at(self.0, future)
            .await
            .map_err(|_| ProjectVersionError::OperationTimeout)
    }
}
