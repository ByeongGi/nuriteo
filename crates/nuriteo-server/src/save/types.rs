use std::fmt;

use crate::identity::UserId;
use crate::object_storage::{BoundedPresignedRequest, Sha256Checksum};
use crate::project::{ProjectId, ProjectVersion};
use crate::quota::{EffectiveQuota, SaveSessionId};
use crate::workspace::StorageScopeId;
use time::OffsetDateTime;

use super::SinglePutServiceError;

const MIN_IDEMPOTENCY_KEY_BYTES: usize = 16;
const MAX_IDEMPOTENCY_KEY_BYTES: usize = 128;

#[derive(Clone, PartialEq, Eq)]
pub struct IdempotencyKey(String);

impl IdempotencyKey {
    pub fn new(value: String) -> Result<Self, SinglePutServiceError> {
        if !(MIN_IDEMPOTENCY_KEY_BYTES..=MAX_IDEMPOTENCY_KEY_BYTES).contains(&value.len())
            || !value
                .bytes()
                .all(|byte| byte.is_ascii_alphanumeric() || matches!(byte, b'-' | b'_' | b'.'))
        {
            return Err(SinglePutServiceError::InvalidInput);
        }
        Ok(Self(value))
    }

    pub(crate) fn expose_for_hmac(&self) -> &[u8] {
        self.0.as_bytes()
    }
}

impl fmt::Debug for IdempotencyKey {
    fn fmt(&self, formatter: &mut fmt::Formatter<'_>) -> fmt::Result {
        formatter.write_str("IdempotencyKey([REDACTED])")
    }
}

#[derive(PartialEq, Eq)]
pub struct IdempotencySecret([u8; 32]);

impl IdempotencySecret {
    pub fn new(bytes: [u8; 32]) -> Result<Self, SinglePutServiceError> {
        if bytes.iter().all(|byte| *byte == 0) {
            return Err(SinglePutServiceError::InvalidInput);
        }
        Ok(Self(bytes))
    }

    pub(crate) const fn expose_for_hmac(&self) -> &[u8; 32] {
        &self.0
    }
}

impl Clone for IdempotencySecret {
    fn clone(&self) -> Self {
        Self(self.0)
    }
}

impl Drop for IdempotencySecret {
    fn drop(&mut self) {
        self.0.fill(0);
    }
}

impl fmt::Debug for IdempotencySecret {
    fn fmt(&self, formatter: &mut fmt::Formatter<'_>) -> fmt::Result {
        formatter.write_str("IdempotencySecret([REDACTED])")
    }
}

#[derive(Clone, Debug)]
pub struct CreateSinglePutSession {
    pub storage_scope_id: StorageScopeId,
    pub project_id: ProjectId,
    pub actor_user_id: UserId,
    pub expected_project_version: ProjectVersion,
    pub expected_physical_bytes: u64,
    pub expected_logical_bytes: u64,
    pub expected_file_count: u32,
    pub expected_sha256: Sha256Checksum,
    pub effective_quota: EffectiveQuota,
    pub idempotency_key: IdempotencyKey,
}

#[derive(Clone)]
pub struct SinglePutUploadCapability {
    request: BoundedPresignedRequest,
}

impl SinglePutUploadCapability {
    pub(crate) const fn new(request: BoundedPresignedRequest) -> Self {
        Self { request }
    }

    /// Returns the bounded bearer request for delivery to the authorized caller.
    /// It must never be logged, serialized into errors, or persisted.
    #[must_use]
    pub const fn request(&self) -> &BoundedPresignedRequest {
        &self.request
    }
}

impl fmt::Debug for SinglePutUploadCapability {
    fn fmt(&self, formatter: &mut fmt::Formatter<'_>) -> fmt::Result {
        formatter
            .debug_struct("SinglePutUploadCapability")
            .field("operation", &self.request.operation())
            .field(
                "signed_header_count",
                &self.request.signed_headers().count(),
            )
            .finish_non_exhaustive()
    }
}

pub struct SinglePutSession {
    session_id: SaveSessionId,
    expires_at: OffsetDateTime,
    idempotent_retry: bool,
    capability: SinglePutUploadCapability,
}

#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub struct RelaySinglePutSession {
    session_id: SaveSessionId,
    expires_at: OffsetDateTime,
    idempotent_retry: bool,
}

impl RelaySinglePutSession {
    pub(crate) const fn new(
        session_id: SaveSessionId,
        expires_at: OffsetDateTime,
        idempotent_retry: bool,
    ) -> Self {
        Self {
            session_id,
            expires_at,
            idempotent_retry,
        }
    }

    #[must_use]
    pub const fn session_id(self) -> SaveSessionId {
        self.session_id
    }

    #[must_use]
    pub const fn expires_at(self) -> OffsetDateTime {
        self.expires_at
    }

    #[must_use]
    pub const fn is_idempotent_retry(self) -> bool {
        self.idempotent_retry
    }
}

impl SinglePutSession {
    pub(crate) const fn new(
        session_id: SaveSessionId,
        expires_at: OffsetDateTime,
        idempotent_retry: bool,
        capability: SinglePutUploadCapability,
    ) -> Self {
        Self {
            session_id,
            expires_at,
            idempotent_retry,
            capability,
        }
    }

    #[must_use]
    pub const fn session_id(&self) -> SaveSessionId {
        self.session_id
    }

    #[must_use]
    pub const fn expires_at(&self) -> OffsetDateTime {
        self.expires_at
    }

    #[must_use]
    pub const fn is_idempotent_retry(&self) -> bool {
        self.idempotent_retry
    }

    #[must_use]
    pub const fn capability(&self) -> &SinglePutUploadCapability {
        &self.capability
    }
}

impl fmt::Debug for SinglePutSession {
    fn fmt(&self, formatter: &mut fmt::Formatter<'_>) -> fmt::Result {
        formatter
            .debug_struct("SinglePutSession")
            .field("session_id", &self.session_id)
            .field("expires_at", &self.expires_at)
            .field("idempotent_retry", &self.idempotent_retry)
            .field("capability", &self.capability)
            .finish()
    }
}

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum ReconciliationState {
    Missing,
    Active(SaveSessionId),
    Terminal(SaveSessionId),
}
