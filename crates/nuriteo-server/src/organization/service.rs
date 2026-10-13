use std::fmt;
use std::future::Future;
use std::net::IpAddr;
use std::time::Duration;

use serde_json::json;
use sqlx::{Acquire, Postgres, Transaction};
use time::OffsetDateTime;
use tokio::time as tokio_time;

use crate::audit::{
    ActorType, AuditActor, AuditEvent, AuditEventFields, AuditEventId, AuditMetadata, AuditResult,
    AuditScope, AuditTarget, AuditWriter, ScopeType,
};
use crate::database::DatabasePool;
use crate::identity::{Timestamp, UserId};
use crate::workspace::{OrganizationStorageScopeRepository, StorageScopeRepositoryError};

use super::{
    Organization, OrganizationFields, OrganizationId, OrganizationRole, OrganizationStatus,
    OrganizationVersion,
};

const DEFAULT_OPERATION_TIMEOUT: Duration = Duration::from_secs(5);
const MIN_OPERATION_TIMEOUT: Duration = Duration::from_millis(100);
const MAX_OPERATION_TIMEOUT: Duration = Duration::from_secs(30);

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub struct OrganizationServicePolicy {
    operation_timeout: Duration,
}

impl OrganizationServicePolicy {
    pub fn new(operation_timeout: Duration) -> Result<Self, OrganizationServiceError> {
        if !(MIN_OPERATION_TIMEOUT..=MAX_OPERATION_TIMEOUT).contains(&operation_timeout) {
            return Err(OrganizationServiceError::InvalidInput);
        }
        Ok(Self { operation_timeout })
    }

    #[must_use]
    pub const fn operation_timeout(self) -> Duration {
        self.operation_timeout
    }
}

impl Default for OrganizationServicePolicy {
    fn default() -> Self {
        Self {
            operation_timeout: DEFAULT_OPERATION_TIMEOUT,
        }
    }
}

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum OrganizationPrincipal {
    Owner(UserId),
    InstanceAdministrator(UserId),
}

impl OrganizationPrincipal {
    #[must_use]
    pub const fn user_id(self) -> UserId {
        match self {
            Self::Owner(user_id) | Self::InstanceAdministrator(user_id) => user_id,
        }
    }
}

#[derive(Clone)]
pub struct OrganizationAuditContext {
    event_id: AuditEventId,
    actor_user_id: UserId,
    actor_display_name: Option<String>,
    correlation_id: String,
    source_ip: Option<IpAddr>,
}

impl OrganizationAuditContext {
    #[must_use]
    pub fn new(
        event_id: AuditEventId,
        actor_user_id: UserId,
        actor_display_name: Option<String>,
        correlation_id: String,
        source_ip: Option<IpAddr>,
    ) -> Self {
        Self {
            event_id,
            actor_user_id,
            actor_display_name,
            correlation_id,
            source_ip,
        }
    }
}

impl fmt::Debug for OrganizationAuditContext {
    fn fmt(&self, formatter: &mut fmt::Formatter<'_>) -> fmt::Result {
        formatter
            .debug_struct("OrganizationAuditContext")
            .field("event_id", &self.event_id)
            .finish_non_exhaustive()
    }
}

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum MembershipAddResult {
    Added,
    AlreadyMember,
}

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum MembershipChangeResult {
    Changed,
    Unchanged,
}

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum MembershipRemoveResult {
    Removed,
    AlreadyAbsent,
}

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
#[non_exhaustive]
pub enum OrganizationServiceError {
    InvalidInput,
    NotFound,
    Unauthorized,
    UserUnavailable,
    Archived,
    DuplicateSlug,
    MemberNotFound,
    MemberLimitReached,
    LastOwner,
    StaleVersion,
    AuditUnavailable,
    DatabaseUnavailable,
    OperationTimeout,
    InvariantViolation,
}

impl fmt::Display for OrganizationServiceError {
    fn fmt(&self, formatter: &mut fmt::Formatter<'_>) -> fmt::Result {
        formatter.write_str(match self {
            Self::InvalidInput => "organization input is invalid",
            Self::NotFound => "organization was not found",
            Self::Unauthorized => "organization operation is not authorized",
            Self::UserUnavailable => "organization user is unavailable",
            Self::Archived => "organization is archived",
            Self::DuplicateSlug => "organization slug already exists",
            Self::MemberNotFound => "organization member was not found",
            Self::MemberLimitReached => "organization member limit was reached",
            Self::LastOwner => "organization must retain at least one owner",
            Self::StaleVersion => "organization version is stale",
            Self::AuditUnavailable => "organization audit persistence is unavailable",
            Self::DatabaseUnavailable => "organization persistence is unavailable",
            Self::OperationTimeout => "organization operation timed out",
            Self::InvariantViolation => "organization state is invalid",
        })
    }
}

impl std::error::Error for OrganizationServiceError {}

#[derive(Clone)]
pub struct OrganizationService {
    pool: DatabasePool,
    policy: OrganizationServicePolicy,
}

impl OrganizationService {
    #[must_use]
    pub const fn new(pool: DatabasePool, policy: OrganizationServicePolicy) -> Self {
        Self { pool, policy }
    }

    pub async fn create(
        &self,
        creator_user_id: UserId,
        slug: String,
        display_name: String,
        audit: &OrganizationAuditContext,
    ) -> Result<Organization, OrganizationServiceError> {
        self.ensure_audit_actor(creator_user_id, audit)?;
        self.within_deadline(self.create_inner(creator_user_id, slug, display_name, audit))
            .await
    }

    pub async fn get(
        &self,
        principal: OrganizationPrincipal,
        organization_id: OrganizationId,
    ) -> Result<Organization, OrganizationServiceError> {
        self.within_deadline(self.get_inner(principal, organization_id))
            .await
    }

    pub async fn update_display_name(
        &self,
        principal: OrganizationPrincipal,
        organization_id: OrganizationId,
        expected_version: OrganizationVersion,
        display_name: String,
        audit: &OrganizationAuditContext,
    ) -> Result<Organization, OrganizationServiceError> {
        self.ensure_audit_actor(principal.user_id(), audit)?;
        self.within_deadline(self.update_display_name_inner(
            principal,
            organization_id,
            expected_version,
            display_name,
            audit,
        ))
        .await
    }

    pub async fn archive(
        &self,
        principal: OrganizationPrincipal,
        organization_id: OrganizationId,
        expected_version: OrganizationVersion,
        audit: &OrganizationAuditContext,
    ) -> Result<Organization, OrganizationServiceError> {
        self.ensure_audit_actor(principal.user_id(), audit)?;
        self.within_deadline(self.archive_inner(
            principal,
            organization_id,
            expected_version,
            audit,
        ))
        .await
    }

    pub async fn add_member(
        &self,
        principal: OrganizationPrincipal,
        organization_id: OrganizationId,
        user_id: UserId,
        role: OrganizationRole,
        audit: &OrganizationAuditContext,
    ) -> Result<MembershipAddResult, OrganizationServiceError> {
        self.ensure_audit_actor(principal.user_id(), audit)?;
        self.within_deadline(self.add_member_inner(
            principal,
            organization_id,
            user_id,
            role,
            audit,
        ))
        .await
    }

    pub async fn change_member_role(
        &self,
        principal: OrganizationPrincipal,
        organization_id: OrganizationId,
        user_id: UserId,
        role: OrganizationRole,
        audit: &OrganizationAuditContext,
    ) -> Result<MembershipChangeResult, OrganizationServiceError> {
        self.ensure_audit_actor(principal.user_id(), audit)?;
        self.within_deadline(self.change_member_role_inner(
            principal,
            organization_id,
            user_id,
            role,
            audit,
        ))
        .await
    }

    pub async fn remove_member(
        &self,
        principal: OrganizationPrincipal,
        organization_id: OrganizationId,
        user_id: UserId,
        audit: &OrganizationAuditContext,
    ) -> Result<MembershipRemoveResult, OrganizationServiceError> {
        self.ensure_audit_actor(principal.user_id(), audit)?;
        self.within_deadline(self.remove_member_inner(principal, organization_id, user_id, audit))
            .await
    }

    async fn create_inner(
        &self,
        creator_user_id: UserId,
        slug: String,
        display_name: String,
        audit: &OrganizationAuditContext,
    ) -> Result<Organization, OrganizationServiceError> {
        super::model::validate_slug(&slug).map_err(|_| OrganizationServiceError::InvalidInput)?;
        super::model::validate_display_name(&display_name)
            .map_err(|_| OrganizationServiceError::InvalidInput)?;
        let mut connection = self.acquire().await?;
        let mut transaction = connection
            .begin()
            .await
            .map_err(|_| OrganizationServiceError::DatabaseUnavailable)?;
        let now = transaction_now(&mut transaction).await?;
        let organization = Organization::new(OrganizationFields {
            id: OrganizationId::new(),
            slug,
            display_name,
            status: OrganizationStatus::Active,
            created_at: now,
            updated_at: now,
            archived_at: None,
            lock_version: OrganizationVersion::new(1)
                .map_err(|_| OrganizationServiceError::InvariantViolation)?,
        })
        .map_err(|_| OrganizationServiceError::InvalidInput)?;
        let fields = organization.clone().into_fields();
        require_active_user(&mut transaction, creator_user_id, false).await?;

        let insert = sqlx::query(
            "INSERT INTO organizations \
             (id, slug, display_name, status, created_at, updated_at, lock_version) \
             VALUES ($1::uuid, $2, $3, 'active', $4::timestamptz, $4::timestamptz, 1)",
        )
        .bind(fields.id.to_string())
        .bind(&fields.slug)
        .bind(&fields.display_name)
        .bind(fields.created_at.to_string())
        .execute(&mut *transaction)
        .await;
        if let Err(error) = insert {
            return Err(if is_unique_violation(&error) {
                OrganizationServiceError::DuplicateSlug
            } else {
                OrganizationServiceError::DatabaseUnavailable
            });
        }

        sqlx::query(
            "INSERT INTO organization_memberships \
             (organization_id, user_id, role, created_at, updated_at) \
             VALUES ($1::uuid, $2::uuid, 'owner', $3::timestamptz, $3::timestamptz)",
        )
        .bind(fields.id.to_string())
        .bind(creator_user_id.to_string())
        .bind(now.to_string())
        .execute(&mut *transaction)
        .await
        .map_err(|_| OrganizationServiceError::DatabaseUnavailable)?;

        OrganizationStorageScopeRepository::provision(&mut transaction, fields.id, now)
            .await
            .map_err(|error| match error {
                StorageScopeRepositoryError::PersistenceUnavailable => {
                    OrganizationServiceError::DatabaseUnavailable
                }
                StorageScopeRepositoryError::InvalidPersistedState => {
                    OrganizationServiceError::InvariantViolation
                }
            })?;

        append_audit(
            &mut transaction,
            audit,
            now,
            fields.id,
            "organization.created",
            vec![
                "organization".into(),
                "membership.owner".into(),
                "storage_scope".into(),
            ],
        )
        .await?;
        commit(transaction).await?;
        Ok(organization)
    }

    async fn get_inner(
        &self,
        principal: OrganizationPrincipal,
        organization_id: OrganizationId,
    ) -> Result<Organization, OrganizationServiceError> {
        let mut connection = self
            .pool
            .acquire()
            .await
            .map_err(|_| OrganizationServiceError::DatabaseUnavailable)?;
        let row = sqlx::query_as::<_, OrganizationRow>(
            "SELECT o.id::text, o.slug, o.display_name, o.status, o.created_at, o.updated_at, \
                    o.archived_at, o.lock_version \
             FROM organizations o \
             JOIN users actor ON actor.id = $2::uuid \
             LEFT JOIN organization_memberships membership \
               ON membership.organization_id = o.id AND membership.user_id = actor.id \
             WHERE o.id = $1::uuid AND actor.status = 'active' \
               AND (($3 AND actor.is_instance_admin) OR (NOT $3 AND membership.role IS NOT NULL))",
        )
        .bind(organization_id.to_string())
        .bind(principal.user_id().to_string())
        .bind(matches!(
            principal,
            OrganizationPrincipal::InstanceAdministrator(_)
        ))
        .fetch_optional(&mut *connection)
        .await
        .map_err(|_| OrganizationServiceError::DatabaseUnavailable)?
        .ok_or(OrganizationServiceError::NotFound)?;
        decode_organization(row)
    }

    async fn update_display_name_inner(
        &self,
        principal: OrganizationPrincipal,
        organization_id: OrganizationId,
        expected_version: OrganizationVersion,
        display_name: String,
        audit: &OrganizationAuditContext,
    ) -> Result<Organization, OrganizationServiceError> {
        super::model::validate_display_name(&display_name)
            .map_err(|_| OrganizationServiceError::InvalidInput)?;
        let mut connection = self.acquire().await?;
        let mut transaction = connection
            .begin()
            .await
            .map_err(|_| OrganizationServiceError::DatabaseUnavailable)?;
        let now = transaction_now(&mut transaction).await?;
        let locked = lock_and_authorize_owner(&mut transaction, principal, organization_id).await?;
        ensure_active_and_version(&locked, expected_version)?;
        let candidate = Organization::new(OrganizationFields {
            display_name: display_name.clone(),
            updated_at: now,
            lock_version: expected_version
                .next()
                .map_err(|_| OrganizationServiceError::StaleVersion)?,
            ..decode_organization(locked.clone())?.into_fields()
        })
        .map_err(|_| OrganizationServiceError::InvalidInput)?;
        update_organization(
            &mut transaction,
            organization_id,
            expected_version,
            "display_name",
            &display_name,
            now,
        )
        .await?;
        append_audit(
            &mut transaction,
            audit,
            now,
            organization_id,
            "organization.updated",
            vec!["display_name".into()],
        )
        .await?;
        commit(transaction).await?;
        Ok(candidate)
    }

    async fn archive_inner(
        &self,
        principal: OrganizationPrincipal,
        organization_id: OrganizationId,
        expected_version: OrganizationVersion,
        audit: &OrganizationAuditContext,
    ) -> Result<Organization, OrganizationServiceError> {
        let mut connection = self.acquire().await?;
        let mut transaction = connection
            .begin()
            .await
            .map_err(|_| OrganizationServiceError::DatabaseUnavailable)?;
        let now = transaction_now(&mut transaction).await?;
        let locked = lock_and_authorize_owner(&mut transaction, principal, organization_id).await?;
        ensure_active_and_version(&locked, expected_version)?;
        let next_version = expected_version
            .next()
            .map_err(|_| OrganizationServiceError::StaleVersion)?;
        let archived = Organization::new(OrganizationFields {
            status: OrganizationStatus::Archived,
            updated_at: now,
            archived_at: Some(now),
            lock_version: next_version,
            ..decode_organization(locked)?.into_fields()
        })
        .map_err(|_| OrganizationServiceError::InvariantViolation)?;
        let result = sqlx::query(
            "UPDATE organizations SET status = 'archived', archived_at = $3::timestamptz, \
             updated_at = $3::timestamptz, lock_version = lock_version + 1 \
             WHERE id = $1::uuid AND lock_version = $2 AND status = 'active'",
        )
        .bind(organization_id.to_string())
        .bind(expected_version.get())
        .bind(now.to_string())
        .execute(&mut *transaction)
        .await
        .map_err(|_| OrganizationServiceError::DatabaseUnavailable)?;
        if result.rows_affected() != 1 {
            return Err(OrganizationServiceError::StaleVersion);
        }
        append_audit(
            &mut transaction,
            audit,
            now,
            organization_id,
            "organization.archived",
            vec!["status".into(), "archived_at".into()],
        )
        .await?;
        commit(transaction).await?;
        Ok(archived)
    }

    async fn add_member_inner(
        &self,
        principal: OrganizationPrincipal,
        organization_id: OrganizationId,
        user_id: UserId,
        role: OrganizationRole,
        audit: &OrganizationAuditContext,
    ) -> Result<MembershipAddResult, OrganizationServiceError> {
        let mut connection = self.acquire().await?;
        let mut transaction = connection
            .begin()
            .await
            .map_err(|_| OrganizationServiceError::DatabaseUnavailable)?;
        let now = transaction_now(&mut transaction).await?;
        lock_membership_admission(&mut transaction, organization_id).await?;
        let locked = lock_and_authorize_owner(&mut transaction, principal, organization_id).await?;
        ensure_active(&locked)?;
        if membership_role(&mut transaction, organization_id, user_id)
            .await?
            .is_some()
        {
            return Ok(MembershipAddResult::AlreadyMember);
        }
        require_active_user(&mut transaction, user_id, false).await?;
        ensure_member_capacity(&mut transaction, organization_id).await?;
        sqlx::query(
            "INSERT INTO organization_memberships \
             (organization_id, user_id, role, created_at, updated_at) \
             VALUES ($1::uuid, $2::uuid, $3, $4::timestamptz, $4::timestamptz)",
        )
        .bind(organization_id.to_string())
        .bind(user_id.to_string())
        .bind(role_name(role))
        .bind(now.to_string())
        .execute(&mut *transaction)
        .await
        .map_err(membership_write_error)?;
        append_membership_audit(
            &mut transaction,
            audit,
            now,
            organization_id,
            user_id,
            "organization.member_added",
            vec!["membership".into(), "role".into()],
        )
        .await?;
        commit(transaction).await?;
        Ok(MembershipAddResult::Added)
    }

    async fn change_member_role_inner(
        &self,
        principal: OrganizationPrincipal,
        organization_id: OrganizationId,
        user_id: UserId,
        role: OrganizationRole,
        audit: &OrganizationAuditContext,
    ) -> Result<MembershipChangeResult, OrganizationServiceError> {
        let mut connection = self.acquire().await?;
        let mut transaction = connection
            .begin()
            .await
            .map_err(|_| OrganizationServiceError::DatabaseUnavailable)?;
        let now = transaction_now(&mut transaction).await?;
        let locked = lock_and_authorize_owner(&mut transaction, principal, organization_id).await?;
        ensure_active(&locked)?;
        require_active_user(&mut transaction, user_id, false).await?;
        let current = membership_role(&mut transaction, organization_id, user_id)
            .await?
            .ok_or(OrganizationServiceError::MemberNotFound)?;
        if current == role {
            return Ok(MembershipChangeResult::Unchanged);
        }
        if current == OrganizationRole::Owner && role == OrganizationRole::Member {
            ensure_another_owner(&mut transaction, organization_id).await?;
        }
        sqlx::query(
            "UPDATE organization_memberships SET role = $3, updated_at = $4::timestamptz \
             WHERE organization_id = $1::uuid AND user_id = $2::uuid",
        )
        .bind(organization_id.to_string())
        .bind(user_id.to_string())
        .bind(role_name(role))
        .bind(now.to_string())
        .execute(&mut *transaction)
        .await
        .map_err(|_| OrganizationServiceError::DatabaseUnavailable)?;
        append_membership_audit(
            &mut transaction,
            audit,
            now,
            organization_id,
            user_id,
            "organization.member_role_changed",
            vec!["role".into()],
        )
        .await?;
        commit(transaction).await?;
        Ok(MembershipChangeResult::Changed)
    }

    async fn remove_member_inner(
        &self,
        principal: OrganizationPrincipal,
        organization_id: OrganizationId,
        user_id: UserId,
        audit: &OrganizationAuditContext,
    ) -> Result<MembershipRemoveResult, OrganizationServiceError> {
        let mut connection = self.acquire().await?;
        let mut transaction = connection
            .begin()
            .await
            .map_err(|_| OrganizationServiceError::DatabaseUnavailable)?;
        let now = transaction_now(&mut transaction).await?;
        let locked = lock_and_authorize_owner(&mut transaction, principal, organization_id).await?;
        ensure_active(&locked)?;
        let Some(current) = membership_role(&mut transaction, organization_id, user_id).await?
        else {
            return Ok(MembershipRemoveResult::AlreadyAbsent);
        };
        if current == OrganizationRole::Owner {
            ensure_another_owner(&mut transaction, organization_id).await?;
        }
        sqlx::query(
            "DELETE FROM organization_memberships \
             WHERE organization_id = $1::uuid AND user_id = $2::uuid",
        )
        .bind(organization_id.to_string())
        .bind(user_id.to_string())
        .execute(&mut *transaction)
        .await
        .map_err(|_| OrganizationServiceError::DatabaseUnavailable)?;
        append_membership_audit(
            &mut transaction,
            audit,
            now,
            organization_id,
            user_id,
            "organization.member_removed",
            vec!["membership".into()],
        )
        .await?;
        commit(transaction).await?;
        Ok(MembershipRemoveResult::Removed)
    }

    async fn acquire(
        &self,
    ) -> Result<sqlx::pool::PoolConnection<Postgres>, OrganizationServiceError> {
        self.pool
            .acquire()
            .await
            .map_err(|_| OrganizationServiceError::DatabaseUnavailable)
    }

    async fn within_deadline<T>(
        &self,
        operation: impl Future<Output = Result<T, OrganizationServiceError>>,
    ) -> Result<T, OrganizationServiceError> {
        tokio_time::timeout(self.policy.operation_timeout, operation)
            .await
            .map_err(|_| OrganizationServiceError::OperationTimeout)?
    }

    fn ensure_audit_actor(
        &self,
        actor_user_id: UserId,
        audit: &OrganizationAuditContext,
    ) -> Result<(), OrganizationServiceError> {
        if audit.actor_user_id != actor_user_id {
            return Err(OrganizationServiceError::InvalidInput);
        }
        Ok(())
    }
}

type OrganizationRow = (
    String,
    String,
    String,
    String,
    OffsetDateTime,
    OffsetDateTime,
    Option<OffsetDateTime>,
    i64,
);

type AuthorizedOrganizationRow = (
    String,
    String,
    String,
    String,
    OffsetDateTime,
    OffsetDateTime,
    Option<OffsetDateTime>,
    i64,
    String,
    bool,
    Option<String>,
);

async fn lock_and_authorize_owner(
    transaction: &mut Transaction<'_, Postgres>,
    principal: OrganizationPrincipal,
    organization_id: OrganizationId,
) -> Result<OrganizationRow, OrganizationServiceError> {
    let row = sqlx::query_as::<_, AuthorizedOrganizationRow>(
        "SELECT o.id::text, o.slug, o.display_name, o.status, o.created_at, o.updated_at, \
                o.archived_at, o.lock_version, actor.status, actor.is_instance_admin, membership.role \
         FROM organizations o \
         JOIN users actor ON actor.id = $2::uuid \
         LEFT JOIN organization_memberships membership \
           ON membership.organization_id = o.id AND membership.user_id = actor.id \
         WHERE o.id = $1::uuid FOR UPDATE OF o",
    )
    .bind(organization_id.to_string())
    .bind(principal.user_id().to_string())
    .fetch_optional(&mut **transaction)
    .await
    .map_err(|_| OrganizationServiceError::DatabaseUnavailable)?
    .ok_or(OrganizationServiceError::NotFound)?;
    let organization = (row.0, row.1, row.2, row.3, row.4, row.5, row.6, row.7);
    let actor_status = row.8;
    let is_admin = row.9;
    let role = row.10;
    if actor_status != "active" {
        return Err(OrganizationServiceError::Unauthorized);
    }
    let authorized = match principal {
        OrganizationPrincipal::Owner(_) => role.as_deref() == Some("owner"),
        OrganizationPrincipal::InstanceAdministrator(_) => is_admin,
    };
    if !authorized {
        return Err(OrganizationServiceError::Unauthorized);
    }
    Ok(organization)
}

async fn require_active_user(
    transaction: &mut Transaction<'_, Postgres>,
    user_id: UserId,
    require_admin: bool,
) -> Result<(), OrganizationServiceError> {
    let active: Option<bool> = sqlx::query_scalar(
        "SELECT status = 'active' AND (NOT $2 OR is_instance_admin) \
         FROM users WHERE id = $1::uuid FOR SHARE",
    )
    .bind(user_id.to_string())
    .bind(require_admin)
    .fetch_optional(&mut **transaction)
    .await
    .map_err(|_| OrganizationServiceError::DatabaseUnavailable)?;
    if active != Some(true) {
        return Err(OrganizationServiceError::UserUnavailable);
    }
    Ok(())
}

async fn membership_role(
    transaction: &mut Transaction<'_, Postgres>,
    organization_id: OrganizationId,
    user_id: UserId,
) -> Result<Option<OrganizationRole>, OrganizationServiceError> {
    let role: Option<String> = sqlx::query_scalar(
        "SELECT role FROM organization_memberships \
         WHERE organization_id = $1::uuid AND user_id = $2::uuid",
    )
    .bind(organization_id.to_string())
    .bind(user_id.to_string())
    .fetch_optional(&mut **transaction)
    .await
    .map_err(|_| OrganizationServiceError::DatabaseUnavailable)?;
    role.map(|value| parse_role(&value)).transpose()
}

async fn lock_membership_admission(
    transaction: &mut Transaction<'_, Postgres>,
    organization_id: OrganizationId,
) -> Result<(), OrganizationServiceError> {
    sqlx::query("SELECT pg_advisory_xact_lock(1314212943, hashtext($1))")
        .bind(organization_id.to_string())
        .execute(&mut **transaction)
        .await
        .map_err(|_| OrganizationServiceError::DatabaseUnavailable)?;
    Ok(())
}

async fn ensure_member_capacity(
    transaction: &mut Transaction<'_, Postgres>,
    organization_id: OrganizationId,
) -> Result<(), OrganizationServiceError> {
    let members: i64 = sqlx::query_scalar(
        "SELECT COUNT(*) FROM organization_memberships \
         WHERE organization_id = $1::uuid",
    )
    .bind(organization_id.to_string())
    .fetch_one(&mut **transaction)
    .await
    .map_err(|_| OrganizationServiceError::DatabaseUnavailable)?;
    if members >= super::MAX_MEMBERS {
        return Err(OrganizationServiceError::MemberLimitReached);
    }
    Ok(())
}

fn membership_write_error(error: sqlx::Error) -> OrganizationServiceError {
    if error.as_database_error().is_some_and(|database| {
        database.code().as_deref() == Some("23514")
            && database.constraint() == Some("organization_member_limit")
    }) {
        OrganizationServiceError::MemberLimitReached
    } else {
        OrganizationServiceError::DatabaseUnavailable
    }
}

async fn ensure_another_owner(
    transaction: &mut Transaction<'_, Postgres>,
    organization_id: OrganizationId,
) -> Result<(), OrganizationServiceError> {
    let owners: i64 = sqlx::query_scalar(
        "SELECT COUNT(*) FROM organization_memberships \
         WHERE organization_id = $1::uuid AND role = 'owner'",
    )
    .bind(organization_id.to_string())
    .fetch_one(&mut **transaction)
    .await
    .map_err(|_| OrganizationServiceError::DatabaseUnavailable)?;
    if owners <= 1 {
        return Err(OrganizationServiceError::LastOwner);
    }
    Ok(())
}

fn ensure_active(row: &OrganizationRow) -> Result<(), OrganizationServiceError> {
    if row.3 != "active" {
        return Err(OrganizationServiceError::Archived);
    }
    Ok(())
}

fn ensure_active_and_version(
    row: &OrganizationRow,
    expected: OrganizationVersion,
) -> Result<(), OrganizationServiceError> {
    ensure_active(row)?;
    if row.7 != expected.get() {
        return Err(OrganizationServiceError::StaleVersion);
    }
    Ok(())
}

async fn update_organization(
    transaction: &mut Transaction<'_, Postgres>,
    organization_id: OrganizationId,
    expected_version: OrganizationVersion,
    field: &str,
    value: &str,
    now: Timestamp,
) -> Result<(), OrganizationServiceError> {
    if field != "display_name" {
        return Err(OrganizationServiceError::InvariantViolation);
    }
    let result = sqlx::query(
        "UPDATE organizations SET display_name = $3, updated_at = $4::timestamptz, \
         lock_version = lock_version + 1 WHERE id = $1::uuid AND lock_version = $2",
    )
    .bind(organization_id.to_string())
    .bind(expected_version.get())
    .bind(value)
    .bind(now.to_string())
    .execute(&mut **transaction)
    .await
    .map_err(|_| OrganizationServiceError::DatabaseUnavailable)?;
    if result.rows_affected() != 1 {
        return Err(OrganizationServiceError::StaleVersion);
    }
    Ok(())
}

async fn append_audit(
    transaction: &mut Transaction<'_, Postgres>,
    audit: &OrganizationAuditContext,
    occurred_at: Timestamp,
    organization_id: OrganizationId,
    action: &str,
    changed_fields: Vec<String>,
) -> Result<(), OrganizationServiceError> {
    append_audit_target(
        transaction,
        audit,
        occurred_at,
        organization_id,
        action,
        "organization",
        organization_id.to_string(),
        changed_fields,
    )
    .await
}

async fn append_membership_audit(
    transaction: &mut Transaction<'_, Postgres>,
    audit: &OrganizationAuditContext,
    occurred_at: Timestamp,
    organization_id: OrganizationId,
    user_id: UserId,
    action: &str,
    changed_fields: Vec<String>,
) -> Result<(), OrganizationServiceError> {
    append_audit_target(
        transaction,
        audit,
        occurred_at,
        organization_id,
        action,
        "organization_membership",
        user_id.to_string(),
        changed_fields,
    )
    .await
}

#[allow(
    clippy::too_many_arguments,
    reason = "audit fields are explicit security context"
)]
async fn append_audit_target(
    transaction: &mut Transaction<'_, Postgres>,
    audit: &OrganizationAuditContext,
    occurred_at: Timestamp,
    organization_id: OrganizationId,
    action: &str,
    target_kind: &str,
    target_id: String,
    changed_fields: Vec<String>,
) -> Result<(), OrganizationServiceError> {
    let event = AuditEvent::new(AuditEventFields {
        id: audit.event_id,
        occurred_at,
        actor: AuditActor {
            kind: ActorType::User,
            id: audit.actor_user_id.to_string(),
            user_id: Some(audit.actor_user_id),
            display_name: audit.actor_display_name.clone(),
        },
        action_code: action.into(),
        target: AuditTarget {
            kind: target_kind.into(),
            id: target_id,
        },
        scope: AuditScope {
            kind: ScopeType::Organization,
            id: organization_id.to_string(),
        },
        result: AuditResult::Succeeded,
        reason_code: None,
        correlation_id: audit.correlation_id.clone(),
        source_ip: audit.source_ip,
        schema_version: 1,
        changed_fields,
        metadata: AuditMetadata::new(json!({"source": "organization-service"}))
            .map_err(|_| OrganizationServiceError::InvariantViolation)?,
    })
    .map_err(|_| OrganizationServiceError::InvalidInput)?;
    AuditWriter::append(transaction, &event)
        .await
        .map_err(|_| OrganizationServiceError::AuditUnavailable)
}

async fn commit(transaction: Transaction<'_, Postgres>) -> Result<(), OrganizationServiceError> {
    transaction
        .commit()
        .await
        .map_err(|_| OrganizationServiceError::DatabaseUnavailable)
}

fn decode_organization(row: OrganizationRow) -> Result<Organization, OrganizationServiceError> {
    Organization::new(OrganizationFields {
        id: row
            .0
            .parse()
            .map_err(|_| OrganizationServiceError::InvariantViolation)?,
        slug: row.1,
        display_name: row.2,
        status: match row.3.as_str() {
            "active" => OrganizationStatus::Active,
            "archived" => OrganizationStatus::Archived,
            _ => return Err(OrganizationServiceError::InvariantViolation),
        },
        created_at: Timestamp::from_datetime(row.4)
            .map_err(|_| OrganizationServiceError::InvariantViolation)?,
        updated_at: Timestamp::from_datetime(row.5)
            .map_err(|_| OrganizationServiceError::InvariantViolation)?,
        archived_at: row
            .6
            .map(Timestamp::from_datetime)
            .transpose()
            .map_err(|_| OrganizationServiceError::InvariantViolation)?,
        lock_version: OrganizationVersion::new(row.7)
            .map_err(|_| OrganizationServiceError::InvariantViolation)?,
    })
    .map_err(|_| OrganizationServiceError::InvariantViolation)
}

fn role_name(role: OrganizationRole) -> &'static str {
    match role {
        OrganizationRole::Owner => "owner",
        OrganizationRole::Member => "member",
    }
}

fn parse_role(role: &str) -> Result<OrganizationRole, OrganizationServiceError> {
    match role {
        "owner" => Ok(OrganizationRole::Owner),
        "member" => Ok(OrganizationRole::Member),
        _ => Err(OrganizationServiceError::InvariantViolation),
    }
}

async fn transaction_now(
    transaction: &mut Transaction<'_, Postgres>,
) -> Result<Timestamp, OrganizationServiceError> {
    let value: OffsetDateTime = sqlx::query_scalar("SELECT transaction_timestamp()")
        .fetch_one(&mut **transaction)
        .await
        .map_err(|_| OrganizationServiceError::DatabaseUnavailable)?;
    Timestamp::from_datetime(value).map_err(|_| OrganizationServiceError::InvariantViolation)
}

fn is_unique_violation(error: &sqlx::Error) -> bool {
    matches!(error, sqlx::Error::Database(database) if database.is_unique_violation())
}

#[cfg(test)]
mod tests;
