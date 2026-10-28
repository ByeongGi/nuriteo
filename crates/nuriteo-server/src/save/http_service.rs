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

#[derive(Clone)]
pub struct SaveHttpService {
    runtime: Option<Arc<Runtime>>,
}

pub(crate) struct Runtime {
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

mod session;
pub(crate) use session::*;
mod relay;
pub(crate) use relay::*;
