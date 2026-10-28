#![allow(unused_imports)]
use super::session::*;
use super::*;
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

use super::super::http_config::SaveUploadTransport;

use super::super::relay::{RelayUploadError, RelayUploadService};

use super::super::{
    AbortSaveSession, CleanupError, CleanupService, CleanupWorkerPolicy, CommitWorkingHeadOutcome,
    CreateMultipartSession, CreateSinglePutSession, IdempotencyKey, IdempotencySecret,
    MultipartPartPlan, MultipartPartReceipt, MultipartService, MultipartServiceError,
    MultipartServicePolicy, MultipartSessionContext, SinglePutService, SinglePutServiceError,
    SinglePutServicePolicy, StagingVerifier, StagingVerifierPolicy, VerificationError,
    VerifyStagingBundle, WorkingHeadCommitError, WorkingHeadCommitPolicy, WorkingHeadCommitService,
};
use super::{
    BUNDLE_CONTENT_TYPE, CommitView, RELAY_CHECKSUM_HEADER, RelayPartUploadInput,
    RelaySingleUploadInput, Runtime, SaveCreateInput, SaveHttpError, SaveHttpPolicy,
    SaveHttpService, SavePartInput, SaveReceiptInput, SaveSessionView, UploadCapabilityView,
    UploadHeaderView,
};

pub(crate) fn map_relay(error: RelayUploadError) -> SaveHttpError {
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

pub(crate) fn upload_plan_matches_policy(
    physical_bytes: u64,
    parts_are_empty: bool,
    single_put_threshold_bytes: u64,
) -> bool {
    (physical_bytes <= single_put_threshold_bytes) == parts_are_empty
}

pub(crate) async fn configure_reconcile_deadline(
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

pub(crate) fn map_reconcile_query(error: sqlx::Error) -> SaveHttpError {
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
