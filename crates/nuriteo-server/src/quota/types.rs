use std::fmt;

use time::OffsetDateTime;
use uuid::{Uuid, Variant, Version};

use crate::project::ProjectId;
use crate::workspace::StorageScopeId;

use super::QuotaServiceError;

pub const MAX_RESERVATION_BYTES: u64 = 2 * 1024 * 1024 * 1024;

/// A validated effective Workspace quota.
///
/// The representation is private so callers cannot bypass [`Self::limited`].
///
/// ```compile_fail
/// use nuriteo_server::quota::EffectiveQuota;
/// let _ = EffectiveQuota(Some(0));
/// ```
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub struct EffectiveQuota(Option<u64>);

impl EffectiveQuota {
    #[must_use]
    pub const fn unlimited() -> Self {
        Self(None)
    }

    pub fn limited(bytes: u64) -> Result<Self, QuotaServiceError> {
        if bytes == 0 || bytes > i64::MAX as u64 {
            return Err(QuotaServiceError::InvalidInput);
        }
        Ok(Self(Some(bytes)))
    }

    #[must_use]
    pub const fn limit_bytes(self) -> Option<u64> {
        self.0
    }

    pub(crate) fn validate(self) -> Result<Self, QuotaServiceError> {
        match self.0 {
            None => Ok(self),
            Some(bytes) if bytes > 0 && bytes <= i64::MAX as u64 => Ok(self),
            Some(_) => Err(QuotaServiceError::InvalidInput),
        }
    }
}

#[derive(Clone, Copy, PartialEq, Eq, PartialOrd, Ord, Hash)]
pub struct SaveSessionId(Uuid);

impl SaveSessionId {
    #[must_use]
    pub fn new() -> Self {
        Self(Uuid::now_v7())
    }

    pub fn from_uuid(value: Uuid) -> Result<Self, QuotaServiceError> {
        if value.is_nil()
            || value.get_version() != Some(Version::SortRand)
            || value.get_variant() != Variant::RFC4122
        {
            return Err(QuotaServiceError::InvalidInput);
        }
        Ok(Self(value))
    }

    #[must_use]
    pub const fn into_uuid(self) -> Uuid {
        self.0
    }
}

impl Default for SaveSessionId {
    fn default() -> Self {
        Self::new()
    }
}

impl fmt::Debug for SaveSessionId {
    fn fmt(&self, formatter: &mut fmt::Formatter<'_>) -> fmt::Result {
        formatter
            .debug_tuple("SaveSessionId")
            .field(&self.0)
            .finish()
    }
}

impl fmt::Display for SaveSessionId {
    fn fmt(&self, formatter: &mut fmt::Formatter<'_>) -> fmt::Result {
        self.0.fmt(formatter)
    }
}

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub struct ReservationRequest {
    pub storage_scope_id: StorageScopeId,
    pub project_id: ProjectId,
    pub save_session_id: SaveSessionId,
    pub requested_bytes: u64,
    pub effective_quota: EffectiveQuota,
}

impl ReservationRequest {
    pub(crate) fn validate(self) -> Result<Self, QuotaServiceError> {
        if !(1..=MAX_RESERVATION_BYTES).contains(&self.requested_bytes) {
            return Err(QuotaServiceError::InvalidInput);
        }
        self.effective_quota.validate()?;
        Ok(self)
    }
}

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub struct QuotaProjection {
    storage_scope_id: StorageScopeId,
    used_bytes: u64,
    reserved_bytes: u64,
    limit_bytes: Option<u64>,
    available_bytes: Option<u64>,
}

impl QuotaProjection {
    pub(crate) fn new(
        storage_scope_id: StorageScopeId,
        used_bytes: u64,
        reserved_bytes: u64,
        quota: EffectiveQuota,
    ) -> Result<Self, QuotaServiceError> {
        quota.validate()?;
        let committed = used_bytes
            .checked_add(reserved_bytes)
            .ok_or(QuotaServiceError::ArithmeticOverflow)?;
        let limit_bytes = quota.limit_bytes();
        let available_bytes = limit_bytes.map(|limit| limit.saturating_sub(committed));
        Ok(Self {
            storage_scope_id,
            used_bytes,
            reserved_bytes,
            limit_bytes,
            available_bytes,
        })
    }

    #[must_use]
    pub const fn storage_scope_id(self) -> StorageScopeId {
        self.storage_scope_id
    }

    #[must_use]
    pub const fn used_bytes(self) -> u64 {
        self.used_bytes
    }

    #[must_use]
    pub const fn reserved_bytes(self) -> u64 {
        self.reserved_bytes
    }

    #[must_use]
    pub const fn limit_bytes(self) -> Option<u64> {
        self.limit_bytes
    }

    #[must_use]
    pub const fn available_bytes(self) -> Option<u64> {
        self.available_bytes
    }
}

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub struct ReservationResult {
    save_session_id: SaveSessionId,
    reserved_bytes: u64,
    expires_at: OffsetDateTime,
    projection: QuotaProjection,
    idempotent_retry: bool,
}

impl ReservationResult {
    pub(crate) const fn new(
        save_session_id: SaveSessionId,
        reserved_bytes: u64,
        expires_at: OffsetDateTime,
        projection: QuotaProjection,
        idempotent_retry: bool,
    ) -> Self {
        Self {
            save_session_id,
            reserved_bytes,
            expires_at,
            projection,
            idempotent_retry,
        }
    }

    #[must_use]
    pub const fn save_session_id(self) -> SaveSessionId {
        self.save_session_id
    }

    #[must_use]
    pub const fn reserved_bytes(self) -> u64 {
        self.reserved_bytes
    }

    #[must_use]
    pub const fn expires_at(self) -> OffsetDateTime {
        self.expires_at
    }

    #[must_use]
    pub const fn projection(self) -> QuotaProjection {
        self.projection
    }

    #[must_use]
    pub const fn is_idempotent_retry(self) -> bool {
        self.idempotent_retry
    }
}

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum TerminalSaveState {
    Aborted,
    Expired,
    Failed,
}

impl TerminalSaveState {
    pub(crate) const fn as_str(self) -> &'static str {
        match self {
            Self::Aborted => "aborted",
            Self::Expired => "expired",
            Self::Failed => "failed",
        }
    }
}
