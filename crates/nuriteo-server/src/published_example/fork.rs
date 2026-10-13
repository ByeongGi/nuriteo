use std::{fmt, time::Duration};

use ::time::OffsetDateTime;
use serde_json::json;
use sha2::{Digest as _, Sha256};
use sqlx::{Acquire, Postgres, Transaction};
use tokio::time;
use uuid::Uuid;

use crate::{
    audit::{
        ActorType, AuditActor, AuditEvent, AuditEventFields, AuditMetadata, AuditResult,
        AuditScope, AuditTarget, AuditWriter, ScopeType,
    },
    database::{DatabaseError, DatabasePool},
    identity::{Timestamp, UserId},
    object_storage::S3ObjectStore,
    policy::EffectivePolicyEngine,
    project::{
        NewProject, Project, ProjectAuditContext, ProjectConflict, ProjectId, ProjectName,
        ProjectOwner, ProjectRepository, ProjectRepositoryError, ProjectSlug,
    },
    save::{CanonicalBundleMaterializer, CanonicalBundleRecord, MaterializationError},
    workspace::StorageScopeId,
};

use super::PublishedExamplePublicId;

const MIN_TIMEOUT: Duration = Duration::from_millis(100);
const MAX_TIMEOUT: Duration = Duration::from_secs(120);
const DEFAULT_TIMEOUT: Duration = Duration::from_secs(120);
const MIN_IDEMPOTENCY_KEY_BYTES: usize = 8;
const MAX_IDEMPOTENCY_KEY_BYTES: usize = 128;

type ExistingForkRow = (
    String,
    Option<i64>,
    Option<String>,
    Option<String>,
    String,
    String,
    String,
    i64,
);
type UsageRow = (String, String, bool);
#[derive(Debug, PartialEq, Eq)]
struct SourceBundle {
    example_id: String,
    example_version_id: String,
    version_number: i64,
    bundle_id: String,
    project_id: ProjectId,
    storage_scope_id: StorageScopeId,
    sha256: [u8; 32],
    object_key: String,
    physical_bytes: u64,
}

struct NewForkRecord<'a> {
    fork_id: Uuid,
    project_id: ProjectId,
    storage_scope_id: StorageScopeId,
    request: &'a ForkPublishedExample,
    source: &'a SourceBundle,
    destination_bundle_id: &'a str,
    canonical_materialization_id: Uuid,
}

#[derive(Clone, PartialEq, Eq, Hash)]
pub struct PublishedExampleForkKey(String);

impl PublishedExampleForkKey {
    pub fn new(value: String) -> Result<Self, PublishedExampleForkError> {
        if !(MIN_IDEMPOTENCY_KEY_BYTES..=MAX_IDEMPOTENCY_KEY_BYTES).contains(&value.len())
            || !value.bytes().all(|byte| {
                byte.is_ascii_alphanumeric() || matches!(byte, b'.' | b'_' | b':' | b'-')
            })
        {
            return Err(PublishedExampleForkError::InvalidInput);
        }
        Ok(Self(value))
    }

    #[must_use]
    pub fn as_str(&self) -> &str {
        &self.0
    }

    fn digest(&self) -> [u8; 32] {
        Sha256::digest(self.0.as_bytes()).into()
    }
}

impl fmt::Debug for PublishedExampleForkKey {
    fn fmt(&self, formatter: &mut fmt::Formatter<'_>) -> fmt::Result {
        formatter.write_str("PublishedExampleForkKey([redacted])")
    }
}

#[derive(Clone, Debug, PartialEq, Eq)]
pub struct ForkPublishedExample {
    pub actor_user_id: UserId,
    pub source_public_id: PublishedExamplePublicId,
    /// `None` selects the active version atomically. `Some` selects a fixed
    /// immutable public version URL.
    pub source_version_number: Option<i64>,
    pub destination_owner: ProjectOwner,
    pub destination_slug: ProjectSlug,
    pub destination_name: ProjectName,
    pub idempotency_key: PublishedExampleForkKey,
}

#[derive(Clone, Debug, PartialEq, Eq)]
pub struct PublishedExampleForkResult {
    project: Project,
    source_version_number: i64,
    idempotent_retry: bool,
}

impl PublishedExampleForkResult {
    #[must_use]
    pub const fn project(&self) -> &Project {
        &self.project
    }

    #[must_use]
    pub const fn source_version_number(&self) -> i64 {
        self.source_version_number
    }

    #[must_use]
    pub const fn is_idempotent_retry(&self) -> bool {
        self.idempotent_retry
    }
}

#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub struct PublishedExampleForkPolicy {
    operation_timeout: Duration,
}

impl PublishedExampleForkPolicy {
    pub fn new(operation_timeout: Duration) -> Result<Self, PublishedExampleForkError> {
        if !(MIN_TIMEOUT..=MAX_TIMEOUT).contains(&operation_timeout) {
            return Err(PublishedExampleForkError::InvalidInput);
        }
        Ok(Self { operation_timeout })
    }
}

impl Default for PublishedExampleForkPolicy {
    fn default() -> Self {
        Self {
            operation_timeout: DEFAULT_TIMEOUT,
        }
    }
}

#[derive(Clone, Copy, Debug, PartialEq, Eq)]
#[non_exhaustive]
pub enum PublishedExampleForkError {
    InvalidInput,
    ActorUnavailable,
    Forbidden,
    SourceUnavailable,
    NamespaceUnavailable,
    QuotaExceeded,
    IdempotencyConflict,
    ResultUnavailable,
    AuditUnavailable,
    DatabaseUnavailable,
    OperationTimeout,
    CommitOutcomeUnknown,
    InvariantViolation,
}

impl fmt::Display for PublishedExampleForkError {
    fn fmt(&self, formatter: &mut fmt::Formatter<'_>) -> fmt::Result {
        formatter.write_str(match self {
            Self::InvalidInput => "Published Example fork input is invalid",
            Self::ActorUnavailable => "Published Example fork actor is unavailable",
            Self::Forbidden => "Published Example fork destination is forbidden",
            Self::SourceUnavailable => "Published Example source is unavailable",
            Self::NamespaceUnavailable => "Published Example fork namespace is unavailable",
            Self::QuotaExceeded => "Published Example fork exceeds Workspace storage quota",
            Self::IdempotencyConflict => "Published Example fork idempotency key conflicts",
            Self::ResultUnavailable => "Published Example fork result is no longer available",
            Self::AuditUnavailable => "Published Example fork audit persistence is unavailable",
            Self::DatabaseUnavailable => "Published Example fork persistence is unavailable",
            Self::OperationTimeout => "Published Example fork operation timed out",
            Self::CommitOutcomeUnknown => "Published Example fork commit outcome is unknown",
            Self::InvariantViolation => "Published Example fork persistence state is invalid",
        })
    }
}

impl std::error::Error for PublishedExampleForkError {}

#[derive(Clone)]
pub struct PublishedExampleForkService {
    pool: DatabasePool,
    materializer: CanonicalBundleMaterializer,
    policy: PublishedExampleForkPolicy,
}

impl fmt::Debug for PublishedExampleForkService {
    fn fmt(&self, formatter: &mut fmt::Formatter<'_>) -> fmt::Result {
        formatter
            .debug_struct("PublishedExampleForkService")
            .field("policy", &self.policy)
            .finish_non_exhaustive()
    }
}

impl PublishedExampleForkService {
    #[must_use]
    pub fn new(
        pool: DatabasePool,
        store: S3ObjectStore,
        policy: PublishedExampleForkPolicy,
    ) -> Self {
        Self {
            materializer: CanonicalBundleMaterializer::new(pool.clone(), store),
            pool,
            policy,
        }
    }

    pub async fn fork(
        &self,
        request: ForkPublishedExample,
        audit: &ProjectAuditContext,
    ) -> Result<PublishedExampleForkResult, PublishedExampleForkError> {
        if request.source_version_number.is_some_and(|value| value < 1)
            || request.actor_user_id != audit.actor_user_id()
        {
            return Err(PublishedExampleForkError::InvalidInput);
        }
        time::timeout(
            self.policy.operation_timeout,
            self.fork_inner(request, audit),
        )
        .await
        .map_err(|_| PublishedExampleForkError::OperationTimeout)?
    }

    async fn fork_inner(
        &self,
        request: ForkPublishedExample,
        audit: &ProjectAuditContext,
    ) -> Result<PublishedExampleForkResult, PublishedExampleForkError> {
        // Phase one only captures an authorized, immutable source descriptor.
        // Network and archive work must never run while database locks are held.
        let mut connection = self.pool.acquire().await.map_err(map_database_error)?;
        let mut transaction = connection.begin().await.map_err(map_sql_error)?;
        configure_transaction(&mut transaction, self.policy.operation_timeout).await?;
        lock_idempotency_key(&mut transaction, &request).await?;
        if let Some(row) = load_existing_fork(&mut transaction, &request).await? {
            let result = finish_existing_fork(&mut transaction, &request, row).await;
            transaction.rollback().await.map_err(map_sql_error)?;
            return result;
        }
        let storage_scope_id = authorize_destination(
            &mut transaction,
            request.actor_user_id,
            request.destination_owner,
        )
        .await?;
        let source = resolve_source(&mut transaction, &request).await?;
        transaction.rollback().await.map_err(map_sql_error)?;

        let project_id = ProjectId::new();
        let fork_id = Uuid::now_v7();
        let snapshot = self
            .materializer
            .load_verified_snapshot(
                source.project_id,
                source.storage_scope_id,
                &source.object_key,
                source.physical_bytes,
                &source.sha256,
            )
            .await
            .map_err(map_materialization_error)?;
        let prepared = self
            .materializer
            .prepare(project_id, storage_scope_id, &snapshot)
            .await
            .map_err(map_materialization_error)?;
        let persisted = self
            .materializer
            .persist(prepared)
            .await
            .map_err(map_materialization_error)?;

        // Phase two serializes the idempotency winner, re-authorizes the
        // destination and revalidates the exact publication snapshot before
        // atomically exposing the destination Bundle and Working Head.
        let mut connection = self.pool.acquire().await.map_err(map_database_error)?;
        let mut transaction = connection.begin().await.map_err(map_sql_error)?;
        configure_transaction(&mut transaction, self.policy.operation_timeout).await?;
        lock_idempotency_key(&mut transaction, &request).await?;
        if let Some(row) = load_existing_fork(&mut transaction, &request).await? {
            let result = finish_existing_fork(&mut transaction, &request, row).await;
            transaction.rollback().await.map_err(map_sql_error)?;
            // The losing upload remains in the durable `uploaded` ledger state
            // for the normal orphan cleanup worker; deleting it here could race
            // a deduplicated winner.
            return result;
        }
        let final_scope = authorize_destination(
            &mut transaction,
            request.actor_user_id,
            request.destination_owner,
        )
        .await?;
        if final_scope != storage_scope_id {
            return Err(PublishedExampleForkError::InvariantViolation);
        }
        lock_storage_scope(&mut transaction, storage_scope_id).await?;
        let final_source = resolve_source(&mut transaction, &request).await?;
        if final_source != source {
            return Err(PublishedExampleForkError::SourceUnavailable);
        }
        let bundle = self
            .materializer
            .ensure_verified_bundle(&mut transaction, &persisted)
            .await
            .map_err(map_materialization_error)?;
        let now = transaction_now(&mut transaction).await?;
        let result = complete_new_fork(
            &mut transaction,
            &request,
            audit,
            now,
            project_id,
            fork_id,
            storage_scope_id,
            &source,
            &bundle,
            persisted.ledger_id(),
        )
        .await?;
        self.materializer
            .finalize_ledger(&mut transaction, &persisted)
            .await
            .map_err(map_materialization_error)?;
        transaction.commit().await.map_err(map_commit_error)?;
        Ok(result)
    }
}

#[allow(
    clippy::too_many_arguments,
    reason = "atomic fork transaction keeps every identity fence explicit"
)]
async fn complete_new_fork(
    transaction: &mut Transaction<'_, Postgres>,
    request: &ForkPublishedExample,
    audit: &ProjectAuditContext,
    now: Timestamp,
    project_id: ProjectId,
    fork_id: Uuid,
    storage_scope_id: StorageScopeId,
    source: &SourceBundle,
    bundle: &CanonicalBundleRecord,
    canonical_materialization_id: Uuid,
) -> Result<PublishedExampleForkResult, PublishedExampleForkError> {
    enforce_quota(
        transaction,
        storage_scope_id,
        matches!(request.destination_owner, ProjectOwner::Organization(_)),
        u64::try_from(bundle.physical_bytes)
            .map_err(|_| PublishedExampleForkError::InvariantViolation)?,
    )
    .await?;
    let candidate = NewProject::new(
        project_id,
        request.destination_owner,
        storage_scope_id,
        request.destination_slug.clone(),
        request.destination_name.clone(),
        now,
    );
    ProjectRepository::create(transaction, &candidate)
        .await
        .map_err(map_project_repository_error)?;
    insert_fork_operation(
        transaction,
        NewForkRecord {
            fork_id,
            project_id,
            storage_scope_id,
            request,
            source,
            destination_bundle_id: &bundle.id,
            canonical_materialization_id,
        },
    )
    .await?;
    insert_destination_admission(
        transaction,
        project_id,
        storage_scope_id,
        &bundle.id,
        fork_id,
    )
    .await?;
    set_initial_working_head(transaction, project_id, &bundle.id).await?;
    let project = ProjectRepository::get_by_id(transaction, request.destination_owner, project_id)
        .await
        .map_err(map_project_repository_error)?
        .ok_or(PublishedExampleForkError::InvariantViolation)?;
    append_fork_audit(
        transaction,
        audit,
        now,
        project_id,
        request.source_public_id.as_str(),
        source.version_number,
    )
    .await?;
    Ok(PublishedExampleForkResult {
        project,
        source_version_number: source.version_number,
        idempotent_retry: false,
    })
}

async fn lock_idempotency_key(
    transaction: &mut Transaction<'_, Postgres>,
    request: &ForkPublishedExample,
) -> Result<(), PublishedExampleForkError> {
    sqlx::query(
        "SELECT pg_advisory_xact_lock(1886741358,hashtext($1 || ':' || encode($2::bytea,'hex')))",
    )
    .bind(request.actor_user_id.to_string())
    .bind(request.idempotency_key.digest().to_vec())
    .execute(&mut **transaction)
    .await
    .map_err(map_sql_error)?;
    Ok(())
}

async fn load_existing_fork(
    transaction: &mut Transaction<'_, Postgres>,
    request: &ForkPublishedExample,
) -> Result<Option<ExistingForkRow>, PublishedExampleForkError> {
    sqlx::query_as::<_, ExistingForkRow>(
        "SELECT source_public_id,requested_version_number,destination_owner_user_id::text,\
                destination_owner_organization_id::text,destination_slug,destination_name,\
                destination_project_id::text,source_version_number \
         FROM published_example_forks \
         WHERE actor_user_id=$1::uuid AND idempotency_digest=$2::bytea FOR SHARE",
    )
    .bind(request.actor_user_id.to_string())
    .bind(request.idempotency_key.digest().to_vec())
    .fetch_optional(&mut **transaction)
    .await
    .map_err(map_sql_error)
}

async fn finish_existing_fork(
    transaction: &mut Transaction<'_, Postgres>,
    request: &ForkPublishedExample,
    row: ExistingForkRow,
) -> Result<PublishedExampleForkResult, PublishedExampleForkError> {
    let owner_matches = match request.destination_owner {
        ProjectOwner::User(id) => {
            row.2.as_deref() == Some(id.to_string().as_str()) && row.3.is_none()
        }
        ProjectOwner::Organization(id) => {
            row.2.is_none() && row.3.as_deref() == Some(id.to_string().as_str())
        }
    };
    if row.0 != request.source_public_id.as_str()
        || row.1 != request.source_version_number
        || !owner_matches
        || row.4 != request.destination_slug.as_str()
        || row.5 != request.destination_name.as_str()
    {
        return Err(PublishedExampleForkError::IdempotencyConflict);
    }
    // A retry is not an authorization bypass. The source may have been
    // unpublished or deleted after a successful fork, but the actor must still
    // be allowed to use the destination Workspace.
    authorize_destination(
        transaction,
        request.actor_user_id,
        request.destination_owner,
    )
    .await?;
    let project_id = row
        .6
        .parse()
        .map_err(|_| PublishedExampleForkError::InvariantViolation)?;
    let project = ProjectRepository::get_by_id(transaction, request.destination_owner, project_id)
        .await
        .map_err(map_project_repository_error)?
        .ok_or(PublishedExampleForkError::ResultUnavailable)?;
    Ok(PublishedExampleForkResult {
        project,
        source_version_number: row.7,
        idempotent_retry: true,
    })
}

async fn authorize_destination(
    transaction: &mut Transaction<'_, Postgres>,
    actor_user_id: UserId,
    owner: ProjectOwner,
) -> Result<StorageScopeId, PublishedExampleForkError> {
    let actor_status: Option<String> =
        sqlx::query_scalar("SELECT status FROM users WHERE id=$1::uuid FOR SHARE")
            .bind(actor_user_id.to_string())
            .fetch_optional(&mut **transaction)
            .await
            .map_err(map_sql_error)?;
    if actor_status.as_deref() != Some("active") {
        return Err(PublishedExampleForkError::ActorUnavailable);
    }
    let scope: Option<String> = match owner {
        ProjectOwner::User(owner_user_id) => {
            if owner_user_id != actor_user_id {
                return Err(PublishedExampleForkError::Forbidden);
            }
            sqlx::query_scalar(
                "SELECT id::text FROM storage_scopes \
                 WHERE owner_user_id=$1::uuid AND owner_organization_id IS NULL FOR SHARE",
            )
            .bind(owner_user_id.to_string())
            .fetch_optional(&mut **transaction)
            .await
        }
        ProjectOwner::Organization(organization_id) => {
            let organization_status: Option<String> =
                sqlx::query_scalar("SELECT status FROM organizations WHERE id=$1::uuid FOR SHARE")
                    .bind(organization_id.to_string())
                    .fetch_optional(&mut **transaction)
                    .await
                    .map_err(map_sql_error)?;
            if organization_status.as_deref() != Some("active") {
                return Err(PublishedExampleForkError::Forbidden);
            }
            let role: Option<String> = sqlx::query_scalar(
                "SELECT role FROM organization_memberships \
                 WHERE organization_id=$1::uuid AND user_id=$2::uuid FOR SHARE",
            )
            .bind(organization_id.to_string())
            .bind(actor_user_id.to_string())
            .fetch_optional(&mut **transaction)
            .await
            .map_err(map_sql_error)?;
            if role.as_deref() != Some("owner") {
                return Err(PublishedExampleForkError::Forbidden);
            }
            sqlx::query_scalar(
                "SELECT id::text FROM storage_scopes \
                 WHERE owner_organization_id=$1::uuid AND owner_user_id IS NULL FOR SHARE",
            )
            .bind(organization_id.to_string())
            .fetch_optional(&mut **transaction)
            .await
        }
    }
    .map_err(map_sql_error)?;
    scope
        .ok_or(PublishedExampleForkError::InvariantViolation)?
        .parse()
        .map_err(|_| PublishedExampleForkError::InvariantViolation)
}

async fn lock_storage_scope(
    transaction: &mut Transaction<'_, Postgres>,
    storage_scope_id: StorageScopeId,
) -> Result<(), PublishedExampleForkError> {
    let found: Option<String> =
        sqlx::query_scalar("SELECT id::text FROM storage_scopes WHERE id=$1::uuid FOR UPDATE")
            .bind(storage_scope_id.to_string())
            .fetch_optional(&mut **transaction)
            .await
            .map_err(map_sql_error)?;
    found
        .map(|_| ())
        .ok_or(PublishedExampleForkError::InvariantViolation)
}

async fn resolve_source(
    transaction: &mut Transaction<'_, Postgres>,
    request: &ForkPublishedExample,
) -> Result<SourceBundle, PublishedExampleForkError> {
    type Row = (
        String,
        String,
        i64,
        String,
        String,
        String,
        Vec<u8>,
        String,
        i64,
    );
    let row = sqlx::query_as::<_, Row>(
        "SELECT example.id::text,version.id::text,version.version_number,\
                reference.bundle_id::text,version.project_id::text,\
                reference.storage_scope_id::text,bundle.sha256,bundle.object_key,\
                bundle.physical_bytes \
         FROM published_examples example \
         JOIN published_example_versions version ON version.example_id=example.id \
         JOIN project_bundle_refs reference ON reference.id=version.project_version_id \
              AND reference.project_id=version.project_id AND reference.kind='version' \
         JOIN bundles bundle ON bundle.id=reference.bundle_id \
              AND bundle.verification_state='verified' AND bundle.format='project-bundle-v1' \
         WHERE example.public_id=$1 AND example.state='published' \
           AND (($2::bigint IS NULL AND version.id=example.active_version_id) \
                OR version.version_number=$2) \
         FOR SHARE OF example,version,reference,bundle",
    )
    .bind(request.source_public_id.as_str())
    .bind(request.source_version_number)
    .fetch_optional(&mut **transaction)
    .await
    .map_err(map_sql_error)?
    .ok_or(PublishedExampleForkError::SourceUnavailable)?;
    let sha256: [u8; 32] = row
        .6
        .try_into()
        .map_err(|_| PublishedExampleForkError::InvariantViolation)?;
    Ok(SourceBundle {
        example_id: row.0,
        example_version_id: row.1,
        version_number: row.2,
        bundle_id: row.3,
        project_id: row
            .4
            .parse()
            .map_err(|_| PublishedExampleForkError::InvariantViolation)?,
        storage_scope_id: row
            .5
            .parse()
            .map_err(|_| PublishedExampleForkError::InvariantViolation)?,
        sha256,
        object_key: row.7,
        physical_bytes: u64::try_from(row.8)
            .map_err(|_| PublishedExampleForkError::InvariantViolation)?,
    })
}

async fn enforce_quota(
    transaction: &mut Transaction<'_, Postgres>,
    storage_scope_id: StorageScopeId,
    organization: bool,
    destination_physical_bytes: u64,
) -> Result<(), PublishedExampleForkError> {
    let quota = EffectivePolicyEngine::load_in_transaction(transaction)
        .await
        .map_err(|_| PublishedExampleForkError::InvariantViolation)?
        .workspace_quota(organization)
        .map_err(|_| PublishedExampleForkError::InvariantViolation)?;
    let row: UsageRow = sqlx::query_as(
        "WITH live_bundles AS ( \
             SELECT working_head_bundle_id AS bundle_id FROM projects \
             WHERE storage_scope_id=$1::uuid AND working_head_bundle_id IS NOT NULL \
             UNION SELECT bundle_id FROM project_bundle_refs WHERE storage_scope_id=$1::uuid \
         ), usage AS ( \
             SELECT COALESCE(SUM(bundle.physical_bytes),0)::text AS bytes \
             FROM live_bundles live JOIN bundles bundle ON bundle.id=live.bundle_id \
         ), reserved AS ( \
             SELECT COALESCE(SUM(reservation.reserved_bytes),0)::text AS bytes \
             FROM storage_reservations reservation \
             JOIN save_sessions session ON session.id=reservation.save_session_id \
             WHERE reservation.storage_scope_id=$1::uuid \
               AND reservation.expires_at>transaction_timestamp() \
               AND session.state IN ('created','uploading','verifying') \
         ) SELECT usage.bytes,reserved.bytes,FALSE \
         FROM usage CROSS JOIN reserved",
    )
    .bind(storage_scope_id.to_string())
    .fetch_one(&mut **transaction)
    .await
    .map_err(map_sql_error)?;
    let used = parse_bytes(&row.0)?;
    let reserved = parse_bytes(&row.1)?;
    let projected = used
        .checked_add(reserved)
        .and_then(|value| value.checked_add(destination_physical_bytes))
        .ok_or(PublishedExampleForkError::InvariantViolation)?;
    if quota.limit_bytes().is_some_and(|limit| projected > limit) {
        return Err(PublishedExampleForkError::QuotaExceeded);
    }
    Ok(())
}

fn parse_bytes(value: &str) -> Result<u64, PublishedExampleForkError> {
    value
        .parse()
        .map_err(|_| PublishedExampleForkError::InvariantViolation)
}

async fn insert_fork_operation(
    transaction: &mut Transaction<'_, Postgres>,
    record: NewForkRecord<'_>,
) -> Result<(), PublishedExampleForkError> {
    let (owner_user_id, owner_organization_id) = match record.request.destination_owner {
        ProjectOwner::User(id) => (Some(id.to_string()), None),
        ProjectOwner::Organization(id) => (None, Some(id.to_string())),
    };
    sqlx::query(
        "INSERT INTO published_example_forks \
         (id,actor_user_id,idempotency_digest,source_public_id,source_example_id,\
          source_example_version_id,source_version_number,requested_version_number,source_bundle_id,\
          destination_bundle_id,canonical_materialization_id,\
          destination_project_id,destination_owner_user_id,destination_owner_organization_id,\
          destination_storage_scope_id,destination_slug,destination_name) \
         VALUES($1::uuid,$2::uuid,$3,$4,$5::uuid,$6::uuid,$7,$8,$9::uuid,$10::uuid,\
                $11::uuid,$12::uuid,$13::uuid,$14::uuid,$15::uuid,$16,$17)",
    )
    .bind(record.fork_id.to_string())
    .bind(record.request.actor_user_id.to_string())
    .bind(record.request.idempotency_key.digest().to_vec())
    .bind(record.request.source_public_id.as_str())
    .bind(&record.source.example_id)
    .bind(&record.source.example_version_id)
    .bind(record.source.version_number)
    .bind(record.request.source_version_number)
    .bind(&record.source.bundle_id)
    .bind(record.destination_bundle_id)
    .bind(record.canonical_materialization_id.to_string())
    .bind(record.project_id.to_string())
    .bind(owner_user_id)
    .bind(owner_organization_id)
    .bind(record.storage_scope_id.to_string())
    .bind(record.request.destination_slug.as_str())
    .bind(record.request.destination_name.as_str())
    .execute(&mut **transaction)
    .await
    .map_err(map_sql_error)?;
    Ok(())
}

async fn insert_destination_admission(
    transaction: &mut Transaction<'_, Postgres>,
    project_id: ProjectId,
    storage_scope_id: StorageScopeId,
    bundle_id: &str,
    fork_id: Uuid,
) -> Result<(), PublishedExampleForkError> {
    sqlx::query(
        "INSERT INTO project_bundle_admissions \
         (project_id,storage_scope_id,bundle_id,source_save_session_id,save_session_id,\
          source_published_example_fork_id) \
         VALUES($1::uuid,$2::uuid,$3::uuid,NULL,NULL,$4::uuid)",
    )
    .bind(project_id.to_string())
    .bind(storage_scope_id.to_string())
    .bind(bundle_id)
    .bind(fork_id.to_string())
    .execute(&mut **transaction)
    .await
    .map_err(map_sql_error)?;
    Ok(())
}

async fn set_initial_working_head(
    transaction: &mut Transaction<'_, Postgres>,
    project_id: ProjectId,
    bundle_id: &str,
) -> Result<(), PublishedExampleForkError> {
    let result = sqlx::query(
        "UPDATE projects SET working_head_bundle_id=$2::uuid,lock_version=lock_version+1,\
                updated_at=transaction_timestamp() \
         WHERE id=$1::uuid AND working_head_bundle_id IS NULL AND lock_version=1 AND state='active'",
    )
    .bind(project_id.to_string())
    .bind(bundle_id)
    .execute(&mut **transaction)
    .await
    .map_err(map_sql_error)?;
    if result.rows_affected() != 1 {
        return Err(PublishedExampleForkError::InvariantViolation);
    }
    Ok(())
}

async fn append_fork_audit(
    transaction: &mut Transaction<'_, Postgres>,
    audit: &ProjectAuditContext,
    occurred_at: Timestamp,
    project_id: ProjectId,
    source_public_id: &str,
    source_version_number: i64,
) -> Result<(), PublishedExampleForkError> {
    let event = AuditEvent::new(AuditEventFields {
        id: audit.event_id(),
        occurred_at,
        actor: AuditActor {
            kind: ActorType::User,
            id: audit.actor_user_id().to_string(),
            user_id: Some(audit.actor_user_id()),
            display_name: audit.actor_display_name(),
        },
        action_code: "project.forked".into(),
        target: AuditTarget {
            kind: "project".into(),
            id: project_id.to_string(),
        },
        scope: AuditScope {
            kind: ScopeType::Project,
            id: project_id.to_string(),
        },
        result: AuditResult::Succeeded,
        reason_code: None,
        correlation_id: audit.correlation_id(),
        source_ip: audit.source_ip(),
        schema_version: 1,
        changed_fields: vec![
            "project".into(),
            "working_head_bundle_id".into(),
            "lock_version".into(),
        ],
        metadata: AuditMetadata::new(json!({
            "source": "published-example",
            "sourcePublicId": source_public_id,
            "sourceVersionNumber": source_version_number
        }))
        .map_err(|_| PublishedExampleForkError::InvariantViolation)?,
    })
    .map_err(|_| PublishedExampleForkError::InvalidInput)?;
    AuditWriter::append(transaction, &event)
        .await
        .map_err(|_| PublishedExampleForkError::AuditUnavailable)
}

async fn transaction_now(
    transaction: &mut Transaction<'_, Postgres>,
) -> Result<Timestamp, PublishedExampleForkError> {
    let value: OffsetDateTime = sqlx::query_scalar("SELECT transaction_timestamp()")
        .fetch_one(&mut **transaction)
        .await
        .map_err(map_sql_error)?;
    Timestamp::from_datetime(value).map_err(|_| PublishedExampleForkError::InvariantViolation)
}

async fn configure_transaction(
    transaction: &mut Transaction<'_, Postgres>,
    timeout: Duration,
) -> Result<(), PublishedExampleForkError> {
    let millis = timeout.as_millis().max(1);
    sqlx::query(
        "SELECT set_config('statement_timeout',$1,true),set_config('lock_timeout',$1,true)",
    )
    .bind(format!("{millis}ms"))
    .execute(&mut **transaction)
    .await
    .map_err(map_sql_error)?;
    Ok(())
}

fn map_database_error(error: DatabaseError) -> PublishedExampleForkError {
    match error {
        DatabaseError::AcquireTimeout => PublishedExampleForkError::OperationTimeout,
        _ => PublishedExampleForkError::DatabaseUnavailable,
    }
}

fn map_project_repository_error(error: ProjectRepositoryError) -> PublishedExampleForkError {
    match error {
        ProjectRepositoryError::Conflict(ProjectConflict::IdentifierExists)
        | ProjectRepositoryError::Conflict(ProjectConflict::NamespaceUnavailable) => {
            PublishedExampleForkError::NamespaceUnavailable
        }
        ProjectRepositoryError::Conflict(ProjectConflict::OwnerScopeMismatch)
        | ProjectRepositoryError::InvalidPersistedState => {
            PublishedExampleForkError::InvariantViolation
        }
        ProjectRepositoryError::OperationTimeout => PublishedExampleForkError::OperationTimeout,
        ProjectRepositoryError::PersistenceUnavailable
        | ProjectRepositoryError::InvalidPageLimit => {
            PublishedExampleForkError::DatabaseUnavailable
        }
    }
}

fn map_sql_error(error: sqlx::Error) -> PublishedExampleForkError {
    match error
        .as_database_error()
        .and_then(|database| database.code())
        .as_deref()
    {
        Some("57014" | "55P03") => PublishedExampleForkError::OperationTimeout,
        Some("23505") => PublishedExampleForkError::NamespaceUnavailable,
        Some("23503" | "23514") => PublishedExampleForkError::InvariantViolation,
        _ => PublishedExampleForkError::DatabaseUnavailable,
    }
}

fn map_commit_error(error: sqlx::Error) -> PublishedExampleForkError {
    if error.as_database_error().is_some() {
        map_sql_error(error)
    } else {
        PublishedExampleForkError::CommitOutcomeUnknown
    }
}

fn map_materialization_error(error: MaterializationError) -> PublishedExampleForkError {
    match error {
        MaterializationError::InvalidBundle => PublishedExampleForkError::SourceUnavailable,
        MaterializationError::Storage => PublishedExampleForkError::DatabaseUnavailable,
        MaterializationError::Database => PublishedExampleForkError::DatabaseUnavailable,
        MaterializationError::GcFenced => PublishedExampleForkError::InvariantViolation,
    }
}
