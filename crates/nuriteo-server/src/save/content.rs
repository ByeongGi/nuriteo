use std::fmt;
use std::pin::Pin;
use std::time::Duration;

use base64::Engine as _;
use base64::engine::general_purpose::URL_SAFE_NO_PAD;
use serde::Serialize;
use sqlx::Acquire;
use tokio::time;
use utoipa::ToSchema;
use uuid::{Uuid, Variant, Version};

use crate::database::DatabasePool;
use crate::identity::UserId;
use crate::object_storage::{ObjectKey, ObjectStoreErrorKind, S3ObjectStore};
use crate::project::{
    EffectiveProjectRole, ProjectAccessError, ProjectAccessRepository, ProjectId, ProjectOwner,
};

const MIN_OPERATION_TIMEOUT: Duration = Duration::from_millis(100);
const MAX_OPERATION_TIMEOUT: Duration = Duration::from_secs(30);

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub struct ContentServicePolicy {
    operation_timeout: Duration,
}

impl ContentServicePolicy {
    pub fn new(operation_timeout: Duration) -> Result<Self, ContentError> {
        if !(MIN_OPERATION_TIMEOUT..=MAX_OPERATION_TIMEOUT).contains(&operation_timeout) {
            return Err(ContentError::InvalidInput);
        }
        Ok(Self { operation_timeout })
    }
}

impl Default for ContentServicePolicy {
    fn default() -> Self {
        Self {
            operation_timeout: Duration::from_secs(5),
        }
    }
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize, ToSchema)]
#[serde(rename_all = "camelCase")]
pub struct ContentDescriptor {
    project_id: String,
    project_version: i64,
    bundle_id: String,
    etag: String,
    checksum_algorithm: &'static str,
    checksum: String,
    physical_bytes: u64,
    logical_bytes: u64,
    file_count: u32,
    format: &'static str,
    download_url: String,
}

impl ContentDescriptor {
    #[must_use]
    pub fn project_id(&self) -> &str {
        &self.project_id
    }

    #[must_use]
    pub const fn project_version(&self) -> i64 {
        self.project_version
    }

    #[must_use]
    pub fn bundle_id(&self) -> &str {
        &self.bundle_id
    }

    #[must_use]
    pub fn etag(&self) -> &str {
        &self.etag
    }

    #[must_use]
    pub fn checksum(&self) -> &str {
        &self.checksum
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
    pub fn download_url(&self) -> &str {
        &self.download_url
    }
}

pub struct ContentDownload {
    descriptor: ContentDescriptor,
    reader: Pin<Box<dyn tokio::io::AsyncRead + Send>>,
}

impl ContentDownload {
    #[must_use]
    pub const fn descriptor(&self) -> &ContentDescriptor {
        &self.descriptor
    }

    #[must_use]
    pub fn into_parts(self) -> (ContentDescriptor, Pin<Box<dyn tokio::io::AsyncRead + Send>>) {
        (self.descriptor, self.reader)
    }
}

impl fmt::Debug for ContentDownload {
    fn fmt(&self, formatter: &mut fmt::Formatter<'_>) -> fmt::Result {
        formatter
            .debug_struct("ContentDownload")
            .field("descriptor", &self.descriptor)
            .field("reader", &"[BOUNDED STREAM]")
            .finish()
    }
}

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
#[non_exhaustive]
pub enum ContentError {
    InvalidInput,
    Unauthorized,
    NotFound,
    ProjectUnavailable,
    NoWorkingHead,
    StaleDescriptor,
    ObjectUnavailable,
    ObjectMismatch,
    OperationTimeout,
    PersistenceUnavailable,
    InvariantViolation,
}

impl fmt::Display for ContentError {
    fn fmt(&self, formatter: &mut fmt::Formatter<'_>) -> fmt::Result {
        formatter.write_str(match self {
            Self::InvalidInput => "content request is invalid",
            Self::Unauthorized => "content request is unauthorized",
            Self::NotFound => "content resource was not found",
            Self::ProjectUnavailable => "project content is unavailable",
            Self::NoWorkingHead => "project content has no Working Head",
            Self::StaleDescriptor => "content descriptor is stale",
            Self::ObjectUnavailable => "content object is unavailable",
            Self::ObjectMismatch => "content object does not match verified metadata",
            Self::OperationTimeout => "content operation timed out",
            Self::PersistenceUnavailable => "content persistence is unavailable",
            Self::InvariantViolation => "content persistence state is invalid",
        })
    }
}

impl std::error::Error for ContentError {}

#[derive(Clone)]
pub struct ContentService {
    pool: DatabasePool,
    store: S3ObjectStore,
    policy: ContentServicePolicy,
}

impl fmt::Debug for ContentService {
    fn fmt(&self, formatter: &mut fmt::Formatter<'_>) -> fmt::Result {
        formatter
            .debug_struct("ContentService")
            .field("policy", &self.policy)
            .finish_non_exhaustive()
    }
}

impl ContentService {
    #[must_use]
    pub const fn new(
        pool: DatabasePool,
        store: S3ObjectStore,
        policy: ContentServicePolicy,
    ) -> Self {
        Self {
            pool,
            store,
            policy,
        }
    }

    pub async fn describe(
        &self,
        actor: UserId,
        owner: ProjectOwner,
        project_id: ProjectId,
    ) -> Result<ContentDescriptor, ContentError> {
        self.load_bounded(actor, owner, project_id)
            .await
            .map(|loaded| loaded.descriptor)
    }

    pub async fn download(
        &self,
        actor: UserId,
        owner: ProjectOwner,
        project_id: ProjectId,
        expected_bundle_id: &str,
        expected_etag: &str,
    ) -> Result<ContentDownload, ContentError> {
        validate_bundle_id(expected_bundle_id)?;
        let loaded = self.load_bounded(actor, owner, project_id).await?;
        let descriptor = loaded.descriptor;
        if descriptor.bundle_id != expected_bundle_id || descriptor.etag != expected_etag {
            return Err(ContentError::StaleDescriptor);
        }

        // The permanent key came from the same transaction that authorized
        // the actor and fenced the exact active Working Head/admission.
        let key =
            ObjectKey::parse(loaded.object_key).map_err(|_| ContentError::InvariantViolation)?;
        let stream = time::timeout(
            self.policy.operation_timeout,
            self.store.get_stream(&key, descriptor.physical_bytes),
        )
        .await
        .map_err(|_| ContentError::OperationTimeout)?
        .map_err(map_store_error)?;
        if stream.metadata.content_length != descriptor.physical_bytes {
            return Err(ContentError::ObjectMismatch);
        }
        Ok(ContentDownload {
            descriptor,
            reader: stream.reader,
        })
    }

    async fn load_bounded(
        &self,
        actor: UserId,
        owner: ProjectOwner,
        project_id: ProjectId,
    ) -> Result<LoadedContent, ContentError> {
        time::timeout(
            self.policy.operation_timeout,
            load_descriptor(&self.pool, actor, owner, project_id),
        )
        .await
        .map_err(|_| ContentError::OperationTimeout)?
    }
}

type ContentRow = (
    Option<String>,
    Option<String>,
    String,
    i64,
    String,
    Vec<u8>,
    i64,
    i64,
    i32,
    String,
    String,
);

struct LoadedContent {
    descriptor: ContentDescriptor,
    object_key: String,
}

async fn load_descriptor(
    pool: &DatabasePool,
    actor: UserId,
    owner: ProjectOwner,
    project_id: ProjectId,
) -> Result<LoadedContent, ContentError> {
    let mut connection = pool
        .acquire()
        .await
        .map_err(|_| ContentError::PersistenceUnavailable)?;
    let mut transaction = connection
        .begin()
        .await
        .map_err(|_| ContentError::PersistenceUnavailable)?;
    let role = ProjectAccessRepository::resolve_effective_role(&mut transaction, project_id, actor)
        .await
        .map_err(map_access_error)?;
    if role < EffectiveProjectRole::Read {
        return Err(ContentError::Unauthorized);
    }
    let row: ContentRow = sqlx::query_as(
        "SELECT p.owner_user_id::text,p.owner_organization_id::text,p.state,p.lock_version,\
                b.id::text,b.sha256,b.physical_bytes,b.logical_bytes,b.file_count,b.format,b.object_key \
         FROM projects p \
         JOIN project_bundle_admissions a ON a.project_id=p.id \
            AND a.storage_scope_id=p.storage_scope_id \
            AND a.bundle_id=p.working_head_bundle_id \
         JOIN bundles b ON b.id=a.bundle_id AND b.verification_state='verified' \
         WHERE p.id=$1::uuid",
    )
    .bind(project_id.to_string())
    .fetch_optional(&mut *transaction)
    .await
    .map_err(|_| ContentError::PersistenceUnavailable)?
    .ok_or(ContentError::NoWorkingHead)?;
    let (owner_user_id, owner_organization_id) = owner_columns(owner);
    if (owner_user_id.as_deref(), owner_organization_id.as_deref())
        != (row.0.as_deref(), row.1.as_deref())
    {
        return Err(ContentError::NotFound);
    }
    if row.2 != "active" {
        return Err(ContentError::ProjectUnavailable);
    }
    let object_key = row.10.clone();
    let descriptor = decode_descriptor(owner, project_id, row)?;
    transaction
        .commit()
        .await
        .map_err(|_| ContentError::PersistenceUnavailable)?;
    Ok(LoadedContent {
        descriptor,
        object_key,
    })
}

fn decode_descriptor(
    owner: ProjectOwner,
    project_id: ProjectId,
    row: ContentRow,
) -> Result<ContentDescriptor, ContentError> {
    let digest: [u8; 32] = row
        .5
        .try_into()
        .map_err(|_| ContentError::InvariantViolation)?;
    validate_bundle_id(&row.4)?;
    let physical_bytes = u64::try_from(row.6).map_err(|_| ContentError::InvariantViolation)?;
    let logical_bytes = u64::try_from(row.7).map_err(|_| ContentError::InvariantViolation)?;
    let file_count = u32::try_from(row.8).map_err(|_| ContentError::InvariantViolation)?;
    if row.3 < 1
        || physical_bytes == 0
        || logical_bytes > 268_435_456
        || file_count > 2_500
        || row.9 != "project-bundle-v1"
    {
        return Err(ContentError::InvariantViolation);
    }
    let checksum = URL_SAFE_NO_PAD.encode(digest);
    let owner_type = match owner {
        ProjectOwner::User(_) => "users",
        ProjectOwner::Organization(_) => "organizations",
    };
    let owner_id = match owner {
        ProjectOwner::User(id) => id.to_string(),
        ProjectOwner::Organization(id) => id.to_string(),
    };
    let download_url = format!(
        "/api/v1/workspaces/{owner_type}/{owner_id}/projects/{project_id}/content/{}",
        row.4
    );
    Ok(ContentDescriptor {
        project_id: project_id.to_string(),
        project_version: row.3,
        bundle_id: row.4,
        etag: format!("\"content-v{}-{checksum}\"", row.3),
        checksum_algorithm: "sha-256",
        checksum,
        physical_bytes,
        logical_bytes,
        file_count,
        format: "project-bundle-v1",
        download_url,
    })
}

fn validate_bundle_id(value: &str) -> Result<(), ContentError> {
    let id = Uuid::parse_str(value).map_err(|_| ContentError::InvalidInput)?;
    if id.get_version() != Some(Version::SortRand) || id.get_variant() != Variant::RFC4122 {
        return Err(ContentError::InvalidInput);
    }
    Ok(())
}

fn owner_columns(owner: ProjectOwner) -> (Option<String>, Option<String>) {
    match owner {
        ProjectOwner::User(id) => (Some(id.to_string()), None),
        ProjectOwner::Organization(id) => (None, Some(id.to_string())),
    }
}

fn map_access_error(error: ProjectAccessError) -> ContentError {
    match error {
        ProjectAccessError::ProjectUnavailable => ContentError::NotFound,
        ProjectAccessError::OperationTimeout => ContentError::OperationTimeout,
        ProjectAccessError::PersistenceUnavailable => ContentError::PersistenceUnavailable,
        _ => ContentError::InvariantViolation,
    }
}

fn map_store_error(error: crate::object_storage::ObjectStoreError) -> ContentError {
    match error.kind() {
        ObjectStoreErrorKind::NotFound => ContentError::ObjectUnavailable,
        ObjectStoreErrorKind::Timeout => ContentError::OperationTimeout,
        ObjectStoreErrorKind::Integrity | ObjectStoreErrorKind::ResponseTooLarge => {
            ContentError::ObjectMismatch
        }
        _ => ContentError::ObjectUnavailable,
    }
}
