use std::fmt;

use time::OffsetDateTime;

use crate::identity::UserId;
use crate::object_storage::{BoundedPresignedRequest, Sha256Checksum};
use crate::project::{ProjectId, ProjectVersion};
use crate::quota::{EffectiveQuota, SaveSessionId};
use crate::workspace::StorageScopeId;

use super::{IdempotencyKey, MultipartServiceError};

#[derive(Clone, PartialEq, Eq)]
pub struct MultipartPartPlan {
    part_number: u16,
    expected_bytes: u64,
    expected_sha256: Sha256Checksum,
}

impl MultipartPartPlan {
    #[must_use]
    pub const fn new(
        part_number: u16,
        expected_bytes: u64,
        expected_sha256: Sha256Checksum,
    ) -> Self {
        Self {
            part_number,
            expected_bytes,
            expected_sha256,
        }
    }

    #[must_use]
    pub const fn part_number(&self) -> u16 {
        self.part_number
    }

    #[must_use]
    pub const fn expected_bytes(&self) -> u64 {
        self.expected_bytes
    }

    #[must_use]
    pub const fn expected_sha256(&self) -> &Sha256Checksum {
        &self.expected_sha256
    }
}

impl fmt::Debug for MultipartPartPlan {
    fn fmt(&self, formatter: &mut fmt::Formatter<'_>) -> fmt::Result {
        formatter
            .debug_struct("MultipartPartPlan")
            .field("part_number", &self.part_number)
            .field("expected_bytes", &self.expected_bytes)
            .field("expected_sha256", &self.expected_sha256)
            .finish()
    }
}

#[derive(Clone, Debug)]
pub struct CreateMultipartSession {
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
    pub parts: Vec<MultipartPartPlan>,
}

#[derive(Clone, Copy, Debug)]
pub struct MultipartSessionContext {
    pub storage_scope_id: StorageScopeId,
    pub project_id: ProjectId,
    pub actor_user_id: UserId,
    pub session_id: SaveSessionId,
}

pub struct MultipartSession {
    session_id: SaveSessionId,
    expires_at: OffsetDateTime,
    part_count: u16,
    idempotent_retry: bool,
}

impl MultipartSession {
    pub(crate) const fn new(
        session_id: SaveSessionId,
        expires_at: OffsetDateTime,
        part_count: u16,
        idempotent_retry: bool,
    ) -> Self {
        Self {
            session_id,
            expires_at,
            part_count,
            idempotent_retry,
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
    pub const fn part_count(&self) -> u16 {
        self.part_count
    }

    #[must_use]
    pub const fn is_idempotent_retry(&self) -> bool {
        self.idempotent_retry
    }
}

impl fmt::Debug for MultipartSession {
    fn fmt(&self, formatter: &mut fmt::Formatter<'_>) -> fmt::Result {
        formatter
            .debug_struct("MultipartSession")
            .field("session_id", &self.session_id)
            .field("expires_at", &self.expires_at)
            .field("part_count", &self.part_count)
            .field("idempotent_retry", &self.idempotent_retry)
            .finish()
    }
}

#[derive(Clone)]
pub struct MultipartPartCapability {
    part_number: u16,
    request: BoundedPresignedRequest,
}

impl MultipartPartCapability {
    pub(crate) const fn new(part_number: u16, request: BoundedPresignedRequest) -> Self {
        Self {
            part_number,
            request,
        }
    }

    #[must_use]
    pub const fn part_number(&self) -> u16 {
        self.part_number
    }

    /// Returns the bearer request only for delivery to the authorized caller.
    #[must_use]
    pub const fn request(&self) -> &BoundedPresignedRequest {
        &self.request
    }
}

impl fmt::Debug for MultipartPartCapability {
    fn fmt(&self, formatter: &mut fmt::Formatter<'_>) -> fmt::Result {
        formatter
            .debug_struct("MultipartPartCapability")
            .field("part_number", &self.part_number)
            .field("request", &self.request)
            .finish()
    }
}

#[derive(Clone, PartialEq, Eq)]
pub struct MultipartPartReceipt {
    part_number: u16,
    expected_bytes: u64,
    expected_sha256: Sha256Checksum,
    e_tag: String,
}

impl MultipartPartReceipt {
    pub fn new(
        part_number: u16,
        expected_bytes: u64,
        expected_sha256: Sha256Checksum,
        e_tag: String,
    ) -> Result<Self, MultipartServiceError> {
        if e_tag.is_empty()
            || e_tag.len() > 512
            || e_tag.trim() != e_tag
            || e_tag.chars().any(char::is_control)
        {
            return Err(MultipartServiceError::InvalidInput);
        }
        Ok(Self {
            part_number,
            expected_bytes,
            expected_sha256,
            e_tag,
        })
    }

    pub(crate) const fn part_number(&self) -> u16 {
        self.part_number
    }

    pub(crate) const fn expected_bytes(&self) -> u64 {
        self.expected_bytes
    }

    pub(crate) const fn expected_sha256(&self) -> &Sha256Checksum {
        &self.expected_sha256
    }

    pub(crate) fn expose_etag_for_storage(&self) -> &str {
        &self.e_tag
    }
}

impl fmt::Debug for MultipartPartReceipt {
    fn fmt(&self, formatter: &mut fmt::Formatter<'_>) -> fmt::Result {
        formatter
            .debug_struct("MultipartPartReceipt")
            .field("part_number", &self.part_number)
            .field("expected_bytes", &self.expected_bytes)
            .field("expected_sha256", &self.expected_sha256)
            .field("e_tag", &"[REDACTED]")
            .finish()
    }
}

#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub struct MultipartCompleteResult {
    idempotent_retry: bool,
}

impl MultipartCompleteResult {
    pub(crate) const fn new(idempotent_retry: bool) -> Self {
        Self { idempotent_retry }
    }

    #[must_use]
    pub const fn is_idempotent_retry(self) -> bool {
        self.idempotent_retry
    }
}
