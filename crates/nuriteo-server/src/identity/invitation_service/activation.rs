#![allow(unused_imports)]
use super::invitation_store::*;
use super::*;
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

use super::super::{
    ActivationInvitation, ActivationInvitationFields, ActivationInvitationId,
    ActivationInvitationStatus, ActivationToken, ActivationTokenError, InvitationExpiryPolicy,
    NormalizedEmail, Timestamp, UserId,
};
use super::{
    AuditInput, DEFAULT_OPERATION_TIMEOUT, InvitationActivationError, InvitationActivationFuture,
    InvitationActivator, InvitationAuditContext, InvitationRevokeResult, InvitationService,
    InvitationServiceError, InvitationServicePolicy, InvitationServicePolicyError,
    IssuedActivationInvitation, MAX_OPERATION_TIMEOUT, MIN_OPERATION_TIMEOUT,
    PendingInvitationActivation, map_token_error,
};

impl super::InvitationAuditContext {
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

impl fmt::Display for InvitationServicePolicyError {
    fn fmt(&self, formatter: &mut fmt::Formatter<'_>) -> fmt::Result {
        formatter.write_str("invitation operation timeout is invalid")
    }
}

impl std::error::Error for InvitationServicePolicyError {}

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

    pub(crate) async fn within_deadline<T>(
        &self,
        operation: impl Future<Output = Result<T, InvitationServiceError>>,
    ) -> Result<T, InvitationServiceError> {
        tokio_time::timeout(self.policy.operation_timeout, operation)
            .await
            .map_err(|_| InvitationServiceError::OperationTimeout)?
    }

    pub(crate) async fn effective_expiry(
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

    pub(crate) async fn issue_inner(
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

    pub(crate) async fn reissue_inner(
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

    pub(crate) async fn revoke_inner(
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

    pub(crate) async fn accept_inner<A>(
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

    pub(crate) async fn acquire(
        &self,
    ) -> Result<sqlx::pool::PoolConnection<Postgres>, InvitationServiceError> {
        self.pool
            .acquire()
            .await
            .map_err(|_| InvitationServiceError::DatabaseUnavailable)
    }

    pub(crate) async fn list_inner(
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

impl AuditInput {
    pub(crate) fn success(
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

    pub(crate) fn denied(action: &'static str, target_id: String, reason: &'static str) -> Self {
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

pub(crate) async fn require_issuing_admin(
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

pub(crate) async fn require_context_admin(
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

pub(crate) async fn require_admin_id(
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

pub(crate) async fn lock_email(
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

pub(crate) async fn expire_pending_for_email(
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

pub(crate) async fn pending_id_for_email(
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

pub(crate) async fn invitation_email(
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
