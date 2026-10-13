use std::fmt;
use std::str::FromStr;
use std::time::Duration;

use ::time::OffsetDateTime;
use serde_json::json;
use sha2::{Digest, Sha256};
use sqlx::{Acquire, Postgres, Transaction};
use tokio::time::{self, Instant};
use uuid::{Uuid, Variant, Version};

use crate::audit::{
    ActorType, AuditActor, AuditEvent, AuditEventFields, AuditMetadata, AuditResult, AuditScope,
    AuditTarget, AuditWriter, ScopeType,
};
use crate::database::{DatabaseError, DatabasePool};
use crate::identity::{Timestamp, UserId};
use crate::project::{
    EffectiveProjectRole, ProjectAccessError, ProjectAccessRepository, ProjectAuditContext,
    ProjectId, ProjectOwner, ProjectVersion,
};
use crate::quota::QuotaRepository;
use crate::workspace::StorageScopeId;

use super::IdempotencyKey;

const MIN_TIMEOUT: Duration = Duration::from_millis(100);
const MAX_TIMEOUT: Duration = Duration::from_secs(30);
const SQL_MARGIN: Duration = Duration::from_millis(25);
const MAX_RECOVERY_CHECKPOINTS: usize = 3;

#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub struct ProjectHistoryServicePolicy {
    operation_timeout: Duration,
}

impl ProjectHistoryServicePolicy {
    pub fn new(operation_timeout: Duration) -> Result<Self, ProjectHistoryError> {
        if !(MIN_TIMEOUT..=MAX_TIMEOUT).contains(&operation_timeout) {
            return Err(ProjectHistoryError::InvalidInput);
        }
        Ok(Self { operation_timeout })
    }
}

impl Default for ProjectHistoryServicePolicy {
    fn default() -> Self {
        Self {
            operation_timeout: Duration::from_secs(5),
        }
    }
}

#[derive(Clone, Copy, Debug, PartialEq, Eq, Hash)]
pub enum HistoricalReferenceKind {
    Version,
    Recovery,
}

impl HistoricalReferenceKind {
    #[must_use]
    pub const fn as_str(self) -> &'static str {
        match self {
            Self::Version => "version",
            Self::Recovery => "recovery",
        }
    }
}

impl FromStr for HistoricalReferenceKind {
    type Err = ProjectHistoryError;

    fn from_str(value: &str) -> Result<Self, Self::Err> {
        match value {
            "version" => Ok(Self::Version),
            "recovery" => Ok(Self::Recovery),
            _ => Err(ProjectHistoryError::InvalidInput),
        }
    }
}

#[derive(Clone, Debug, PartialEq, Eq)]
pub struct RecoveryCheckpoint {
    id: Uuid,
    project_id: ProjectId,
    bundle_id: Uuid,
    position: u8,
    actor_user_id: UserId,
    created_at: Timestamp,
    sha256: [u8; 32],
    physical_bytes: u64,
    logical_bytes: u64,
    file_count: u32,
    format: String,
}

impl RecoveryCheckpoint {
    #[must_use]
    pub const fn id(&self) -> Uuid {
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
    pub const fn position(&self) -> u8 {
        self.position
    }
    #[must_use]
    pub const fn actor_user_id(&self) -> UserId {
        self.actor_user_id
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

#[derive(Clone, Debug)]
pub struct PromoteHistoricalReference {
    pub owner: ProjectOwner,
    pub project_id: ProjectId,
    pub actor_user_id: UserId,
    pub expected_project_version: ProjectVersion,
    pub reference_kind: HistoricalReferenceKind,
    pub reference_id: Uuid,
    pub idempotency_key: IdempotencyKey,
    pub audit: ProjectAuditContext,
}

#[derive(Clone, Debug, PartialEq, Eq)]
pub struct HistoricalPromotionOutcome {
    operation_id: Uuid,
    reference_kind: HistoricalReferenceKind,
    reference_id: Uuid,
    bundle_id: Uuid,
    project_version: ProjectVersion,
    changed: bool,
    idempotent_retry: bool,
}

impl HistoricalPromotionOutcome {
    #[must_use]
    pub const fn operation_id(&self) -> Uuid {
        self.operation_id
    }
    #[must_use]
    pub const fn reference_kind(&self) -> HistoricalReferenceKind {
        self.reference_kind
    }
    #[must_use]
    pub const fn reference_id(&self) -> Uuid {
        self.reference_id
    }
    #[must_use]
    pub const fn bundle_id(&self) -> Uuid {
        self.bundle_id
    }
    #[must_use]
    pub const fn project_version(&self) -> ProjectVersion {
        self.project_version
    }
    #[must_use]
    pub const fn changed(&self) -> bool {
        self.changed
    }
    #[must_use]
    pub const fn is_idempotent_retry(&self) -> bool {
        self.idempotent_retry
    }
}

#[derive(Clone, Copy, Debug, PartialEq, Eq)]
#[non_exhaustive]
pub enum ProjectHistoryError {
    InvalidInput,
    NotFound,
    Forbidden,
    ProjectUnavailable,
    StaleProjectVersion,
    IdempotencyConflict,
    OperationTimeout,
    DatabaseUnavailable,
    AuditUnavailable,
    CommitOutcomeUnknown,
    InvariantViolation,
}

impl fmt::Display for ProjectHistoryError {
    fn fmt(&self, formatter: &mut fmt::Formatter<'_>) -> fmt::Result {
        formatter.write_str(match self {
            Self::InvalidInput => "Project history input is invalid",
            Self::NotFound => "Project history resource was not found",
            Self::Forbidden => "Project history request is forbidden",
            Self::ProjectUnavailable => "Project history cannot be changed in its current state",
            Self::StaleProjectVersion => "project version is stale",
            Self::IdempotencyConflict => "idempotency key conflicts with another history request",
            Self::OperationTimeout => "Project history operation timed out",
            Self::DatabaseUnavailable => "Project history persistence is unavailable",
            Self::AuditUnavailable => "Project history audit is unavailable",
            Self::CommitOutcomeUnknown => "Project history commit outcome is unknown",
            Self::InvariantViolation => "Project history persistence state is invalid",
        })
    }
}

impl std::error::Error for ProjectHistoryError {}

#[derive(Clone, Debug)]
pub struct ProjectHistoryService {
    pool: DatabasePool,
    policy: ProjectHistoryServicePolicy,
}

impl ProjectHistoryService {
    #[must_use]
    pub const fn new(pool: DatabasePool, policy: ProjectHistoryServicePolicy) -> Self {
        Self { pool, policy }
    }

    pub async fn list_recovery_checkpoints(
        &self,
        actor_user_id: UserId,
        owner: ProjectOwner,
        project_id: ProjectId,
    ) -> Result<Vec<RecoveryCheckpoint>, ProjectHistoryError> {
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
            return Err(ProjectHistoryError::NotFound);
        }
        let project = load_project(&mut transaction, project_id, false, deadline).await?;
        validate_project_identity(&project, owner)?;
        if !matches!(project.state.as_str(), "active" | "archived") {
            return Err(ProjectHistoryError::InvariantViolation);
        }
        let rows = deadline
            .run(sqlx::query_as::<_, RecoveryRow>(
                "SELECT reference.id::text,reference.project_id::text,reference.bundle_id::text,\
                        reference.recovery_position,reference.actor_user_id::text,\
                        reference.created_at,bundle.sha256,bundle.physical_bytes,\
                        bundle.logical_bytes,bundle.file_count,bundle.format \
                 FROM project_bundle_refs reference \
                 JOIN bundles bundle ON bundle.id=reference.bundle_id \
                 WHERE reference.project_id=$1::uuid AND reference.kind='recovery' \
                 ORDER BY reference.created_at DESC,reference.id DESC LIMIT 4"
            ).bind(project_id.to_string()).fetch_all(&mut *transaction))
            .await?
            .map_err(map_sql_error)?;
        if rows.len() > MAX_RECOVERY_CHECKPOINTS {
            return Err(ProjectHistoryError::InvariantViolation);
        }
        let checkpoints = rows
            .into_iter()
            .map(decode_recovery)
            .collect::<Result<Vec<_>, _>>()?;
        commit(transaction, deadline).await?;
        Ok(checkpoints)
    }

    pub async fn promote(
        &self,
        request: PromoteHistoricalReference,
    ) -> Result<HistoricalPromotionOutcome, ProjectHistoryError> {
        validate_reference_id(request.reference_id)?;
        if request.audit.actor_user_id() != request.actor_user_id {
            return Err(ProjectHistoryError::InvalidInput);
        }
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
            return Err(ProjectHistoryError::NotFound);
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
            return Err(ProjectHistoryError::NotFound);
        }
        if role < EffectiveProjectRole::Write {
            return Err(ProjectHistoryError::Forbidden);
        }
        let project = load_project(&mut transaction, request.project_id, true, deadline).await?;
        validate_project_identity(&project, request.owner)?;
        if project.storage_scope_id != scope {
            return Err(ProjectHistoryError::NotFound);
        }
        if project.state != "active" {
            return Err(ProjectHistoryError::ProjectUnavailable);
        }

        let digest = idempotency_digest(&request);
        if let Some(mut outcome) = load_idempotent(
            &mut transaction,
            request.project_id,
            request.actor_user_id,
            &digest,
            deadline,
        )
        .await?
        {
            if outcome.reference_kind != request.reference_kind
                || outcome.reference_id != request.reference_id
                || outcome.project_version.get()
                    != if outcome.changed {
                        request
                            .expected_project_version
                            .get()
                            .checked_add(1)
                            .ok_or(ProjectHistoryError::InvalidInput)?
                    } else {
                        request.expected_project_version.get()
                    }
            {
                return Err(ProjectHistoryError::IdempotencyConflict);
            }
            outcome.idempotent_retry = true;
            commit(transaction, deadline).await?;
            return Ok(outcome);
        }
        if project.lock_version != request.expected_project_version.get() {
            return Err(ProjectHistoryError::StaleProjectVersion);
        }
        let current_bundle = project
            .working_head_bundle_id
            .ok_or(ProjectHistoryError::NotFound)?;
        let target_bundle = load_reference_bundle(
            &mut transaction,
            request.project_id,
            request.reference_kind,
            request.reference_id,
            deadline,
        )
        .await?;
        let changed = current_bundle != target_bundle;
        let result_version = if changed {
            rotate_recovery_checkpoints(
                &mut transaction,
                request.project_id,
                scope,
                request.actor_user_id,
                current_bundle,
                target_bundle,
                deadline,
            )
            .await?;
            clear_live_reference_gc_candidates(
                &mut transaction,
                request.project_id,
                target_bundle,
                deadline,
            )
            .await?;
            let affected = deadline.run(sqlx::query(
                "UPDATE projects SET working_head_bundle_id=$2::uuid,lock_version=lock_version+1,\
                        updated_at=transaction_timestamp() \
                 WHERE id=$1::uuid AND lock_version=$3 AND state='active'"
            ).bind(request.project_id.to_string()).bind(target_bundle.to_string())
                .bind(request.expected_project_version.get()).execute(&mut *transaction))
                .await?.map_err(map_sql_error)?.rows_affected();
            if affected != 1 {
                return Err(ProjectHistoryError::StaleProjectVersion);
            }
            ProjectVersion::new(
                request
                    .expected_project_version
                    .get()
                    .checked_add(1)
                    .ok_or(ProjectHistoryError::InvariantViolation)?,
            )
            .map_err(|_| ProjectHistoryError::InvariantViolation)?
        } else {
            request.expected_project_version
        };
        let operation_id = Uuid::now_v7();
        append_audit(&mut transaction, &request, target_bundle, changed, deadline).await?;
        deadline
            .run(
                sqlx::query(
                    "INSERT INTO project_history_promotions \
             (id,project_id,actor_user_id,idempotency_digest,reference_kind,reference_id,bundle_id,\
              expected_project_version,resulting_project_version,changed,audit_event_id) \
             VALUES ($1::uuid,$2::uuid,$3::uuid,$4,$5,$6::uuid,$7::uuid,$8,$9,$10,$11::uuid)",
                )
                .bind(operation_id.to_string())
                .bind(request.project_id.to_string())
                .bind(request.actor_user_id.to_string())
                .bind(digest.as_slice())
                .bind(request.reference_kind.as_str())
                .bind(request.reference_id.to_string())
                .bind(target_bundle.to_string())
                .bind(request.expected_project_version.get())
                .bind(result_version.get())
                .bind(changed)
                .bind(request.audit.event_id().to_string())
                .execute(&mut *transaction),
            )
            .await?
            .map_err(map_insert_error)?;
        let outcome = HistoricalPromotionOutcome {
            operation_id,
            reference_kind: request.reference_kind,
            reference_id: request.reference_id,
            bundle_id: target_bundle,
            project_version: result_version,
            changed,
            idempotent_retry: false,
        };
        commit(transaction, deadline).await?;
        Ok(outcome)
    }

    pub async fn reconcile(
        &self,
        actor_user_id: UserId,
        owner: ProjectOwner,
        project_id: ProjectId,
        idempotency_key: &IdempotencyKey,
    ) -> Result<HistoricalPromotionOutcome, ProjectHistoryError> {
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
            return Err(ProjectHistoryError::NotFound);
        }
        let project = load_project(&mut transaction, project_id, false, deadline).await?;
        validate_project_identity(&project, owner)?;
        let digest = idempotency_digest_parts(project_id, actor_user_id, idempotency_key);
        let mut outcome = load_idempotent(
            &mut transaction,
            project_id,
            actor_user_id,
            &digest,
            deadline,
        )
        .await?
        .ok_or(ProjectHistoryError::NotFound)?;
        outcome.idempotent_retry = true;
        commit(transaction, deadline).await?;
        Ok(outcome)
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

type RecoveryRow = (
    String,
    String,
    String,
    i16,
    String,
    OffsetDateTime,
    Vec<u8>,
    i64,
    i64,
    i32,
    String,
);

fn decode_recovery(row: RecoveryRow) -> Result<RecoveryCheckpoint, ProjectHistoryError> {
    if row.10 != "project-bundle-v1" {
        return Err(ProjectHistoryError::InvariantViolation);
    }
    Ok(RecoveryCheckpoint {
        id: parse_v7(&row.0)?,
        project_id: row
            .1
            .parse()
            .map_err(|_| ProjectHistoryError::InvariantViolation)?,
        bundle_id: Uuid::parse_str(&row.2).map_err(|_| ProjectHistoryError::InvariantViolation)?,
        position: u8::try_from(row.3)
            .ok()
            .filter(|value| (1..=3).contains(value))
            .ok_or(ProjectHistoryError::InvariantViolation)?,
        actor_user_id: row
            .4
            .parse()
            .map_err(|_| ProjectHistoryError::InvariantViolation)?,
        created_at: Timestamp::from_datetime(row.5)
            .map_err(|_| ProjectHistoryError::InvariantViolation)?,
        sha256: row
            .6
            .try_into()
            .map_err(|_| ProjectHistoryError::InvariantViolation)?,
        physical_bytes: u64::try_from(row.7)
            .map_err(|_| ProjectHistoryError::InvariantViolation)?,
        logical_bytes: u64::try_from(row.8).map_err(|_| ProjectHistoryError::InvariantViolation)?,
        file_count: u32::try_from(row.9).map_err(|_| ProjectHistoryError::InvariantViolation)?,
        format: row.10,
    })
}

fn parse_v7(value: &str) -> Result<Uuid, ProjectHistoryError> {
    let id = Uuid::parse_str(value).map_err(|_| ProjectHistoryError::InvariantViolation)?;
    validate_reference_id(id).map_err(|_| ProjectHistoryError::InvariantViolation)?;
    Ok(id)
}

fn validate_reference_id(id: Uuid) -> Result<(), ProjectHistoryError> {
    if id.is_nil()
        || id.get_version() != Some(Version::SortRand)
        || id.get_variant() != Variant::RFC4122
    {
        return Err(ProjectHistoryError::InvalidInput);
    }
    Ok(())
}

async fn project_scope_hint(
    tx: &mut Transaction<'_, Postgres>,
    project_id: ProjectId,
    deadline: Deadline,
) -> Result<StorageScopeId, ProjectHistoryError> {
    let value: Option<String> = deadline
        .run(
            sqlx::query_scalar("SELECT storage_scope_id::text FROM projects WHERE id=$1::uuid")
                .bind(project_id.to_string())
                .fetch_optional(&mut **tx),
        )
        .await?
        .map_err(map_sql_error)?;
    value
        .ok_or(ProjectHistoryError::NotFound)?
        .parse()
        .map_err(|_| ProjectHistoryError::InvariantViolation)
}

async fn load_project(
    tx: &mut Transaction<'_, Postgres>,
    project_id: ProjectId,
    for_update: bool,
    deadline: Deadline,
) -> Result<ProjectRow, ProjectHistoryError> {
    type Row = (
        String,
        i64,
        String,
        Option<String>,
        Option<String>,
        Option<String>,
    );
    let sql = if for_update {
        "SELECT state,lock_version,storage_scope_id::text,owner_user_id::text,owner_organization_id::text,working_head_bundle_id::text FROM projects WHERE id=$1::uuid FOR UPDATE"
    } else {
        "SELECT state,lock_version,storage_scope_id::text,owner_user_id::text,owner_organization_id::text,working_head_bundle_id::text FROM projects WHERE id=$1::uuid"
    };
    let row: Option<Row> = deadline
        .run(
            sqlx::query_as(sql)
                .bind(project_id.to_string())
                .fetch_optional(&mut **tx),
        )
        .await?
        .map_err(map_sql_error)?;
    let row = row.ok_or(ProjectHistoryError::NotFound)?;
    Ok(ProjectRow {
        state: row.0,
        lock_version: row.1,
        storage_scope_id: row
            .2
            .parse()
            .map_err(|_| ProjectHistoryError::InvariantViolation)?,
        owner_user_id: row.3,
        owner_organization_id: row.4,
        working_head_bundle_id: row
            .5
            .map(|value| Uuid::parse_str(&value))
            .transpose()
            .map_err(|_| ProjectHistoryError::InvariantViolation)?,
    })
}

fn validate_project_identity(
    project: &ProjectRow,
    owner: ProjectOwner,
) -> Result<(), ProjectHistoryError> {
    let matches = match owner {
        ProjectOwner::User(id) => {
            project.owner_user_id.as_deref() == Some(id.to_string().as_str())
                && project.owner_organization_id.is_none()
        }
        ProjectOwner::Organization(id) => {
            project.owner_organization_id.as_deref() == Some(id.to_string().as_str())
                && project.owner_user_id.is_none()
        }
    };
    if !matches {
        return Err(ProjectHistoryError::NotFound);
    }
    Ok(())
}

async fn load_reference_bundle(
    tx: &mut Transaction<'_, Postgres>,
    project_id: ProjectId,
    kind: HistoricalReferenceKind,
    reference_id: Uuid,
    deadline: Deadline,
) -> Result<Uuid, ProjectHistoryError> {
    let value: Option<String> = deadline.run(sqlx::query_scalar(
        "SELECT bundle_id::text FROM project_bundle_refs WHERE project_id=$1::uuid AND kind=$2 AND id=$3::uuid"
    ).bind(project_id.to_string()).bind(kind.as_str()).bind(reference_id.to_string()).fetch_optional(&mut **tx)).await?.map_err(map_sql_error)?;
    value
        .ok_or(ProjectHistoryError::NotFound)?
        .parse()
        .map_err(|_| ProjectHistoryError::InvariantViolation)
}

async fn rotate_recovery_checkpoints(
    tx: &mut Transaction<'_, Postgres>,
    project_id: ProjectId,
    scope: StorageScopeId,
    actor: UserId,
    previous_head: Uuid,
    target_bundle: Uuid,
    deadline: Deadline,
) -> Result<(), ProjectHistoryError> {
    type Row = (String, i16, String);
    let rows: Vec<Row> = deadline.run(sqlx::query_as(
        "SELECT id::text,recovery_position,bundle_id::text FROM project_bundle_refs WHERE project_id=$1::uuid AND kind='recovery' ORDER BY created_at,id FOR UPDATE"
    ).bind(project_id.to_string()).fetch_all(&mut **tx)).await?.map_err(map_sql_error)?;
    if rows.len() > MAX_RECOVERY_CHECKPOINTS {
        return Err(ProjectHistoryError::InvariantViolation);
    }
    let mut occupied = [false; MAX_RECOVERY_CHECKPOINTS];
    for (_, position, _) in &rows {
        let index = position
            .checked_sub(1)
            .and_then(|value| usize::try_from(value).ok())
            .filter(|index| *index < occupied.len())
            .ok_or(ProjectHistoryError::InvariantViolation)?;
        if occupied[index] {
            return Err(ProjectHistoryError::InvariantViolation);
        }
        occupied[index] = true;
    }
    let existing = rows.iter().find(|row| row.2 == previous_head.to_string());
    let (position, deleted) = if let Some((id, position, bundle_id)) = existing {
        (*position, Some((id.as_str(), bundle_id.as_str())))
    } else if rows.len() == MAX_RECOVERY_CHECKPOINTS {
        let (id, position, bundle_id) = rows
            .first()
            .ok_or(ProjectHistoryError::InvariantViolation)?;
        (*position, Some((id.as_str(), bundle_id.as_str())))
    } else {
        (
            occupied
                .iter()
                .position(|value| !value)
                .and_then(|index| i16::try_from(index + 1).ok())
                .ok_or(ProjectHistoryError::InvariantViolation)?,
            None,
        )
    };
    let deleted_bundle = deleted
        .map(|(_, bundle_id)| {
            Uuid::parse_str(bundle_id).map_err(|_| ProjectHistoryError::InvariantViolation)
        })
        .transpose()?;
    lock_history_object_lifecycles(tx, previous_head, target_bundle, deleted_bundle, deadline)
        .await?;
    if let Some((id, _)) = deleted {
        let affected = deadline.run(sqlx::query(
            "DELETE FROM project_bundle_refs WHERE id=$1::uuid AND project_id=$2::uuid AND kind='recovery'"
        ).bind(id).bind(project_id.to_string()).execute(&mut **tx)).await?.map_err(map_sql_error)?.rows_affected();
        if affected != 1 {
            return Err(ProjectHistoryError::InvariantViolation);
        }
    }
    deadline.run(sqlx::query(
        "INSERT INTO project_bundle_refs (id,project_id,storage_scope_id,bundle_id,kind,recovery_position,actor_user_id) VALUES ($1::uuid,$2::uuid,$3::uuid,$4::uuid,'recovery',$5,$6::uuid)"
    ).bind(Uuid::now_v7().to_string()).bind(project_id.to_string()).bind(scope.to_string())
        .bind(previous_head.to_string()).bind(position).bind(actor.to_string()).execute(&mut **tx)).await?.map_err(map_sql_error)?;
    Ok(())
}

async fn lock_history_object_lifecycles(
    tx: &mut Transaction<'_, Postgres>,
    previous_head: Uuid,
    target_bundle: Uuid,
    deleted_bundle: Option<Uuid>,
    deadline: Deadline,
) -> Result<(), ProjectHistoryError> {
    deadline
        .run(
            sqlx::query(
                "SELECT pg_advisory_xact_lock(1347566129, lifecycle.lock_key) \
                 FROM (SELECT DISTINCT hashtext('bundle-object:' || bundle.object_key) AS lock_key \
                       FROM bundles bundle \
                       WHERE bundle.id IN ($1::uuid,$2::uuid,$3::uuid)) lifecycle \
                 ORDER BY lifecycle.lock_key",
            )
            .bind(previous_head.to_string())
            .bind(target_bundle.to_string())
            .bind(deleted_bundle.map(|bundle_id| bundle_id.to_string()))
            .execute(&mut **tx),
        )
        .await?
        .map_err(map_sql_error)?;
    Ok(())
}

async fn clear_live_reference_gc_candidates(
    tx: &mut Transaction<'_, Postgres>,
    project_id: ProjectId,
    incoming: Uuid,
    deadline: Deadline,
) -> Result<(), ProjectHistoryError> {
    deadline.run(sqlx::query(
        "DELETE FROM gc_candidates candidate USING bundles bundle WHERE candidate.object_key=bundle.object_key AND candidate.status IN ('queued','retry_wait','failed') AND (bundle.id=$2::uuid OR EXISTS (SELECT 1 FROM project_bundle_refs reference WHERE reference.project_id=$1::uuid AND reference.bundle_id=bundle.id))"
    ).bind(project_id.to_string()).bind(incoming.to_string()).execute(&mut **tx)).await?.map_err(map_sql_error)?;
    let unsafe_candidate: bool = deadline.run(sqlx::query_scalar(
        "SELECT EXISTS(SELECT 1 FROM gc_candidates candidate JOIN bundles bundle ON bundle.object_key=candidate.object_key WHERE candidate.status IN ('running','completed') AND (bundle.id=$2::uuid OR EXISTS (SELECT 1 FROM project_bundle_refs reference WHERE reference.project_id=$1::uuid AND reference.bundle_id=bundle.id)))"
    ).bind(project_id.to_string()).bind(incoming.to_string()).fetch_one(&mut **tx)).await?.map_err(map_sql_error)?;
    if unsafe_candidate {
        return Err(ProjectHistoryError::InvariantViolation);
    }
    Ok(())
}

type OutcomeRow = (String, String, String, String, i64, bool);

async fn load_idempotent(
    tx: &mut Transaction<'_, Postgres>,
    project_id: ProjectId,
    actor: UserId,
    digest: &[u8; 32],
    deadline: Deadline,
) -> Result<Option<HistoricalPromotionOutcome>, ProjectHistoryError> {
    let row: Option<OutcomeRow> = deadline.run(sqlx::query_as(
        "SELECT id::text,reference_kind,reference_id::text,bundle_id::text,resulting_project_version,changed FROM project_history_promotions WHERE project_id=$1::uuid AND actor_user_id=$2::uuid AND idempotency_digest=$3"
    ).bind(project_id.to_string()).bind(actor.to_string()).bind(digest.as_slice()).fetch_optional(&mut **tx)).await?.map_err(map_sql_error)?;
    row.map(|row| {
        Ok(HistoricalPromotionOutcome {
            operation_id: parse_v7(&row.0)?,
            reference_kind: row.1.parse()?,
            reference_id: parse_v7(&row.2)?,
            bundle_id: Uuid::parse_str(&row.3)
                .map_err(|_| ProjectHistoryError::InvariantViolation)?,
            project_version: ProjectVersion::new(row.4)
                .map_err(|_| ProjectHistoryError::InvariantViolation)?,
            changed: row.5,
            idempotent_retry: true,
        })
    })
    .transpose()
}

async fn append_audit(
    tx: &mut Transaction<'_, Postgres>,
    request: &PromoteHistoricalReference,
    bundle_id: Uuid,
    changed: bool,
    deadline: Deadline,
) -> Result<(), ProjectHistoryError> {
    let now: OffsetDateTime = deadline
        .run(sqlx::query_scalar("SELECT transaction_timestamp()").fetch_one(&mut **tx))
        .await?
        .map_err(map_sql_error)?;
    let event = AuditEvent::new(AuditEventFields {
        id: request.audit.event_id(),
        occurred_at: Timestamp::from_datetime(now).map_err(|_| ProjectHistoryError::InvariantViolation)?,
        actor: AuditActor { kind: ActorType::User, id: request.actor_user_id.to_string(), user_id: Some(request.actor_user_id), display_name: request.audit.actor_display_name() },
        action_code: "project.history.promoted".into(),
        target: AuditTarget { kind: "project_history_reference".into(), id: request.reference_id.to_string() },
        scope: AuditScope { kind: ScopeType::Project, id: request.project_id.to_string() },
        result: AuditResult::Succeeded,
        reason_code: None,
        correlation_id: request.audit.correlation_id(),
        source_ip: request.audit.source_ip(),
        schema_version: 1,
        changed_fields: if changed { vec!["working_head_bundle_id".into(), "lock_version".into()] } else { Vec::new() },
        metadata: AuditMetadata::new(json!({"source":"project-history-service","referenceKind":request.reference_kind.as_str(),"bundleId":bundle_id.to_string(),"changed":changed})).map_err(|_| ProjectHistoryError::InvariantViolation)?,
    }).map_err(|_| ProjectHistoryError::InvalidInput)?;
    deadline
        .run(AuditWriter::append(tx, &event))
        .await?
        .map_err(|_| ProjectHistoryError::AuditUnavailable)
}

fn idempotency_digest(request: &PromoteHistoricalReference) -> [u8; 32] {
    idempotency_digest_parts(
        request.project_id,
        request.actor_user_id,
        &request.idempotency_key,
    )
}

fn idempotency_digest_parts(
    project_id: ProjectId,
    actor: UserId,
    key: &IdempotencyKey,
) -> [u8; 32] {
    let mut digest = Sha256::new();
    digest.update(b"nuriteo-project-history-promotion-key-v1\0");
    digest.update(project_id.to_string().as_bytes());
    digest.update(b"\0");
    digest.update(actor.to_string().as_bytes());
    digest.update(b"\0");
    digest.update(key.expose_for_hmac());
    digest.finalize().into()
}

async fn configure(
    tx: &mut Transaction<'_, Postgres>,
    deadline: Deadline,
) -> Result<(), ProjectHistoryError> {
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
            .execute(&mut **tx),
        )
        .await?
        .map_err(map_sql_error)?;
    Ok(())
}

async fn commit(
    tx: Transaction<'_, Postgres>,
    deadline: Deadline,
) -> Result<(), ProjectHistoryError> {
    match time::timeout_at(deadline.0, tx.commit()).await {
        Ok(Ok(())) => Ok(()),
        Ok(Err(error)) if error.as_database_error().is_some() => Err(map_sql_error(error)),
        Ok(Err(_)) | Err(_) => Err(ProjectHistoryError::CommitOutcomeUnknown),
    }
}

fn map_database_error(error: DatabaseError) -> ProjectHistoryError {
    match error {
        DatabaseError::AcquireTimeout => ProjectHistoryError::OperationTimeout,
        _ => ProjectHistoryError::DatabaseUnavailable,
    }
}

fn map_access_error(error: ProjectAccessError) -> ProjectHistoryError {
    match error {
        ProjectAccessError::OperationTimeout => ProjectHistoryError::OperationTimeout,
        ProjectAccessError::PersistenceUnavailable => ProjectHistoryError::DatabaseUnavailable,
        ProjectAccessError::InvalidPersistedState => ProjectHistoryError::InvariantViolation,
        _ => ProjectHistoryError::NotFound,
    }
}

fn map_insert_error(error: sqlx::Error) -> ProjectHistoryError {
    if error
        .as_database_error()
        .and_then(|error| error.constraint())
        == Some("project_history_promotions_idempotency_unique")
    {
        return ProjectHistoryError::IdempotencyConflict;
    }
    map_sql_error(error)
}

fn map_sql_error(error: sqlx::Error) -> ProjectHistoryError {
    match error
        .as_database_error()
        .and_then(|error| error.code())
        .as_deref()
    {
        Some("57014" | "55P03") => ProjectHistoryError::OperationTimeout,
        Some("23503" | "23514") => ProjectHistoryError::InvariantViolation,
        _ => ProjectHistoryError::DatabaseUnavailable,
    }
}

#[derive(Clone, Copy)]
struct Deadline(Instant);

impl Deadline {
    fn new(timeout: Duration) -> Self {
        Self(Instant::now() + timeout)
    }
    fn remaining(self) -> Result<Duration, ProjectHistoryError> {
        self.0
            .checked_duration_since(Instant::now())
            .filter(|value| !value.is_zero())
            .ok_or(ProjectHistoryError::OperationTimeout)
    }
    async fn run<T>(self, future: impl Future<Output = T>) -> Result<T, ProjectHistoryError> {
        time::timeout_at(self.0, future)
            .await
            .map_err(|_| ProjectHistoryError::OperationTimeout)
    }
}
