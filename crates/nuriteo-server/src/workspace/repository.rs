use std::fmt;

use sqlx::{Postgres, Transaction};

use crate::identity::{Timestamp, UserId};
use crate::organization::OrganizationId;

use super::{OrganizationStorageScope, PersonalStorageScope, StorageScopeId};

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum StorageScopeRepositoryError {
    PersistenceUnavailable,
    InvalidPersistedState,
}

impl fmt::Display for StorageScopeRepositoryError {
    fn fmt(&self, formatter: &mut fmt::Formatter<'_>) -> fmt::Result {
        formatter.write_str(match self {
            Self::PersistenceUnavailable => "personal storage scope persistence is unavailable",
            Self::InvalidPersistedState => "personal storage scope state is invalid",
        })
    }
}

impl std::error::Error for StorageScopeRepositoryError {}

pub struct PersonalStorageScopeRepository;

impl PersonalStorageScopeRepository {
    /// Provisions exactly one scope for a User inside the caller-owned
    /// transaction. Concurrent calls converge on the same persisted scope.
    pub async fn provision(
        transaction: &mut Transaction<'_, Postgres>,
        owner_user_id: UserId,
        now: Timestamp,
    ) -> Result<PersonalStorageScope, StorageScopeRepositoryError> {
        let candidate_id = StorageScopeId::new();
        let inserted =
            sqlx::query_as::<_, (String, String, time::OffsetDateTime, time::OffsetDateTime)>(
                "INSERT INTO storage_scopes (id, owner_user_id, created_at, updated_at) \
             VALUES ($1::uuid, $2::uuid, $3::timestamptz, $3::timestamptz) \
             ON CONFLICT (owner_user_id) DO NOTHING \
             RETURNING id::text, owner_user_id::text, created_at, updated_at",
            )
            .bind(candidate_id.to_string())
            .bind(owner_user_id.to_string())
            .bind(now.to_string())
            .fetch_optional(&mut **transaction)
            .await
            .map_err(|_| StorageScopeRepositoryError::PersistenceUnavailable)?;

        let row = match inserted {
            Some(row) => row,
            None => {
                sqlx::query_as::<_, (String, String, time::OffsetDateTime, time::OffsetDateTime)>(
                    "SELECT id::text, owner_user_id::text, created_at, updated_at \
                 FROM storage_scopes WHERE owner_user_id = $1::uuid",
                )
                .bind(owner_user_id.to_string())
                .fetch_one(&mut **transaction)
                .await
                .map_err(|_| StorageScopeRepositoryError::PersistenceUnavailable)?
            }
        };
        decode_scope(row)
    }
}

pub struct OrganizationStorageScopeRepository;

impl OrganizationStorageScopeRepository {
    /// Provisions exactly one scope for an Organization inside the caller-owned
    /// transaction. Concurrent calls converge on the same persisted scope.
    pub async fn provision(
        transaction: &mut Transaction<'_, Postgres>,
        owner_organization_id: OrganizationId,
        now: Timestamp,
    ) -> Result<OrganizationStorageScope, StorageScopeRepositoryError> {
        let candidate_id = StorageScopeId::new();
        let inserted =
            sqlx::query_as::<_, (String, String, time::OffsetDateTime, time::OffsetDateTime)>(
                "INSERT INTO storage_scopes \
             (id, owner_user_id, owner_organization_id, created_at, updated_at) \
             VALUES ($1::uuid, NULL, $2::uuid, $3::timestamptz, $3::timestamptz) \
             ON CONFLICT (owner_organization_id) DO NOTHING \
             RETURNING id::text, owner_organization_id::text, created_at, updated_at",
            )
            .bind(candidate_id.to_string())
            .bind(owner_organization_id.to_string())
            .bind(now.to_string())
            .fetch_optional(&mut **transaction)
            .await
            .map_err(|_| StorageScopeRepositoryError::PersistenceUnavailable)?;

        let row = match inserted {
            Some(row) => row,
            None => {
                sqlx::query_as::<_, (String, String, time::OffsetDateTime, time::OffsetDateTime)>(
                    "SELECT id::text, owner_organization_id::text, created_at, updated_at \
                 FROM storage_scopes WHERE owner_organization_id = $1::uuid",
                )
                .bind(owner_organization_id.to_string())
                .fetch_one(&mut **transaction)
                .await
                .map_err(|_| StorageScopeRepositoryError::PersistenceUnavailable)?
            }
        };
        decode_organization_scope(row)
    }
}

fn decode_scope(
    row: (String, String, time::OffsetDateTime, time::OffsetDateTime),
) -> Result<PersonalStorageScope, StorageScopeRepositoryError> {
    let id = row
        .0
        .parse()
        .map_err(|_| StorageScopeRepositoryError::InvalidPersistedState)?;
    let owner_user_id = row
        .1
        .parse()
        .map_err(|_| StorageScopeRepositoryError::InvalidPersistedState)?;
    let created_at = Timestamp::from_datetime(row.2)
        .map_err(|_| StorageScopeRepositoryError::InvalidPersistedState)?;
    let updated_at = Timestamp::from_datetime(row.3)
        .map_err(|_| StorageScopeRepositoryError::InvalidPersistedState)?;
    PersonalStorageScope::new(id, owner_user_id, created_at, updated_at)
        .map_err(|_| StorageScopeRepositoryError::InvalidPersistedState)
}

fn decode_organization_scope(
    row: (String, String, time::OffsetDateTime, time::OffsetDateTime),
) -> Result<OrganizationStorageScope, StorageScopeRepositoryError> {
    let id = row
        .0
        .parse()
        .map_err(|_| StorageScopeRepositoryError::InvalidPersistedState)?;
    let owner = row
        .1
        .parse()
        .map_err(|_| StorageScopeRepositoryError::InvalidPersistedState)?;
    let created_at = Timestamp::from_datetime(row.2)
        .map_err(|_| StorageScopeRepositoryError::InvalidPersistedState)?;
    let updated_at = Timestamp::from_datetime(row.3)
        .map_err(|_| StorageScopeRepositoryError::InvalidPersistedState)?;
    OrganizationStorageScope::new(id, owner, created_at, updated_at)
        .map_err(|_| StorageScopeRepositoryError::InvalidPersistedState)
}
