use std::fmt;
use std::sync::Arc;
use std::time::Duration;

use ::time::OffsetDateTime;
use serde::Serialize;
use sqlx::{Acquire, Postgres, Transaction};
use tokio::io::AsyncRead;
use tokio::time;
use utoipa::ToSchema;

use crate::database::DatabasePool;
use crate::identity::{BrowserRequestHeaders, Timestamp};
use crate::object_storage::{
    BoundedPresignedRequest, PresignedOperation, S3ObjectStore, Sha256Checksum,
};
use crate::project::{
    ProjectHttpError, ProjectHttpService, ProjectId, ProjectOwner, ProjectVersion,
    SaveProjectContext,
};
use crate::quota::{EffectiveQuota, SaveSessionId};

use super::http_config::SaveUploadTransport;
use super::relay::{RelayUploadError, RelayUploadService};
use super::{
    AbortSaveSession, CleanupError, CleanupService, CleanupWorkerPolicy, CommitWorkingHeadOutcome,
    CreateMultipartSession, CreateSinglePutSession, IdempotencyKey, IdempotencySecret,
    MultipartPartPlan, MultipartPartReceipt, MultipartService, MultipartServiceError,
    MultipartServicePolicy, MultipartSessionContext, SinglePutService, SinglePutServiceError,
    SinglePutServicePolicy, StagingVerifier, StagingVerifierPolicy, VerificationError,
    VerifyStagingBundle, WorkingHeadCommitError, WorkingHeadCommitPolicy, WorkingHeadCommitService,
};

const BUNDLE_CONTENT_TYPE: &str = "application/vnd.nuriteo.project-bundle";
const RELAY_CHECKSUM_HEADER: &str = "X-Nuriteo-Content-SHA256";

fn save_session_expiry(value: OffsetDateTime) -> Result<String, SaveHttpError> {
    Timestamp::from_datetime(value)
        .map(|timestamp| timestamp.to_string())
        .map_err(|_| SaveHttpError::Internal)
}

#[derive(Debug, Clone, Copy)]
pub struct SaveHttpPolicy {
    operation_timeout: Duration,
    verification_timeout: Duration,
    presign_minutes: u16,
    single_put_threshold_bytes: u64,
    multipart_part_bytes: u64,
    multipart_issue_batch: u16,
    relay_idle_timeout: Duration,
    relay_total_timeout: Duration,
}

impl Default for SaveHttpPolicy {
    fn default() -> Self {
        Self {
            operation_timeout: Duration::from_secs(5),
            verification_timeout: Duration::from_secs(120),
            presign_minutes: 15,
            single_put_threshold_bytes: 64 * 1024 * 1024,
            multipart_part_bytes: 16 * 1024 * 1024,
            multipart_issue_batch: 16,
            relay_idle_timeout: Duration::from_secs(5),
            relay_total_timeout: Duration::from_secs(30),
        }
    }
}

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum SaveHttpError {
    AuthenticationFailed,
    Forbidden,
    NotFound,
    InvalidInput,
    Conflict,
    StaleProjectVersion,
    QuotaExceeded,
    SessionExpired,
    ReconciliationRequired,
    CommitOutcomeUnknown,
    OperationTimeout,
    Unavailable,
    Internal,
}

impl fmt::Display for SaveHttpError {
    fn fmt(&self, f: &mut fmt::Formatter<'_>) -> fmt::Result {
        f.write_str(match self {
            Self::AuthenticationFailed => "Save authentication failed",
            Self::Forbidden => "Save request is forbidden",
            Self::NotFound => "Save resource was not found",
            Self::InvalidInput => "Save request is invalid",
            Self::Conflict => "Save state conflicts with the request",
            Self::StaleProjectVersion => "Project version is stale",
            Self::QuotaExceeded => "Workspace storage quota is exceeded",
            Self::SessionExpired => "Save session has expired",
            Self::ReconciliationRequired => "Save operation requires reconciliation",
            Self::CommitOutcomeUnknown => "Save commit outcome is unknown",
            Self::OperationTimeout => "Save operation timed out",
            Self::Unavailable => "Save service is unavailable",
            Self::Internal => "Save operation failed",
        })
    }
}
impl std::error::Error for SaveHttpError {}

#[derive(Clone)]
pub struct SaveHttpService {
    runtime: Option<Arc<Runtime>>,
}
struct Runtime {
    pool: DatabasePool,
    operation_timeout: Duration,
    projects: ProjectHttpService,
    single: SinglePutService,
    multipart: MultipartService,
    relay: RelayUploadService,
    verifier: StagingVerifier,
    commit: WorkingHeadCommitService,
    cleanup: CleanupService,
    effective_quota: EffectiveQuota,
    single_put_threshold_bytes: u64,
    upload_transport: SaveUploadTransport,
}
impl fmt::Debug for SaveHttpService {
    fn fmt(&self, f: &mut fmt::Formatter<'_>) -> fmt::Result {
        f.debug_struct("SaveHttpService")
            .field("configured", &self.runtime.is_some())
            .finish()
    }
}

impl SaveHttpService {
    #[must_use]
    pub const fn unconfigured() -> Self {
        Self { runtime: None }
    }

    #[allow(
        clippy::too_many_arguments,
        reason = "production assembly keeps security policies explicit"
    )]
    pub async fn production(
        pool: DatabasePool,
        projects: ProjectHttpService,
        store: S3ObjectStore,
        secret: IdempotencySecret,
        effective_quota: EffectiveQuota,
        upload_transport: SaveUploadTransport,
        policy: SaveHttpPolicy,
        cleanup_policy: CleanupWorkerPolicy,
    ) -> Result<Self, SaveHttpError> {
        let single_policy =
            SinglePutServicePolicy::new(policy.operation_timeout, policy.presign_minutes)
                .map_err(|_| SaveHttpError::InvalidInput)?;
        let multipart_policy = MultipartServicePolicy::new(
            policy.operation_timeout,
            policy.presign_minutes,
            policy.single_put_threshold_bytes,
            policy.multipart_part_bytes,
            policy.multipart_issue_batch,
        )
        .map_err(|_| SaveHttpError::InvalidInput)?;
        let verifier_policy = StagingVerifierPolicy::new(policy.verification_timeout)
            .map_err(|_| SaveHttpError::InvalidInput)?;
        let commit_policy = WorkingHeadCommitPolicy::new(policy.verification_timeout)
            .map_err(|_| SaveHttpError::InvalidInput)?;
        let single =
            SinglePutService::new_live(pool.clone(), store.clone(), single_policy, secret.clone())
                .map_err(map_single)?;
        single
            .validate_idempotency_configuration()
            .await
            .map_err(map_single)?;
        let multipart =
            MultipartService::new_live(pool.clone(), store.clone(), multipart_policy, secret)
                .map_err(|_| SaveHttpError::InvalidInput)?;
        let relay = RelayUploadService::new(
            pool.clone(),
            store.clone(),
            policy.operation_timeout,
            policy.relay_idle_timeout,
            policy.relay_total_timeout,
        )
        .map_err(map_relay)?;
        Ok(Self {
            runtime: Some(Arc::new(Runtime {
                pool: pool.clone(),
                operation_timeout: policy.operation_timeout,
                projects,
                single,
                multipart,
                relay,
                verifier: StagingVerifier::new(pool.clone(), store.clone(), verifier_policy),
                commit: WorkingHeadCommitService::new(pool.clone(), store.clone(), commit_policy),
                cleanup: CleanupService::new(pool, store, cleanup_policy),
                effective_quota,
                single_put_threshold_bytes: policy.single_put_threshold_bytes,
                upload_transport,
            })),
        })
    }

    pub(crate) async fn create(
        &self,
        browser: BrowserRequestHeaders<'_>,
        owner: ProjectOwner,
        project_id: ProjectId,
        expected_version: ProjectVersion,
        idempotency_key: IdempotencyKey,
        input: SaveCreateInput,
    ) -> Result<SaveSessionView, SaveHttpError> {
        let runtime = self.runtime()?;
        let context = authorize(runtime, browser, owner, project_id).await?;
        if context.project_version != expected_version {
            return Err(SaveHttpError::StaleProjectVersion);
        }
        let checksum = Sha256Checksum::from_bytes(input.sha256);
        if !upload_plan_matches_policy(
            input.physical_bytes,
            input.parts.is_empty(),
            runtime.single_put_threshold_bytes,
        ) {
            return Err(SaveHttpError::InvalidInput);
        }
        if input.parts.is_empty() {
            let request = CreateSinglePutSession {
                storage_scope_id: context.storage_scope_id,
                project_id,
                actor_user_id: context.actor_user_id,
                expected_project_version: expected_version,
                expected_physical_bytes: input.physical_bytes,
                expected_logical_bytes: input.logical_bytes,
                expected_file_count: input.file_count,
                expected_sha256: checksum.clone(),
                effective_quota: runtime.effective_quota,
                idempotency_key,
            };
            if runtime.upload_transport == SaveUploadTransport::Relay {
                let session = runtime
                    .single
                    .create_relay(request)
                    .await
                    .map_err(map_single)?;
                return Ok(SaveSessionView {
                    session_id: session.session_id().to_string(),
                    upload_mode: "single",
                    expires_at: save_session_expiry(session.expires_at())?,
                    part_count: 1,
                    idempotent_retry: session.is_idempotent_retry(),
                    upload: Some(relay_capability(
                        relay_single_path(owner, project_id, session.session_id()),
                        input.physical_bytes,
                        &checksum,
                    )),
                });
            }
            let session = runtime.single.create(request).await.map_err(map_single)?;
            return Ok(SaveSessionView {
                session_id: session.session_id().to_string(),
                upload_mode: "single",
                expires_at: save_session_expiry(session.expires_at())?,
                part_count: 1,
                idempotent_retry: session.is_idempotent_retry(),
                upload: Some(direct_capability_view(
                    session.capability().request(),
                    input.physical_bytes,
                )?),
            });
        }
        let parts = input
            .parts
            .into_iter()
            .map(SavePartInput::into_plan)
            .collect();
        let session = runtime
            .multipart
            .create(CreateMultipartSession {
                storage_scope_id: context.storage_scope_id,
                project_id,
                actor_user_id: context.actor_user_id,
                expected_project_version: expected_version,
                expected_physical_bytes: input.physical_bytes,
                expected_logical_bytes: input.logical_bytes,
                expected_file_count: input.file_count,
                expected_sha256: checksum,
                effective_quota: runtime.effective_quota,
                idempotency_key,
                parts,
            })
            .await
            .map_err(map_multipart)?;
        Ok(SaveSessionView {
            session_id: session.session_id().to_string(),
            upload_mode: "multipart",
            expires_at: save_session_expiry(session.expires_at())?,
            part_count: session.part_count(),
            idempotent_retry: session.is_idempotent_retry(),
            upload: None,
        })
    }

    pub(crate) async fn issue_parts(
        &self,
        browser: BrowserRequestHeaders<'_>,
        owner: ProjectOwner,
        project_id: ProjectId,
        session_id: SaveSessionId,
        parts: Vec<SavePartInput>,
    ) -> Result<Vec<UploadCapabilityView>, SaveHttpError> {
        let runtime = self.runtime()?;
        let context = authorize(runtime, browser, owner, project_id).await?;
        if runtime.upload_transport == SaveUploadTransport::Relay {
            let plans = parts
                .iter()
                .cloned()
                .map(SavePartInput::into_plan)
                .collect();
            runtime
                .multipart
                .validate_relay_parts(multipart_context(context, session_id), plans)
                .await
                .map_err(map_multipart)?;
            return Ok(parts
                .into_iter()
                .map(|part| {
                    relay_capability(
                        relay_part_path(owner, project_id, session_id, part.part_number),
                        part.expected_bytes,
                        &Sha256Checksum::from_bytes(part.sha256),
                    )
                })
                .collect());
        }
        let sizes = parts
            .iter()
            .map(|part| part.expected_bytes)
            .collect::<Vec<_>>();
        let plans = parts.into_iter().map(SavePartInput::into_plan).collect();
        runtime
            .multipart
            .issue_parts(multipart_context(context, session_id), plans)
            .await
            .map_err(map_multipart)?
            .into_iter()
            .zip(sizes)
            .map(|(capability, bytes)| direct_capability_view(capability.request(), bytes))
            .collect()
    }

    pub(crate) async fn relay_single_upload<R>(
        &self,
        input: RelaySingleUploadInput<'_, R>,
    ) -> Result<(), SaveHttpError>
    where
        R: AsyncRead + Send + 'static,
    {
        let runtime = self.runtime()?;
        require_relay(runtime)?;
        let context = authorize(runtime, input.browser, input.owner, input.project_id).await?;
        runtime
            .relay
            .upload_single(
                context,
                input.session_id,
                input.declared_bytes,
                input.checksum,
                input.reader,
            )
            .await
            .map_err(map_relay)
    }

    pub(crate) async fn relay_part_upload<R>(
        &self,
        input: RelayPartUploadInput<'_, R>,
    ) -> Result<(), SaveHttpError>
    where
        R: AsyncRead + Send + 'static,
    {
        let runtime = self.runtime()?;
        require_relay(runtime)?;
        let context = authorize(runtime, input.browser, input.owner, input.project_id).await?;
        runtime
            .relay
            .upload_part(
                context,
                input.session_id,
                input.part_number,
                input.declared_bytes,
                input.checksum,
                input.reader,
            )
            .await
            .map_err(map_relay)
    }

    pub(crate) async fn record_receipts(
        &self,
        browser: BrowserRequestHeaders<'_>,
        owner: ProjectOwner,
        project_id: ProjectId,
        session_id: SaveSessionId,
        receipts: Vec<SaveReceiptInput>,
    ) -> Result<(), SaveHttpError> {
        let runtime = self.runtime()?;
        require_direct(runtime)?;
        let context = authorize(runtime, browser, owner, project_id).await?;
        let receipts = receipts
            .into_iter()
            .map(|r| {
                MultipartPartReceipt::new(
                    r.part_number,
                    r.expected_bytes,
                    Sha256Checksum::from_bytes(r.sha256),
                    r.etag,
                )
                .map_err(map_multipart)
            })
            .collect::<Result<Vec<_>, _>>()?;
        runtime
            .multipart
            .record_receipts(multipart_context(context, session_id), receipts)
            .await
            .map_err(map_multipart)
    }

    pub(crate) fn require_direct_receipts(&self) -> Result<(), SaveHttpError> {
        require_direct(self.runtime()?)
    }

    pub(crate) async fn complete(
        &self,
        browser: BrowserRequestHeaders<'_>,
        owner: ProjectOwner,
        project_id: ProjectId,
        session_id: SaveSessionId,
        multipart: bool,
    ) -> Result<CommitView, SaveHttpError> {
        let runtime = self.runtime()?;
        let context = authorize(runtime, browser, owner, project_id).await?;
        if let Some(committed) = load_committed_outcome(runtime, context, session_id).await? {
            return Ok(committed);
        }
        if multipart
            && let Err(error) = runtime
                .multipart
                .complete(multipart_context(context, session_id))
                .await
        {
            if let Some(committed) = load_committed_outcome(runtime, context, session_id).await? {
                return Ok(committed);
            }
            return Err(map_multipart(error));
        }
        let verified = match runtime
            .verifier
            .verify(verify_context(context, session_id))
            .await
        {
            Ok(verified) => verified,
            Err(error) => {
                if let Some(committed) =
                    load_committed_outcome(runtime, context, session_id).await?
                {
                    return Ok(committed);
                }
                return Err(map_verification(error));
            }
        };
        runtime
            .commit
            .commit(&verified)
            .await
            .map(CommitView::from)
            .map_err(map_commit)
    }

    pub(crate) async fn reconcile_commit(
        &self,
        browser: BrowserRequestHeaders<'_>,
        owner: ProjectOwner,
        project_id: ProjectId,
        session_id: SaveSessionId,
    ) -> Result<ReconcileView, SaveHttpError> {
        let runtime = self.runtime()?;
        let context = authorize(runtime, browser, owner, project_id).await?;
        load_committed_outcome(runtime, context, session_id)
            .await?
            .map_or(Ok(ReconcileView::NotCommitted), |committed| {
                Ok(ReconcileView::Committed {
                    bundle_id: committed.bundle_id,
                    project_version: committed.project_version,
                })
            })
    }

    pub(crate) async fn abort(
        &self,
        browser: BrowserRequestHeaders<'_>,
        owner: ProjectOwner,
        project_id: ProjectId,
        session_id: SaveSessionId,
    ) -> Result<(), SaveHttpError> {
        let runtime = self.runtime()?;
        let context = authorize(runtime, browser, owner, project_id).await?;
        runtime
            .cleanup
            .abort(AbortSaveSession {
                storage_scope_id: context.storage_scope_id,
                project_id,
                actor_user_id: context.actor_user_id,
                session_id,
            })
            .await
            .map(|_| ())
            .map_err(map_cleanup)
    }
    fn runtime(&self) -> Result<&Runtime, SaveHttpError> {
        self.runtime.as_deref().ok_or(SaveHttpError::Unavailable)
    }
}

async fn load_committed_outcome(
    runtime: &Runtime,
    context: SaveProjectContext,
    session_id: SaveSessionId,
) -> Result<Option<CommitView>, SaveHttpError> {
    time::timeout(runtime.operation_timeout, async {
        let mut connection = runtime
            .pool
            .acquire()
            .await
            .map_err(|_| SaveHttpError::Unavailable)?;
        let mut transaction = connection
            .begin()
            .await
            .map_err(map_reconcile_query)?;
        configure_reconcile_deadline(&mut transaction, runtime.operation_timeout).await?;
        let row: Option<(String, Option<String>, i64)> = sqlx::query_as(
            "SELECT save.state,save.committed_bundle_id::text,save.expected_project_version \
             FROM save_sessions save JOIN projects project ON project.id=save.project_id \
             WHERE save.id=$1::uuid AND save.project_id=$2::uuid AND save.storage_scope_id=$3::uuid \
               AND save.actor_user_id=$4::uuid AND project.state='active'",
        )
        .bind(session_id.to_string())
        .bind(context.project_id.to_string())
        .bind(context.storage_scope_id.to_string())
        .bind(context.actor_user_id.to_string())
        .fetch_optional(&mut *transaction)
        .await
        .map_err(map_reconcile_query)?;
        transaction
            .rollback()
            .await
            .map_err(map_reconcile_query)?;
        let Some((state, bundle_id, expected_project_version)) = row else {
            return Err(SaveHttpError::NotFound);
        };
        if state != "committed" {
            return Ok(None);
        }
        let project_version = expected_project_version
            .checked_add(1)
            .and_then(|value| ProjectVersion::new(value).ok())
            .ok_or(SaveHttpError::Internal)?;
        Ok(Some(CommitView {
            bundle_id: bundle_id.ok_or(SaveHttpError::Internal)?,
            project_version: project_version.get(),
        }))
    })
    .await
    .map_err(|_| SaveHttpError::OperationTimeout)?
}

async fn authorize(
    runtime: &Runtime,
    browser: BrowserRequestHeaders<'_>,
    owner: ProjectOwner,
    project_id: ProjectId,
) -> Result<SaveProjectContext, SaveHttpError> {
    runtime
        .projects
        .authorize_save(browser, owner, project_id)
        .await
        .map_err(map_project)
}
fn multipart_context(c: SaveProjectContext, session_id: SaveSessionId) -> MultipartSessionContext {
    MultipartSessionContext {
        storage_scope_id: c.storage_scope_id,
        project_id: c.project_id,
        actor_user_id: c.actor_user_id,
        session_id,
    }
}
fn verify_context(c: SaveProjectContext, session_id: SaveSessionId) -> VerifyStagingBundle {
    VerifyStagingBundle {
        storage_scope_id: c.storage_scope_id,
        project_id: c.project_id,
        actor_user_id: c.actor_user_id,
        session_id,
    }
}

#[derive(Debug, Clone)]
pub(crate) struct SaveCreateInput {
    pub physical_bytes: u64,
    pub logical_bytes: u64,
    pub file_count: u32,
    pub sha256: [u8; 32],
    pub parts: Vec<SavePartInput>,
}
#[derive(Debug, Clone)]
pub(crate) struct SavePartInput {
    pub part_number: u16,
    pub expected_bytes: u64,
    pub sha256: [u8; 32],
}
impl SavePartInput {
    fn into_plan(self) -> MultipartPartPlan {
        MultipartPartPlan::new(
            self.part_number,
            self.expected_bytes,
            Sha256Checksum::from_bytes(self.sha256),
        )
    }
}
#[derive(Debug, Clone)]
pub(crate) struct SaveReceiptInput {
    pub part_number: u16,
    pub expected_bytes: u64,
    pub sha256: [u8; 32],
    pub etag: String,
}

pub(crate) struct RelaySingleUploadInput<'a, R> {
    pub browser: BrowserRequestHeaders<'a>,
    pub owner: ProjectOwner,
    pub project_id: ProjectId,
    pub session_id: SaveSessionId,
    pub declared_bytes: u64,
    pub checksum: Sha256Checksum,
    pub reader: R,
}

pub(crate) struct RelayPartUploadInput<'a, R> {
    pub browser: BrowserRequestHeaders<'a>,
    pub owner: ProjectOwner,
    pub project_id: ProjectId,
    pub session_id: SaveSessionId,
    pub part_number: u16,
    pub declared_bytes: u64,
    pub checksum: Sha256Checksum,
    pub reader: R,
}

#[derive(Debug, Clone, Serialize, ToSchema)]
#[serde(tag = "transport", rename_all = "snake_case")]
pub(crate) enum UploadCapabilityView {
    Direct {
        method: &'static str,
        url: String,
        headers: Vec<UploadHeaderView>,
        #[serde(rename = "expectedBytes")]
        expected_bytes: u64,
    },
    Relay {
        method: &'static str,
        path: String,
        headers: Vec<UploadHeaderView>,
        #[serde(rename = "expectedBytes")]
        expected_bytes: u64,
    },
}
#[derive(Debug, Clone, Serialize, ToSchema)]
pub(crate) struct UploadHeaderView {
    pub name: String,
    pub value: String,
}
#[derive(Debug, Clone, Serialize, ToSchema)]
#[serde(rename_all = "camelCase")]
pub(crate) struct SaveSessionView {
    pub session_id: String,
    pub upload_mode: &'static str,
    pub expires_at: String,
    pub part_count: u16,
    pub idempotent_retry: bool,
    pub upload: Option<UploadCapabilityView>,
}
#[derive(Debug, Clone, Serialize, ToSchema)]
#[serde(rename_all = "camelCase")]
pub(crate) struct CommitView {
    pub bundle_id: String,
    pub project_version: i64,
}
impl From<CommitWorkingHeadOutcome> for CommitView {
    fn from(v: CommitWorkingHeadOutcome) -> Self {
        Self {
            bundle_id: v.bundle_id().to_string(),
            project_version: v.project_version().get(),
        }
    }
}
#[derive(Debug, Clone, Serialize, ToSchema)]
#[serde(
    tag = "state",
    rename_all = "camelCase",
    rename_all_fields = "camelCase"
)]
pub(crate) enum ReconcileView {
    Committed {
        #[serde(rename = "bundleId")]
        bundle_id: String,
        #[serde(rename = "projectVersion")]
        project_version: i64,
    },
    NotCommitted,
}

fn direct_capability_view(
    r: &BoundedPresignedRequest,
    expected_bytes: u64,
) -> Result<UploadCapabilityView, SaveHttpError> {
    if r.operation() != PresignedOperation::Put {
        return Err(SaveHttpError::Internal);
    }
    Ok(UploadCapabilityView::Direct {
        method: "PUT",
        url: r.expose_bearer_url().to_owned(),
        headers: r
            .signed_headers()
            .map(|(name, value)| UploadHeaderView {
                name: name.to_owned(),
                value: value.to_owned(),
            })
            .collect(),
        expected_bytes,
    })
}

fn relay_capability(
    path: String,
    expected_bytes: u64,
    checksum: &Sha256Checksum,
) -> UploadCapabilityView {
    UploadCapabilityView::Relay {
        method: "PUT",
        path,
        headers: vec![
            UploadHeaderView {
                name: "Content-Type".to_owned(),
                value: BUNDLE_CONTENT_TYPE.to_owned(),
            },
            UploadHeaderView {
                name: RELAY_CHECKSUM_HEADER.to_owned(),
                value: checksum.base64(),
            },
        ],
        expected_bytes,
    }
}

fn relay_single_path(
    owner: ProjectOwner,
    project_id: ProjectId,
    session_id: SaveSessionId,
) -> String {
    let (owner_type, owner_id) = owner_path(owner);
    format!(
        "/api/v1/workspaces/{owner_type}/{owner_id}/projects/{project_id}/save-sessions/{session_id}/upload"
    )
}

fn relay_part_path(
    owner: ProjectOwner,
    project_id: ProjectId,
    session_id: SaveSessionId,
    part_number: u16,
) -> String {
    format!(
        "{}/parts/{part_number}",
        relay_single_path(owner, project_id, session_id)
    )
}

fn owner_path(owner: ProjectOwner) -> (&'static str, String) {
    match owner {
        ProjectOwner::User(id) => ("users", id.to_string()),
        ProjectOwner::Organization(id) => ("organizations", id.to_string()),
    }
}

fn require_relay(runtime: &Runtime) -> Result<(), SaveHttpError> {
    if runtime.upload_transport == SaveUploadTransport::Relay {
        Ok(())
    } else {
        Err(SaveHttpError::NotFound)
    }
}

fn require_direct(runtime: &Runtime) -> Result<(), SaveHttpError> {
    if runtime.upload_transport == SaveUploadTransport::Direct {
        Ok(())
    } else {
        Err(SaveHttpError::NotFound)
    }
}

fn map_project(e: ProjectHttpError) -> SaveHttpError {
    match e {
        ProjectHttpError::AuthenticationFailed => SaveHttpError::AuthenticationFailed,
        ProjectHttpError::Forbidden | ProjectHttpError::RateLimited => SaveHttpError::Forbidden,
        ProjectHttpError::NotFound => SaveHttpError::NotFound,
        ProjectHttpError::InvalidInput => SaveHttpError::InvalidInput,
        ProjectHttpError::PreconditionFailed => SaveHttpError::StaleProjectVersion,
        ProjectHttpError::Conflict | ProjectHttpError::ConfirmationRequired => {
            SaveHttpError::Conflict
        }
        ProjectHttpError::OperationTimeout => SaveHttpError::OperationTimeout,
        ProjectHttpError::CommitOutcomeUnknown => SaveHttpError::CommitOutcomeUnknown,
        ProjectHttpError::AuditUnavailable | ProjectHttpError::Unavailable => {
            SaveHttpError::Unavailable
        }
        ProjectHttpError::Internal => SaveHttpError::Internal,
    }
}
fn map_single(e: SinglePutServiceError) -> SaveHttpError {
    match e {
        SinglePutServiceError::InvalidInput => SaveHttpError::InvalidInput,
        SinglePutServiceError::ScopeNotFound | SinglePutServiceError::ProjectNotFound => {
            SaveHttpError::NotFound
        }
        SinglePutServiceError::ProjectUnavailable
        | SinglePutServiceError::IdempotencyConflict
        | SinglePutServiceError::ActiveSessionConflict
        | SinglePutServiceError::SessionTerminal
        | SinglePutServiceError::SessionNearExpiry => SaveHttpError::Conflict,
        SinglePutServiceError::StaleProjectVersion => SaveHttpError::StaleProjectVersion,
        SinglePutServiceError::QuotaExceeded => SaveHttpError::QuotaExceeded,
        SinglePutServiceError::PresignTimeoutReconciliationRequired
        | SinglePutServiceError::ReconciliationRequired => SaveHttpError::ReconciliationRequired,
        SinglePutServiceError::CommitOutcomeUnknown => SaveHttpError::CommitOutcomeUnknown,
        SinglePutServiceError::OperationTimeout => SaveHttpError::OperationTimeout,
        SinglePutServiceError::DatabaseUnavailable
        | SinglePutServiceError::ObjectStorageUnavailable => SaveHttpError::Unavailable,
        SinglePutServiceError::IdempotencyConfigurationMismatch
        | SinglePutServiceError::InvariantViolation => SaveHttpError::Internal,
    }
}
fn map_multipart(e: MultipartServiceError) -> SaveHttpError {
    match e {
        MultipartServiceError::InvalidInput
        | MultipartServiceError::PartConflict
        | MultipartServiceError::PartsIncomplete => SaveHttpError::InvalidInput,
        MultipartServiceError::ScopeNotFound
        | MultipartServiceError::ProjectNotFound
        | MultipartServiceError::SessionNotFound => SaveHttpError::NotFound,
        MultipartServiceError::ProjectUnavailable
        | MultipartServiceError::IdempotencyConflict
        | MultipartServiceError::ActiveSessionConflict
        | MultipartServiceError::SessionTerminal
        | MultipartServiceError::SessionNearExpiry => SaveHttpError::Conflict,
        MultipartServiceError::StaleProjectVersion => SaveHttpError::StaleProjectVersion,
        MultipartServiceError::SessionExpired => SaveHttpError::SessionExpired,
        MultipartServiceError::QuotaExceeded => SaveHttpError::QuotaExceeded,
        MultipartServiceError::CreateReconciliationRequired
        | MultipartServiceError::CompleteReconciliationRequired => {
            SaveHttpError::ReconciliationRequired
        }
        MultipartServiceError::CommitOutcomeUnknown => SaveHttpError::CommitOutcomeUnknown,
        MultipartServiceError::OperationTimeout => SaveHttpError::OperationTimeout,
        MultipartServiceError::DatabaseUnavailable
        | MultipartServiceError::ObjectStorageUnavailable => SaveHttpError::Unavailable,
        MultipartServiceError::IdempotencyConfigurationMismatch
        | MultipartServiceError::InvariantViolation => SaveHttpError::Internal,
    }
}
fn map_verification(e: VerificationError) -> SaveHttpError {
    match e {
        VerificationError::InvalidInput
        | VerificationError::ObjectMismatch
        | VerificationError::InvalidArchive => SaveHttpError::InvalidInput,
        VerificationError::SessionNotFound => SaveHttpError::NotFound,
        VerificationError::SessionUnavailable => SaveHttpError::Conflict,
        VerificationError::SessionExpired => SaveHttpError::SessionExpired,
        VerificationError::Unauthorized => SaveHttpError::Forbidden,
        VerificationError::OperationTimeout => SaveHttpError::OperationTimeout,
        VerificationError::DatabaseUnavailable | VerificationError::StorageUnavailable => {
            SaveHttpError::Unavailable
        }
        VerificationError::CommitOutcomeUnknown => SaveHttpError::CommitOutcomeUnknown,
        VerificationError::InvariantViolation => SaveHttpError::Internal,
    }
}
fn map_commit(e: WorkingHeadCommitError) -> SaveHttpError {
    match e {
        WorkingHeadCommitError::InvalidInput | WorkingHeadCommitError::ObjectMismatch => {
            SaveHttpError::InvalidInput
        }
        WorkingHeadCommitError::SessionNotFound => SaveHttpError::NotFound,
        WorkingHeadCommitError::SessionUnavailable => SaveHttpError::Conflict,
        WorkingHeadCommitError::SessionExpired => SaveHttpError::SessionExpired,
        WorkingHeadCommitError::Unauthorized => SaveHttpError::Forbidden,
        WorkingHeadCommitError::StaleProjectVersion => SaveHttpError::StaleProjectVersion,
        WorkingHeadCommitError::OperationTimeout => SaveHttpError::OperationTimeout,
        WorkingHeadCommitError::DatabaseUnavailable
        | WorkingHeadCommitError::StorageUnavailable => SaveHttpError::Unavailable,
        WorkingHeadCommitError::CommitOutcomeUnknown => SaveHttpError::CommitOutcomeUnknown,
        WorkingHeadCommitError::InvariantViolation => SaveHttpError::Internal,
    }
}
fn map_cleanup(e: CleanupError) -> SaveHttpError {
    match e {
        CleanupError::InvalidPolicy => SaveHttpError::Internal,
        CleanupError::ScopeNotFound
        | CleanupError::ProjectNotFound
        | CleanupError::SessionNotFound => SaveHttpError::NotFound,
        CleanupError::ProjectUnavailable
        | CleanupError::SessionTerminal
        | CleanupError::UploadInProgress => SaveHttpError::Conflict,
        CleanupError::OperationTimeout => SaveHttpError::OperationTimeout,
        CleanupError::DatabaseUnavailable => SaveHttpError::Unavailable,
        CleanupError::CommitOutcomeUnknown => SaveHttpError::CommitOutcomeUnknown,
        CleanupError::InvariantViolation => SaveHttpError::Internal,
    }
}

fn map_relay(error: RelayUploadError) -> SaveHttpError {
    match error {
        RelayUploadError::NotFound => SaveHttpError::NotFound,
        RelayUploadError::InvalidInput => SaveHttpError::InvalidInput,
        RelayUploadError::Conflict => SaveHttpError::Conflict,
        RelayUploadError::SessionExpired => SaveHttpError::SessionExpired,
        RelayUploadError::OperationTimeout => SaveHttpError::OperationTimeout,
        RelayUploadError::Unavailable => SaveHttpError::Unavailable,
        RelayUploadError::ReconciliationRequired => SaveHttpError::ReconciliationRequired,
        RelayUploadError::Internal => SaveHttpError::Internal,
    }
}

fn upload_plan_matches_policy(
    physical_bytes: u64,
    parts_are_empty: bool,
    single_put_threshold_bytes: u64,
) -> bool {
    (physical_bytes <= single_put_threshold_bytes) == parts_are_empty
}

async fn configure_reconcile_deadline(
    transaction: &mut Transaction<'_, Postgres>,
    operation_timeout: Duration,
) -> Result<(), SaveHttpError> {
    let millis = operation_timeout
        .saturating_sub(Duration::from_millis(25))
        .max(Duration::from_millis(1))
        .as_millis()
        .min(i32::MAX as u128);
    sqlx::query(
        "SELECT set_config('statement_timeout', $1, true), \
                set_config('lock_timeout', $1, true)",
    )
    .bind(format!("{millis}ms"))
    .execute(&mut **transaction)
    .await
    .map_err(map_reconcile_query)?;
    Ok(())
}

fn map_reconcile_query(error: sqlx::Error) -> SaveHttpError {
    if error
        .as_database_error()
        .and_then(sqlx::error::DatabaseError::code)
        .is_some_and(|code| matches!(code.as_ref(), "57014" | "55P03"))
    {
        SaveHttpError::OperationTimeout
    } else {
        SaveHttpError::Unavailable
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn default_upload_mode_is_server_enforced_at_the_policy_boundary() {
        let policy = SaveHttpPolicy::default();
        assert_eq!(policy.presign_minutes, 15);
        assert_eq!(policy.multipart_part_bytes, 16 * 1024 * 1024);
        assert!(upload_plan_matches_policy(
            policy.single_put_threshold_bytes,
            true,
            policy.single_put_threshold_bytes
        ));
        assert!(!upload_plan_matches_policy(
            policy.single_put_threshold_bytes,
            false,
            policy.single_put_threshold_bytes
        ));
        assert!(upload_plan_matches_policy(
            policy.single_put_threshold_bytes + 1,
            false,
            policy.single_put_threshold_bytes
        ));
        assert!(!upload_plan_matches_policy(
            policy.single_put_threshold_bytes + 1,
            true,
            policy.single_put_threshold_bytes
        ));
    }
}
