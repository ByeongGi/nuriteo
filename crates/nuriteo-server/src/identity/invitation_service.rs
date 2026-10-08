use std::fmt;
use std::future::Future;
use std::net::IpAddr;
use std::pin::Pin;
use std::time::Duration;

use serde_json::json;
use sqlx::{Acquire, Postgres, Row, Transaction};
use time::OffsetDateTime;
use tokio::time as tokio_time;
use uuid::Uuid;

use crate::audit::{
    ActorType, AuditActor, AuditEvent, AuditEventFields, AuditEventId, AuditMetadata, AuditResult,
    AuditScope, AuditTarget, AuditWriter, ScopeType,
};
use crate::database::DatabasePool;
use crate::policy::EffectivePolicyEngine;

use super::{
    ActivationInvitation, ActivationInvitationFields, ActivationInvitationId,
    ActivationInvitationStatus, ActivationToken, ActivationTokenError, InvitationExpiryPolicy,
    NormalizedEmail, Timestamp, UserId,
};

const DEFAULT_OPERATION_TIMEOUT: Duration = Duration::from_secs(5);
const MIN_OPERATION_TIMEOUT: Duration = Duration::from_millis(100);
const MAX_OPERATION_TIMEOUT: Duration = Duration::from_secs(30);

#[derive(Clone)]
pub struct InvitationAuditContext {
    event_id: AuditEventId,
    actor: AuditActor,
    correlation_id: String,
    source_ip: Option<IpAddr>,
    instance_id: String,
}

impl InvitationAuditContext {
    #[must_use]
    pub fn new(
        event_id: AuditEventId,
        actor: AuditActor,
        correlation_id: String,
        source_ip: Option<IpAddr>,
        instance_id: String,
    ) -> Self {
        Self {
            event_id,
            actor,
            correlation_id,
            source_ip,
            instance_id,
        }
    }
}

impl fmt::Debug for InvitationAuditContext {
    fn fmt(&self, formatter: &mut fmt::Formatter<'_>) -> fmt::Result {
        formatter
            .debug_struct("InvitationAuditContext")
            .field("event_id", &self.event_id)
            .field("actor_type", &self.actor.kind)
            .finish_non_exhaustive()
    }
}

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub struct InvitationServicePolicy {
    expiry: InvitationExpiryPolicy,
    operation_timeout: Duration,
}

impl InvitationServicePolicy {
    pub fn new(
        expiry: InvitationExpiryPolicy,
        operation_timeout: Duration,
    ) -> Result<Self, InvitationServicePolicyError> {
        if !(MIN_OPERATION_TIMEOUT..=MAX_OPERATION_TIMEOUT).contains(&operation_timeout) {
            return Err(InvitationServicePolicyError::InvalidOperationTimeout);
        }
        Ok(Self {
            expiry,
            operation_timeout,
        })
    }

    #[must_use]
    pub const fn expiry(self) -> InvitationExpiryPolicy {
        self.expiry
    }

    #[must_use]
    pub const fn operation_timeout(self) -> Duration {
        self.operation_timeout
    }
}

impl Default for InvitationServicePolicy {
    fn default() -> Self {
        Self {
            expiry: InvitationExpiryPolicy::default(),
            operation_timeout: DEFAULT_OPERATION_TIMEOUT,
        }
    }
}

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum InvitationServicePolicyError {
    InvalidOperationTimeout,
}

impl fmt::Display for InvitationServicePolicyError {
    fn fmt(&self, formatter: &mut fmt::Formatter<'_>) -> fmt::Result {
        formatter.write_str("invitation operation timeout is invalid")
    }
}

impl std::error::Error for InvitationServicePolicyError {}

pub struct IssuedActivationInvitation {
    invitation: ActivationInvitation,
    token: ActivationToken,
    email_delivery_queued: bool,
}

impl IssuedActivationInvitation {
    #[must_use]
    pub const fn invitation(&self) -> &ActivationInvitation {
        &self.invitation
    }

    #[must_use]
    pub const fn token(&self) -> &ActivationToken {
        &self.token
    }

    #[must_use]
    pub const fn email_delivery_queued(&self) -> bool {
        self.email_delivery_queued
    }

    #[must_use]
    pub fn into_parts(self) -> (ActivationInvitation, ActivationToken) {
        (self.invitation, self.token)
    }
}

impl fmt::Debug for IssuedActivationInvitation {
    fn fmt(&self, formatter: &mut fmt::Formatter<'_>) -> fmt::Result {
        formatter
            .debug_struct("IssuedActivationInvitation")
            .field("invitation", &self.invitation)
            .field("token", &"[REDACTED]")
            .finish()
    }
}

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum InvitationRevokeResult {
    Revoked,
    AlreadyInactive,
}

#[derive(Debug, Clone, PartialEq, Eq)]
pub struct PendingInvitationActivation {
    invitation_id: ActivationInvitationId,
    normalized_email: NormalizedEmail,
}

impl PendingInvitationActivation {
    #[must_use]
    pub const fn invitation_id(&self) -> ActivationInvitationId {
        self.invitation_id
    }

    #[must_use]
    pub const fn normalized_email(&self) -> &NormalizedEmail {
        &self.normalized_email
    }
}

pub type InvitationActivationFuture<'a> =
    Pin<Box<dyn Future<Output = Result<(), InvitationActivationError>> + Send + 'a>>;

/// Performs caller-owned User and credential activation inside the invitation
/// transaction. Implementations should precompute expensive credential work and
/// only persist the validated result here. User-creating implementations must
/// also provision the Personal storage scope through the transaction-bound
/// `crate::workspace::PersonalStorageScopeRepository` before returning.
pub trait InvitationActivator: Send + Sync {
    fn activate<'a>(
        &'a self,
        transaction: &'a mut Transaction<'_, Postgres>,
        invitation: &'a PendingInvitationActivation,
    ) -> InvitationActivationFuture<'a>;
}

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum InvitationActivationError {
    Rejected,
    DatabaseUnavailable,
    InvariantViolation,
}

impl fmt::Display for InvitationActivationError {
    fn fmt(&self, formatter: &mut fmt::Formatter<'_>) -> fmt::Result {
        formatter.write_str(match self {
            Self::Rejected => "invitation activation was rejected",
            Self::DatabaseUnavailable => "invitation activation persistence is unavailable",
            Self::InvariantViolation => "invitation activation state is invalid",
        })
    }
}

impl std::error::Error for InvitationActivationError {}

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum InvitationServiceError {
    AlreadyPending,
    InvalidInvitation,
    InvitationNotPending,
    InviterUnavailable,
    ActivationFailed,
    EntropyUnavailable,
    InvalidAuditContext,
    AuditUnavailable,
    DatabaseUnavailable,
    OperationTimeout,
    InvariantViolation,
}

impl fmt::Display for InvitationServiceError {
    fn fmt(&self, formatter: &mut fmt::Formatter<'_>) -> fmt::Result {
        formatter.write_str(match self {
            Self::AlreadyPending => "a pending invitation already exists",
            Self::InvalidInvitation => "activation invitation is invalid",
            Self::InvitationNotPending => "activation invitation is not pending",
            Self::InviterUnavailable => "invitation administrator is unavailable",
            Self::ActivationFailed => "invitation activation failed",
            Self::EntropyUnavailable => "invitation credential generation failed",
            Self::InvalidAuditContext => "invitation audit context is invalid",
            Self::AuditUnavailable => "invitation audit persistence is unavailable",
            Self::DatabaseUnavailable => "invitation persistence is unavailable",
            Self::OperationTimeout => "invitation operation timed out",
            Self::InvariantViolation => "invitation state is invalid",
        })
    }
}

impl std::error::Error for InvitationServiceError {}

#[derive(Clone)]
pub struct InvitationService {
    pool: DatabasePool,
    policy: InvitationServicePolicy,
    live_default_expiry: bool,
}

impl InvitationService {
    #[must_use]
    pub const fn new(pool: DatabasePool, policy: InvitationServicePolicy) -> Self {
        Self {
            pool,
            policy,
            live_default_expiry: false,
        }
    }

    #[must_use]
    pub fn new_live_default(pool: DatabasePool, operation_timeout: Duration) -> Self {
        Self {
            pool,
            policy: InvitationServicePolicy {
                expiry: InvitationExpiryPolicy::default(),
                operation_timeout,
            },
            live_default_expiry: true,
        }
    }

    #[must_use]
    pub const fn policy(&self) -> InvitationServicePolicy {
        self.policy
    }

    pub async fn issue(
        &self,
        email: &str,
        invited_by_user_id: UserId,
        audit: &InvitationAuditContext,
    ) -> Result<IssuedActivationInvitation, InvitationServiceError> {
        let normalized_email = NormalizedEmail::from_email(email)
            .map_err(|_| InvitationServiceError::InvalidInvitation)?;
        let token = ActivationToken::generate().map_err(map_token_error)?;
        self.within_deadline(self.issue_inner(
            normalized_email,
            invited_by_user_id,
            ActivationInvitationId::new(),
            token,
            audit,
        ))
        .await
    }

    pub async fn reissue(
        &self,
        invitation_id: ActivationInvitationId,
        audit: &InvitationAuditContext,
    ) -> Result<IssuedActivationInvitation, InvitationServiceError> {
        let token = ActivationToken::generate().map_err(map_token_error)?;
        self.within_deadline(self.reissue_inner(
            invitation_id,
            ActivationInvitationId::new(),
            token,
            audit,
        ))
        .await
    }

    pub async fn revoke(
        &self,
        invitation_id: ActivationInvitationId,
        audit: &InvitationAuditContext,
    ) -> Result<InvitationRevokeResult, InvitationServiceError> {
        self.within_deadline(self.revoke_inner(invitation_id, audit))
            .await
    }

    /// Returns bounded safe invitation metadata for an active instance
    /// administrator. Bearer credentials and digests are never selected.
    pub async fn list(
        &self,
        administrator_id: UserId,
    ) -> Result<Vec<ActivationInvitation>, InvitationServiceError> {
        self.within_deadline(self.list_inner(administrator_id))
            .await
    }

    /// Accepts an invitation only after the supplied activator has completed
    /// User and credential persistence in this same transaction.
    pub async fn accept<A>(
        &self,
        token: &ActivationToken,
        audit: &InvitationAuditContext,
        activator: &A,
    ) -> Result<ActivationInvitation, InvitationServiceError>
    where
        A: InvitationActivator,
    {
        let digest = token.digest();
        self.within_deadline(self.accept_inner(digest.as_bytes(), audit, activator))
            .await
    }

    async fn within_deadline<T>(
        &self,
        operation: impl Future<Output = Result<T, InvitationServiceError>>,
    ) -> Result<T, InvitationServiceError> {
        tokio_time::timeout(self.policy.operation_timeout, operation)
            .await
            .map_err(|_| InvitationServiceError::OperationTimeout)?
    }

    async fn effective_expiry(
        &self,
        transaction: &mut Transaction<'_, Postgres>,
    ) -> Result<InvitationExpiryPolicy, InvitationServiceError> {
        if !self.live_default_expiry {
            return Ok(self.policy.expiry);
        }
        EffectivePolicyEngine::load_optional_in_transaction(transaction)
            .await
            .and_then(|snapshot| {
                snapshot.map_or(Ok(self.policy.expiry), |snapshot| {
                    snapshot.invitation_expiry()
                })
            })
            .map_err(|_| InvitationServiceError::InvariantViolation)
    }

    async fn issue_inner(
        &self,
        email: NormalizedEmail,
        inviter: UserId,
        id: ActivationInvitationId,
        token: ActivationToken,
        audit: &InvitationAuditContext,
    ) -> Result<IssuedActivationInvitation, InvitationServiceError> {
        let mut connection = self.acquire().await?;
        let mut transaction = connection.begin().await.map_err(database_error)?;
        require_issuing_admin(&mut transaction, inviter, audit).await?;
        lock_email(&mut transaction, &email).await?;
        expire_pending_for_email(&mut transaction, &email).await?;

        if let Some(existing) = pending_id_for_email(&mut transaction, &email).await? {
            append_audit(
                &mut transaction,
                audit,
                AuditInput::denied(
                    "invitation.issue",
                    existing.to_string(),
                    "INVITATION_ALREADY_PENDING",
                ),
            )
            .await?;
            transaction.commit().await.map_err(database_error)?;
            return Err(InvitationServiceError::AlreadyPending);
        }

        let created_at = transaction_now(&mut transaction).await?;
        let expires_at = self
            .effective_expiry(&mut transaction)
            .await?
            .expires_at(created_at)
            .map_err(|_| InvitationServiceError::InvariantViolation)?;
        let row = insert_pending(
            &mut transaction,
            id,
            &email,
            inviter,
            token.digest().as_bytes(),
            created_at,
            expires_at,
        )
        .await?;
        let invitation = invitation_from_row(&row)?;
        append_audit(
            &mut transaction,
            audit,
            AuditInput::success(
                "invitation.issue",
                id.to_string(),
                &["status", "expires_at"],
                json!({}),
            ),
        )
        .await?;
        let email_delivery_queued = enqueue_activation_email(&mut transaction, id, &email).await?;
        transaction.commit().await.map_err(database_error)?;
        Ok(IssuedActivationInvitation {
            invitation,
            token,
            email_delivery_queued,
        })
    }

    async fn reissue_inner(
        &self,
        id: ActivationInvitationId,
        replacement_id: ActivationInvitationId,
        token: ActivationToken,
        audit: &InvitationAuditContext,
    ) -> Result<IssuedActivationInvitation, InvitationServiceError> {
        let mut connection = self.acquire().await?;
        let mut transaction = connection.begin().await.map_err(database_error)?;
        require_context_admin(&mut transaction, audit).await?;
        let Some(email) = invitation_email(&mut transaction, id).await? else {
            append_denied_and_commit(
                transaction,
                audit,
                "invitation.reissue",
                id.to_string(),
                "INVITATION_NOT_PENDING",
            )
            .await?;
            return Err(InvitationServiceError::InvitationNotPending);
        };
        lock_email(&mut transaction, &email).await?;
        let Some(row) = lock_invitation(&mut transaction, id).await? else {
            return Err(InvitationServiceError::InvitationNotPending);
        };
        let status: String = required(&row, "status")?;
        let expires_at: OffsetDateTime = required(&row, "expires_at")?;
        let now = transaction_now_datetime(&mut transaction).await?;
        if status != "pending" || expires_at <= now {
            if status == "pending" {
                mark_expired(&mut transaction, id).await?;
            }
            append_denied_and_commit(
                transaction,
                audit,
                "invitation.reissue",
                id.to_string(),
                if expires_at <= now {
                    "INVITATION_EXPIRED"
                } else {
                    "INVITATION_NOT_PENDING"
                },
            )
            .await?;
            return Err(InvitationServiceError::InvitationNotPending);
        }

        let updated = sqlx::query(
            "UPDATE activation_invitations SET status = 'superseded', \
             superseded_at = transaction_timestamp(), replaced_by_invitation_id = $2::uuid \
             WHERE id = $1::uuid AND status = 'pending'",
        )
        .bind(id.to_string())
        .bind(replacement_id.to_string())
        .execute(&mut *transaction)
        .await
        .map_err(database_error)?;
        if updated.rows_affected() != 1 {
            return Err(InvitationServiceError::InvariantViolation);
        }
        let now = Timestamp::from_datetime(now)
            .map_err(|_| InvitationServiceError::InvariantViolation)?;
        let replacement_expiry = self
            .effective_expiry(&mut transaction)
            .await?
            .expires_at(now)
            .map_err(|_| InvitationServiceError::InvariantViolation)?;
        let inviter = parse_id(&row, "invited_by_user_id")?;
        let replacement = insert_pending(
            &mut transaction,
            replacement_id,
            &email,
            inviter,
            token.digest().as_bytes(),
            now,
            replacement_expiry,
        )
        .await?;
        let invitation = invitation_from_row(&replacement)?;
        append_audit(
            &mut transaction,
            audit,
            AuditInput::success(
                "invitation.reissue",
                id.to_string(),
                &["status", "replaced_by_invitation_id"],
                json!({"replacement_id": replacement_id.to_string()}),
            ),
        )
        .await?;
        let email_delivery_queued =
            enqueue_activation_email(&mut transaction, replacement_id, &email).await?;
        transaction.commit().await.map_err(database_error)?;
        Ok(IssuedActivationInvitation {
            invitation,
            token,
            email_delivery_queued,
        })
    }

    async fn revoke_inner(
        &self,
        id: ActivationInvitationId,
        audit: &InvitationAuditContext,
    ) -> Result<InvitationRevokeResult, InvitationServiceError> {
        let mut connection = self.acquire().await?;
        let mut transaction = connection.begin().await.map_err(database_error)?;
        require_context_admin(&mut transaction, audit).await?;
        let Some(row) = lock_invitation(&mut transaction, id).await? else {
            append_denied_and_commit(
                transaction,
                audit,
                "invitation.revoke",
                id.to_string(),
                "INVITATION_NOT_PENDING",
            )
            .await?;
            return Ok(InvitationRevokeResult::AlreadyInactive);
        };
        let status: String = required(&row, "status")?;
        let expires_at: OffsetDateTime = required(&row, "expires_at")?;
        let now = transaction_now_datetime(&mut transaction).await?;
        if status != "pending" || expires_at <= now {
            if status == "pending" {
                mark_expired(&mut transaction, id).await?;
            }
            append_denied_and_commit(
                transaction,
                audit,
                "invitation.revoke",
                id.to_string(),
                if expires_at <= now {
                    "INVITATION_EXPIRED"
                } else {
                    "INVITATION_NOT_PENDING"
                },
            )
            .await?;
            return Ok(InvitationRevokeResult::AlreadyInactive);
        }

        let updated = sqlx::query(
            "UPDATE activation_invitations SET status = 'revoked', \
             revoked_at = transaction_timestamp() \
             WHERE id = $1::uuid AND status = 'pending'",
        )
        .bind(id.to_string())
        .execute(&mut *transaction)
        .await
        .map_err(database_error)?;
        if updated.rows_affected() != 1 {
            return Err(InvitationServiceError::InvariantViolation);
        }
        append_audit(
            &mut transaction,
            audit,
            AuditInput::success(
                "invitation.revoke",
                id.to_string(),
                &["status", "revoked_at"],
                json!({}),
            ),
        )
        .await?;
        transaction.commit().await.map_err(database_error)?;
        Ok(InvitationRevokeResult::Revoked)
    }

    async fn accept_inner<A>(
        &self,
        digest: &[u8; 32],
        audit: &InvitationAuditContext,
        activator: &A,
    ) -> Result<ActivationInvitation, InvitationServiceError>
    where
        A: InvitationActivator,
    {
        let mut connection = self.acquire().await?;
        let mut transaction = connection.begin().await.map_err(database_error)?;
        let Some(row) = lock_invitation_by_digest(&mut transaction, digest).await? else {
            append_denied_and_commit(
                transaction,
                audit,
                "invitation.accept",
                "unknown".into(),
                "INVITATION_INVALID",
            )
            .await?;
            return Err(InvitationServiceError::InvalidInvitation);
        };
        let id = parse_id(&row, "id")?;
        let status: String = required(&row, "status")?;
        let expires_at: OffsetDateTime = required(&row, "expires_at")?;
        let now = transaction_now_datetime(&mut transaction).await?;
        if status != "pending" || expires_at <= now {
            if status == "pending" {
                mark_expired(&mut transaction, id).await?;
            }
            append_denied_and_commit(
                transaction,
                audit,
                "invitation.accept",
                id.to_string(),
                "INVITATION_INVALID",
            )
            .await?;
            return Err(InvitationServiceError::InvalidInvitation);
        }

        let pending = PendingInvitationActivation {
            invitation_id: id,
            normalized_email: NormalizedEmail::parse(required(&row, "normalized_email")?)
                .map_err(|_| InvitationServiceError::InvariantViolation)?,
        };
        activator
            .activate(&mut transaction, &pending)
            .await
            .map_err(|_| InvitationServiceError::ActivationFailed)?;
        let accepted = sqlx::query(
            "UPDATE activation_invitations SET status = 'accepted', \
             accepted_at = transaction_timestamp() \
             WHERE id = $1::uuid AND token_hash = $2 AND status = 'pending' \
               AND expires_at > transaction_timestamp() \
             RETURNING id::text, normalized_email, invited_by_user_id::text, status, \
                       created_at, expires_at, accepted_at, expired_at, revoked_at, \
                       superseded_at, replaced_by_invitation_id::text",
        )
        .bind(id.to_string())
        .bind(digest.as_slice())
        .fetch_optional(&mut *transaction)
        .await
        .map_err(database_error)?
        .ok_or(InvitationServiceError::InvariantViolation)?;
        let invitation = invitation_from_row(&accepted)?;
        append_audit(
            &mut transaction,
            audit,
            AuditInput::success(
                "invitation.accept",
                id.to_string(),
                &["status", "accepted_at"],
                json!({}),
            ),
        )
        .await?;
        transaction.commit().await.map_err(database_error)?;
        Ok(invitation)
    }

    async fn acquire(
        &self,
    ) -> Result<sqlx::pool::PoolConnection<Postgres>, InvitationServiceError> {
        self.pool
            .acquire()
            .await
            .map_err(|_| InvitationServiceError::DatabaseUnavailable)
    }

    async fn list_inner(
        &self,
        administrator_id: UserId,
    ) -> Result<Vec<ActivationInvitation>, InvitationServiceError> {
        let mut connection = self.acquire().await?;
        let mut transaction = connection.begin().await.map_err(database_error)?;
        require_admin_id(&mut transaction, administrator_id).await?;
        let rows = sqlx::query(
            "SELECT id::text, normalized_email, invited_by_user_id::text, \
                    CASE WHEN status = 'pending' AND expires_at <= transaction_timestamp() \
                         THEN 'expired' ELSE status END AS status, \
                    created_at, expires_at, accepted_at, \
                    CASE WHEN status = 'pending' AND expires_at <= transaction_timestamp() \
                         THEN expires_at ELSE expired_at END AS expired_at, \
                    revoked_at, superseded_at, replaced_by_invitation_id::text \
             FROM activation_invitations ORDER BY created_at DESC, id DESC LIMIT 100",
        )
        .fetch_all(&mut *transaction)
        .await
        .map_err(database_error)?;
        let invitations = rows
            .iter()
            .map(invitation_from_row)
            .collect::<Result<Vec<_>, _>>()?;
        transaction.commit().await.map_err(database_error)?;
        Ok(invitations)
    }
}

struct AuditInput {
    action: &'static str,
    target_id: String,
    result: AuditResult,
    reason: Option<&'static str>,
    changed_fields: &'static [&'static str],
    metadata: serde_json::Value,
}

impl AuditInput {
    fn success(
        action: &'static str,
        target_id: String,
        changed_fields: &'static [&'static str],
        metadata: serde_json::Value,
    ) -> Self {
        Self {
            action,
            target_id,
            result: AuditResult::Succeeded,
            reason: None,
            changed_fields,
            metadata,
        }
    }

    fn denied(action: &'static str, target_id: String, reason: &'static str) -> Self {
        Self {
            action,
            target_id,
            result: AuditResult::Denied,
            reason: Some(reason),
            changed_fields: &[],
            metadata: json!({}),
        }
    }
}

async fn require_issuing_admin(
    transaction: &mut Transaction<'_, Postgres>,
    inviter: UserId,
    audit: &InvitationAuditContext,
) -> Result<(), InvitationServiceError> {
    if audit.actor.kind != ActorType::User
        || audit.actor.user_id != Some(inviter)
        || audit.actor.id != inviter.to_string()
    {
        return Err(InvitationServiceError::InviterUnavailable);
    }
    require_admin_id(transaction, inviter).await
}

async fn require_context_admin(
    transaction: &mut Transaction<'_, Postgres>,
    audit: &InvitationAuditContext,
) -> Result<(), InvitationServiceError> {
    let Some(user_id) = audit.actor.user_id else {
        return Err(InvitationServiceError::InviterUnavailable);
    };
    if audit.actor.kind != ActorType::User || audit.actor.id != user_id.to_string() {
        return Err(InvitationServiceError::InviterUnavailable);
    }
    require_admin_id(transaction, user_id).await
}

async fn require_admin_id(
    transaction: &mut Transaction<'_, Postgres>,
    user_id: UserId,
) -> Result<(), InvitationServiceError> {
    let admin: Option<(String, bool)> =
        sqlx::query_as("SELECT status, is_instance_admin FROM users WHERE id = $1::uuid FOR SHARE")
            .bind(user_id.to_string())
            .fetch_optional(&mut **transaction)
            .await
            .map_err(database_error)?;
    if !matches!(admin, Some((status, true)) if status == "active") {
        return Err(InvitationServiceError::InviterUnavailable);
    }
    Ok(())
}

async fn lock_email(
    transaction: &mut Transaction<'_, Postgres>,
    email: &NormalizedEmail,
) -> Result<(), InvitationServiceError> {
    sqlx::query("SELECT pg_advisory_xact_lock(hashtextextended($1, 1229867348))")
        .bind(email.as_str())
        .execute(&mut **transaction)
        .await
        .map_err(database_error)?;
    Ok(())
}

async fn expire_pending_for_email(
    transaction: &mut Transaction<'_, Postgres>,
    email: &NormalizedEmail,
) -> Result<(), InvitationServiceError> {
    sqlx::query(
        "UPDATE activation_invitations SET status = 'expired', \
         expired_at = transaction_timestamp() WHERE normalized_email = $1 \
         AND status = 'pending' AND expires_at <= transaction_timestamp()",
    )
    .bind(email.as_str())
    .execute(&mut **transaction)
    .await
    .map_err(database_error)?;
    Ok(())
}

async fn pending_id_for_email(
    transaction: &mut Transaction<'_, Postgres>,
    email: &NormalizedEmail,
) -> Result<Option<ActivationInvitationId>, InvitationServiceError> {
    sqlx::query_scalar::<_, String>(
        "SELECT id::text FROM activation_invitations \
         WHERE normalized_email = $1 AND status = 'pending'",
    )
    .bind(email.as_str())
    .fetch_optional(&mut **transaction)
    .await
    .map_err(database_error)?
    .map(|value| {
        value
            .parse()
            .map_err(|_| InvitationServiceError::InvariantViolation)
    })
    .transpose()
}

async fn invitation_email(
    transaction: &mut Transaction<'_, Postgres>,
    id: ActivationInvitationId,
) -> Result<Option<NormalizedEmail>, InvitationServiceError> {
    sqlx::query_scalar::<_, String>(
        "SELECT normalized_email FROM activation_invitations WHERE id = $1::uuid",
    )
    .bind(id.to_string())
    .fetch_optional(&mut **transaction)
    .await
    .map_err(database_error)?
    .map(NormalizedEmail::parse)
    .transpose()
    .map_err(|_| InvitationServiceError::InvariantViolation)
}

async fn lock_invitation(
    transaction: &mut Transaction<'_, Postgres>,
    id: ActivationInvitationId,
) -> Result<Option<sqlx::postgres::PgRow>, InvitationServiceError> {
    sqlx::query(
        "SELECT id::text, normalized_email, invited_by_user_id::text, status, token_hash, \
                created_at, expires_at, accepted_at, expired_at, revoked_at, superseded_at, \
                replaced_by_invitation_id::text \
         FROM activation_invitations WHERE id = $1::uuid FOR UPDATE",
    )
    .bind(id.to_string())
    .fetch_optional(&mut **transaction)
    .await
    .map_err(database_error)
}

async fn lock_invitation_by_digest(
    transaction: &mut Transaction<'_, Postgres>,
    digest: &[u8; 32],
) -> Result<Option<sqlx::postgres::PgRow>, InvitationServiceError> {
    sqlx::query(
        "SELECT id::text, normalized_email, invited_by_user_id::text, status, token_hash, \
                created_at, expires_at, accepted_at, expired_at, revoked_at, superseded_at, \
                replaced_by_invitation_id::text \
         FROM activation_invitations WHERE token_hash = $1 FOR UPDATE",
    )
    .bind(digest.as_slice())
    .fetch_optional(&mut **transaction)
    .await
    .map_err(database_error)
}

async fn mark_expired(
    transaction: &mut Transaction<'_, Postgres>,
    id: ActivationInvitationId,
) -> Result<(), InvitationServiceError> {
    let updated = sqlx::query(
        "UPDATE activation_invitations SET status = 'expired', \
         expired_at = transaction_timestamp() WHERE id = $1::uuid AND status = 'pending' \
         AND expires_at <= transaction_timestamp()",
    )
    .bind(id.to_string())
    .execute(&mut **transaction)
    .await
    .map_err(database_error)?;
    if updated.rows_affected() != 1 {
        return Err(InvitationServiceError::InvariantViolation);
    }
    Ok(())
}

async fn insert_pending(
    transaction: &mut Transaction<'_, Postgres>,
    id: ActivationInvitationId,
    email: &NormalizedEmail,
    inviter: UserId,
    digest: &[u8; 32],
    created_at: Timestamp,
    expires_at: Timestamp,
) -> Result<sqlx::postgres::PgRow, InvitationServiceError> {
    sqlx::query(
        "INSERT INTO activation_invitations \
         (id, normalized_email, invited_by_user_id, token_hash, created_at, expires_at) \
         VALUES ($1::uuid, $2, $3::uuid, $4, $5::timestamptz, $6::timestamptz) \
         RETURNING id::text, normalized_email, invited_by_user_id::text, status, \
                   created_at, expires_at, accepted_at, expired_at, revoked_at, \
                   superseded_at, replaced_by_invitation_id::text",
    )
    .bind(id.to_string())
    .bind(email.as_str())
    .bind(inviter.to_string())
    .bind(digest.as_slice())
    .bind(created_at.to_string())
    .bind(expires_at.to_string())
    .fetch_one(&mut **transaction)
    .await
    .map_err(database_error)
}

async fn transaction_now(
    transaction: &mut Transaction<'_, Postgres>,
) -> Result<Timestamp, InvitationServiceError> {
    Timestamp::from_datetime(transaction_now_datetime(transaction).await?)
        .map_err(|_| InvitationServiceError::InvariantViolation)
}

async fn enqueue_activation_email(
    transaction: &mut Transaction<'_, Postgres>,
    invitation_id: ActivationInvitationId,
    email: &NormalizedEmail,
) -> Result<bool, InvitationServiceError> {
    let enabled: Option<bool> = sqlx::query_scalar(
        "SELECT value='true'::jsonb FROM instance_settings WHERE key='smtp.enabled' FOR SHARE",
    )
    .fetch_optional(&mut **transaction)
    .await
    .map_err(database_error)?;
    if enabled != Some(true) {
        return Ok(false);
    }
    sqlx::query(
        "INSERT INTO email_outbox
         (id,recipient_email,classification,template_id,locale,resource_type,resource_id)
         VALUES($1::uuid,$2,'account_access','activation.invited','en-US',
                'activation_invitation',$3)",
    )
    .bind(Uuid::now_v7().to_string())
    .bind(email.as_str())
    .bind(invitation_id.to_string())
    .execute(&mut **transaction)
    .await
    .map_err(database_error)?;
    Ok(true)
}

async fn transaction_now_datetime(
    transaction: &mut Transaction<'_, Postgres>,
) -> Result<OffsetDateTime, InvitationServiceError> {
    sqlx::query_scalar("SELECT transaction_timestamp()")
        .fetch_one(&mut **transaction)
        .await
        .map_err(database_error)
}

async fn append_denied_and_commit(
    mut transaction: Transaction<'_, Postgres>,
    audit: &InvitationAuditContext,
    action: &'static str,
    target_id: String,
    reason: &'static str,
) -> Result<(), InvitationServiceError> {
    append_audit(
        &mut transaction,
        audit,
        AuditInput::denied(action, target_id, reason),
    )
    .await?;
    transaction.commit().await.map_err(database_error)
}

async fn append_audit(
    transaction: &mut Transaction<'_, Postgres>,
    context: &InvitationAuditContext,
    input: AuditInput,
) -> Result<(), InvitationServiceError> {
    let event = AuditEvent::new(AuditEventFields {
        id: context.event_id,
        occurred_at: transaction_now(transaction).await?,
        actor: context.actor.clone(),
        action_code: input.action.into(),
        target: AuditTarget {
            kind: "activation_invitation".into(),
            id: input.target_id,
        },
        scope: AuditScope {
            kind: ScopeType::Instance,
            id: context.instance_id.clone(),
        },
        result: input.result,
        reason_code: input.reason.map(str::to_owned),
        correlation_id: context.correlation_id.clone(),
        source_ip: context.source_ip,
        schema_version: 1,
        changed_fields: input
            .changed_fields
            .iter()
            .map(|value| (*value).into())
            .collect(),
        metadata: AuditMetadata::new(input.metadata)
            .map_err(|_| InvitationServiceError::InvalidAuditContext)?,
    })
    .map_err(|_| InvitationServiceError::InvalidAuditContext)?;
    AuditWriter::append(transaction, &event)
        .await
        .map_err(|_| InvitationServiceError::AuditUnavailable)
}

fn invitation_from_row(
    row: &sqlx::postgres::PgRow,
) -> Result<ActivationInvitation, InvitationServiceError> {
    ActivationInvitation::new(ActivationInvitationFields {
        id: parse_id(row, "id")?,
        normalized_email: NormalizedEmail::parse(required(row, "normalized_email")?)
            .map_err(|_| InvitationServiceError::InvariantViolation)?,
        invited_by_user_id: parse_id(row, "invited_by_user_id")?,
        status: match required::<String>(row, "status")?.as_str() {
            "pending" => ActivationInvitationStatus::Pending,
            "accepted" => ActivationInvitationStatus::Accepted,
            "expired" => ActivationInvitationStatus::Expired,
            "revoked" => ActivationInvitationStatus::Revoked,
            "superseded" => ActivationInvitationStatus::Superseded,
            _ => return Err(InvitationServiceError::InvariantViolation),
        },
        created_at: parse_timestamp(row, "created_at")?,
        expires_at: parse_timestamp(row, "expires_at")?,
        accepted_at: parse_optional_timestamp(row, "accepted_at")?,
        expired_at: parse_optional_timestamp(row, "expired_at")?,
        revoked_at: parse_optional_timestamp(row, "revoked_at")?,
        superseded_at: parse_optional_timestamp(row, "superseded_at")?,
        replaced_by_invitation_id: parse_optional_id(row, "replaced_by_invitation_id")?,
    })
    .map_err(|_| InvitationServiceError::InvariantViolation)
}

fn required<T>(row: &sqlx::postgres::PgRow, column: &str) -> Result<T, InvitationServiceError>
where
    T: for<'r> sqlx::Decode<'r, Postgres> + sqlx::Type<Postgres>,
{
    row.try_get(column)
        .map_err(|_| InvitationServiceError::InvariantViolation)
}

fn parse_id<T>(row: &sqlx::postgres::PgRow, column: &str) -> Result<T, InvitationServiceError>
where
    T: std::str::FromStr,
{
    required::<String>(row, column)?
        .parse()
        .map_err(|_| InvitationServiceError::InvariantViolation)
}

fn parse_optional_id<T>(
    row: &sqlx::postgres::PgRow,
    column: &str,
) -> Result<Option<T>, InvitationServiceError>
where
    T: std::str::FromStr,
{
    required::<Option<String>>(row, column)?
        .map(|value| {
            value
                .parse()
                .map_err(|_| InvitationServiceError::InvariantViolation)
        })
        .transpose()
}

fn parse_timestamp(
    row: &sqlx::postgres::PgRow,
    column: &str,
) -> Result<Timestamp, InvitationServiceError> {
    Timestamp::from_datetime(required(row, column)?)
        .map_err(|_| InvitationServiceError::InvariantViolation)
}

fn parse_optional_timestamp(
    row: &sqlx::postgres::PgRow,
    column: &str,
) -> Result<Option<Timestamp>, InvitationServiceError> {
    required::<Option<OffsetDateTime>>(row, column)?
        .map(Timestamp::from_datetime)
        .transpose()
        .map_err(|_| InvitationServiceError::InvariantViolation)
}

fn database_error(_: sqlx::Error) -> InvitationServiceError {
    InvitationServiceError::DatabaseUnavailable
}

const fn map_token_error(error: ActivationTokenError) -> InvitationServiceError {
    match error {
        ActivationTokenError::EntropyUnavailable => InvitationServiceError::EntropyUnavailable,
        ActivationTokenError::InvalidToken => InvitationServiceError::InvariantViolation,
    }
}

#[cfg(test)]
mod tests;
