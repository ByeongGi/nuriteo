use std::fmt;
use std::future::Future;
use std::net::IpAddr;
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
use crate::identity::{InvitationExpiryPolicy, NormalizedEmail, SessionId, Timestamp, UserId};
use crate::policy::EffectivePolicyEngine;

use super::invitation::OrganizationInvitationTokenDigest;
use super::{
    OrganizationId, OrganizationInvitation, OrganizationInvitationFields, OrganizationInvitationId,
    OrganizationInvitationStatus, OrganizationInvitationToken, OrganizationRole,
};

const DEFAULT_OPERATION_TIMEOUT: Duration = Duration::from_secs(5);
const MIN_OPERATION_TIMEOUT: Duration = Duration::from_millis(100);
const MAX_OPERATION_TIMEOUT: Duration = Duration::from_secs(30);
const DEFAULT_REAUTHENTICATION_AGE: Duration = Duration::from_secs(15 * 60);
const MIN_REAUTHENTICATION_AGE: Duration = Duration::from_secs(60);
const MAX_REAUTHENTICATION_AGE: Duration = Duration::from_secs(60 * 60);

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub struct OrganizationInvitationPolicy {
    expiry: InvitationExpiryPolicy,
    operation_timeout: Duration,
    reauthentication_max_age: Duration,
}

impl OrganizationInvitationPolicy {
    pub fn new(
        expiry: InvitationExpiryPolicy,
        operation_timeout: Duration,
        reauthentication_max_age: Duration,
    ) -> Result<Self, OrganizationInvitationServiceError> {
        if !(MIN_OPERATION_TIMEOUT..=MAX_OPERATION_TIMEOUT).contains(&operation_timeout)
            || !(MIN_REAUTHENTICATION_AGE..=MAX_REAUTHENTICATION_AGE)
                .contains(&reauthentication_max_age)
        {
            return Err(OrganizationInvitationServiceError::InvalidInput);
        }
        Ok(Self {
            expiry,
            operation_timeout,
            reauthentication_max_age,
        })
    }
}

impl Default for OrganizationInvitationPolicy {
    fn default() -> Self {
        Self {
            expiry: InvitationExpiryPolicy::default(),
            operation_timeout: DEFAULT_OPERATION_TIMEOUT,
            reauthentication_max_age: DEFAULT_REAUTHENTICATION_AGE,
        }
    }
}

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub struct OrganizationInvitationActor {
    user_id: UserId,
    session_id: SessionId,
}

impl OrganizationInvitationActor {
    #[must_use]
    pub const fn new(user_id: UserId, session_id: SessionId) -> Self {
        Self {
            user_id,
            session_id,
        }
    }

    #[must_use]
    pub const fn user_id(self) -> UserId {
        self.user_id
    }
}

#[derive(Debug, Clone, PartialEq, Eq)]
pub struct OrganizationInvitationInvitee {
    user_id: UserId,
    session_id: SessionId,
    verified_email: NormalizedEmail,
}

impl OrganizationInvitationInvitee {
    #[must_use]
    pub const fn new(
        user_id: UserId,
        session_id: SessionId,
        verified_email: NormalizedEmail,
    ) -> Self {
        Self {
            user_id,
            session_id,
            verified_email,
        }
    }

    #[must_use]
    pub const fn user_id(&self) -> UserId {
        self.user_id
    }
}

#[derive(Clone)]
pub struct OrganizationInvitationAuditContext {
    event_id: AuditEventId,
    actor_user_id: UserId,
    actor_display_name: Option<String>,
    correlation_id: String,
    source_ip: Option<IpAddr>,
}

impl OrganizationInvitationAuditContext {
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

impl fmt::Debug for OrganizationInvitationAuditContext {
    fn fmt(&self, formatter: &mut fmt::Formatter<'_>) -> fmt::Result {
        formatter
            .debug_struct("OrganizationInvitationAuditContext")
            .field("event_id", &self.event_id)
            .finish_non_exhaustive()
    }
}

pub struct IssuedOrganizationInvitation {
    invitation: OrganizationInvitation,
    token: OrganizationInvitationToken,
    email_delivery_queued: bool,
}

impl IssuedOrganizationInvitation {
    #[must_use]
    pub const fn invitation(&self) -> &OrganizationInvitation {
        &self.invitation
    }

    #[must_use]
    pub const fn token(&self) -> &OrganizationInvitationToken {
        &self.token
    }

    #[must_use]
    pub const fn email_delivery_queued(&self) -> bool {
        self.email_delivery_queued
    }

    #[must_use]
    pub fn into_parts(self) -> (OrganizationInvitation, OrganizationInvitationToken) {
        (self.invitation, self.token)
    }
}

impl fmt::Debug for IssuedOrganizationInvitation {
    fn fmt(&self, formatter: &mut fmt::Formatter<'_>) -> fmt::Result {
        formatter
            .debug_struct("IssuedOrganizationInvitation")
            .field("invitation", &self.invitation)
            .field("token", &"[REDACTED]")
            .finish()
    }
}

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum OrganizationInvitationRevokeResult {
    Revoked,
    AlreadyInactive,
}

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
#[non_exhaustive]
pub enum OrganizationInvitationServiceError {
    InvalidInput,
    AlreadyPending,
    AlreadyMember,
    MemberLimitReached,
    NotFound,
    Unauthorized,
    ReauthenticationRequired,
    InviteeUnavailable,
    InvalidInvitation,
    InvitationNotPending,
    EntropyUnavailable,
    InvalidAuditContext,
    AuditUnavailable,
    DatabaseUnavailable,
    OperationTimeout,
    InvariantViolation,
}

impl fmt::Display for OrganizationInvitationServiceError {
    fn fmt(&self, formatter: &mut fmt::Formatter<'_>) -> fmt::Result {
        formatter.write_str(match self {
            Self::InvalidInput => "organization invitation input is invalid",
            Self::AlreadyPending => "a pending organization invitation already exists",
            Self::AlreadyMember => "the invitee is already an organization member",
            Self::MemberLimitReached => "organization member limit was reached",
            Self::NotFound => "organization invitation was not found",
            Self::Unauthorized => "organization invitation operation is not authorized",
            Self::ReauthenticationRequired => "recent reauthentication is required",
            Self::InviteeUnavailable => "organization invitation invitee is unavailable",
            Self::InvalidInvitation => "organization invitation is invalid",
            Self::InvitationNotPending => "organization invitation is not pending",
            Self::EntropyUnavailable => "organization invitation credential generation failed",
            Self::InvalidAuditContext => "organization invitation audit context is invalid",
            Self::AuditUnavailable => "organization invitation audit persistence is unavailable",
            Self::DatabaseUnavailable => "organization invitation persistence is unavailable",
            Self::OperationTimeout => "organization invitation operation timed out",
            Self::InvariantViolation => "organization invitation state is invalid",
        })
    }
}

impl std::error::Error for OrganizationInvitationServiceError {}

#[derive(Clone)]
pub struct OrganizationInvitationService {
    pool: DatabasePool,
    policy: OrganizationInvitationPolicy,
    live_default_expiry: bool,
}

impl OrganizationInvitationService {
    #[must_use]
    pub const fn new(pool: DatabasePool, policy: OrganizationInvitationPolicy) -> Self {
        Self {
            pool,
            policy,
            live_default_expiry: false,
        }
    }

    #[must_use]
    pub const fn new_live(pool: DatabasePool, policy: OrganizationInvitationPolicy) -> Self {
        Self {
            pool,
            policy,
            live_default_expiry: true,
        }
    }

    pub async fn issue(
        &self,
        organization_id: OrganizationId,
        actor: OrganizationInvitationActor,
        invitee_email: NormalizedEmail,
        proposed_role: OrganizationRole,
        audit: &OrganizationInvitationAuditContext,
    ) -> Result<IssuedOrganizationInvitation, OrganizationInvitationServiceError> {
        ensure_audit_actor(actor.user_id, audit)?;
        let token = OrganizationInvitationToken::generate().map_err(|error| match error {
            super::OrganizationInvitationError::EntropyUnavailable => {
                OrganizationInvitationServiceError::EntropyUnavailable
            }
            _ => OrganizationInvitationServiceError::InvariantViolation,
        })?;
        self.within_deadline(self.issue_inner(
            organization_id,
            actor,
            invitee_email,
            proposed_role,
            OrganizationInvitationId::new(),
            token,
            audit,
        ))
        .await
    }

    pub async fn reissue(
        &self,
        invitation_id: OrganizationInvitationId,
        actor: OrganizationInvitationActor,
        proposed_role: OrganizationRole,
        audit: &OrganizationInvitationAuditContext,
    ) -> Result<IssuedOrganizationInvitation, OrganizationInvitationServiceError> {
        ensure_audit_actor(actor.user_id, audit)?;
        let token = OrganizationInvitationToken::generate()
            .map_err(|_| OrganizationInvitationServiceError::EntropyUnavailable)?;
        self.within_deadline(self.reissue_inner(
            invitation_id,
            actor,
            proposed_role,
            OrganizationInvitationId::new(),
            token,
            audit,
        ))
        .await
    }

    pub async fn revoke(
        &self,
        invitation_id: OrganizationInvitationId,
        actor: OrganizationInvitationActor,
        audit: &OrganizationInvitationAuditContext,
    ) -> Result<OrganizationInvitationRevokeResult, OrganizationInvitationServiceError> {
        ensure_audit_actor(actor.user_id, audit)?;
        self.within_deadline(self.revoke_inner(invitation_id, actor, audit))
            .await
    }

    pub async fn accept(
        &self,
        token: &OrganizationInvitationToken,
        invitee: &OrganizationInvitationInvitee,
        audit: &OrganizationInvitationAuditContext,
    ) -> Result<OrganizationInvitation, OrganizationInvitationServiceError> {
        ensure_audit_actor(invitee.user_id, audit)?;
        self.within_deadline(self.accept_inner(token.digest(), invitee, audit))
            .await
    }

    pub async fn decline(
        &self,
        token: &OrganizationInvitationToken,
        invitee: &OrganizationInvitationInvitee,
        audit: &OrganizationInvitationAuditContext,
    ) -> Result<OrganizationInvitation, OrganizationInvitationServiceError> {
        ensure_audit_actor(invitee.user_id, audit)?;
        self.within_deadline(self.decline_inner(token.digest(), invitee, audit))
            .await
    }

    async fn within_deadline<T>(
        &self,
        operation: impl Future<Output = Result<T, OrganizationInvitationServiceError>>,
    ) -> Result<T, OrganizationInvitationServiceError> {
        tokio_time::timeout(self.policy.operation_timeout, operation)
            .await
            .map_err(|_| OrganizationInvitationServiceError::OperationTimeout)?
    }

    #[allow(
        clippy::too_many_arguments,
        reason = "transaction inputs are explicit domain and audit boundaries"
    )]
    async fn issue_inner(
        &self,
        organization_id: OrganizationId,
        actor: OrganizationInvitationActor,
        invitee_email: NormalizedEmail,
        proposed_role: OrganizationRole,
        invitation_id: OrganizationInvitationId,
        token: OrganizationInvitationToken,
        audit: &OrganizationInvitationAuditContext,
    ) -> Result<IssuedOrganizationInvitation, OrganizationInvitationServiceError> {
        let mut connection = self.acquire().await?;
        let mut transaction = connection.begin().await.map_err(database_error)?;
        authorize_owner(
            &mut transaction,
            organization_id,
            actor,
            proposed_role == OrganizationRole::Owner,
            self.policy.reauthentication_max_age,
        )
        .await
        .map_err(enumeration_safe_issue_error)?;
        let (invitee_user_id, email) =
            resolve_active_invitee(&mut transaction, &invitee_email).await?;
        ensure_not_member(&mut transaction, organization_id, invitee_user_id).await?;
        expire_pending(&mut transaction, organization_id, invitee_user_id).await?;
        if pending_exists(&mut transaction, organization_id, invitee_user_id).await? {
            append_audit(
                &mut transaction,
                audit,
                organization_id,
                invitation_id,
                AuditInput::denied(
                    "organization.invitation_issue",
                    "INVITATION_ALREADY_PENDING",
                ),
            )
            .await?;
            transaction.commit().await.map_err(database_error)?;
            return Err(OrganizationInvitationServiceError::AlreadyPending);
        }
        let now = transaction_now(&mut transaction).await?;
        let expiry = self.effective_expiry(&mut transaction).await?;
        let expires_at = expiry
            .expires_at(now)
            .map_err(|_| OrganizationInvitationServiceError::InvariantViolation)?;
        let row = insert_pending(
            &mut transaction,
            PendingInsert {
                id: invitation_id,
                organization_id,
                invitee_user_id,
                email: &email,
                inviter_user_id: actor.user_id,
                role: proposed_role,
                digest: token.digest(),
                created_at: now,
                expires_at,
            },
        )
        .await?;
        let invitation = invitation_from_row(&row)?;
        append_audit(
            &mut transaction,
            audit,
            organization_id,
            invitation_id,
            AuditInput::success(
                "organization.invitation_issued",
                &["status", "proposed_role", "expires_at"],
            ),
        )
        .await?;
        let email_delivery_queued = enqueue_organization_invitation_email(
            &mut transaction,
            invitation_id,
            invitee_user_id,
            &email,
        )
        .await?;
        transaction.commit().await.map_err(database_error)?;
        Ok(IssuedOrganizationInvitation {
            invitation,
            token,
            email_delivery_queued,
        })
    }

    async fn reissue_inner(
        &self,
        invitation_id: OrganizationInvitationId,
        actor: OrganizationInvitationActor,
        proposed_role: OrganizationRole,
        replacement_id: OrganizationInvitationId,
        token: OrganizationInvitationToken,
        audit: &OrganizationInvitationAuditContext,
    ) -> Result<IssuedOrganizationInvitation, OrganizationInvitationServiceError> {
        let mut connection = self.acquire().await?;
        let mut transaction = connection.begin().await.map_err(database_error)?;
        let organization_id = invitation_organization(&mut transaction, invitation_id)
            .await?
            .ok_or(OrganizationInvitationServiceError::NotFound)?;
        authorize_owner(
            &mut transaction,
            organization_id,
            actor,
            proposed_role == OrganizationRole::Owner,
            self.policy.reauthentication_max_age,
        )
        .await?;
        let row = lock_invitation_by_id(&mut transaction, invitation_id)
            .await?
            .ok_or(OrganizationInvitationServiceError::NotFound)?;
        let now = transaction_now_datetime(&mut transaction).await?;
        if pending_state(&mut transaction, &row, invitation_id, now).await? != PendingState::Pending
        {
            append_audit(
                &mut transaction,
                audit,
                organization_id,
                invitation_id,
                AuditInput::denied("organization.invitation_reissue", "INVITATION_NOT_PENDING"),
            )
            .await?;
            transaction.commit().await.map_err(database_error)?;
            return Err(OrganizationInvitationServiceError::InvitationNotPending);
        }
        let invitee_user_id = parse_id(&row, "invitee_user_id")?;
        let email = require_active_invitee_by_id(&mut transaction, invitee_user_id).await?;
        ensure_not_member(&mut transaction, organization_id, invitee_user_id).await?;

        let updated = sqlx::query(
            "UPDATE organization_invitations SET status = 'superseded', \
             superseded_at = transaction_timestamp(), replaced_by_invitation_id = $2::uuid \
             WHERE id = $1::uuid AND status = 'pending' AND expires_at > transaction_timestamp()",
        )
        .bind(invitation_id.to_string())
        .bind(replacement_id.to_string())
        .execute(&mut *transaction)
        .await
        .map_err(database_error)?;
        if updated.rows_affected() != 1 {
            return Err(OrganizationInvitationServiceError::InvariantViolation);
        }
        let created_at = Timestamp::from_datetime(now)
            .map_err(|_| OrganizationInvitationServiceError::InvariantViolation)?;
        let expiry = self.effective_expiry(&mut transaction).await?;
        let expires_at = expiry
            .expires_at(created_at)
            .map_err(|_| OrganizationInvitationServiceError::InvariantViolation)?;
        let replacement = insert_pending(
            &mut transaction,
            PendingInsert {
                id: replacement_id,
                organization_id,
                invitee_user_id,
                email: &email,
                inviter_user_id: actor.user_id,
                role: proposed_role,
                digest: token.digest(),
                created_at,
                expires_at,
            },
        )
        .await?;
        let invitation = invitation_from_row(&replacement)?;
        append_audit(
            &mut transaction,
            audit,
            organization_id,
            invitation_id,
            AuditInput::success(
                "organization.invitation_reissued",
                &["status", "replaced_by_invitation_id"],
            ),
        )
        .await?;
        let email_delivery_queued = enqueue_organization_invitation_email(
            &mut transaction,
            replacement_id,
            invitee_user_id,
            &email,
        )
        .await?;
        transaction.commit().await.map_err(database_error)?;
        Ok(IssuedOrganizationInvitation {
            invitation,
            token,
            email_delivery_queued,
        })
    }

    async fn effective_expiry(
        &self,
        transaction: &mut Transaction<'_, Postgres>,
    ) -> Result<InvitationExpiryPolicy, OrganizationInvitationServiceError> {
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
            .map_err(|_| OrganizationInvitationServiceError::InvariantViolation)
    }

    async fn revoke_inner(
        &self,
        invitation_id: OrganizationInvitationId,
        actor: OrganizationInvitationActor,
        audit: &OrganizationInvitationAuditContext,
    ) -> Result<OrganizationInvitationRevokeResult, OrganizationInvitationServiceError> {
        let mut connection = self.acquire().await?;
        let mut transaction = connection.begin().await.map_err(database_error)?;
        let organization_id = invitation_organization(&mut transaction, invitation_id)
            .await?
            .ok_or(OrganizationInvitationServiceError::NotFound)?;
        authorize_owner(
            &mut transaction,
            organization_id,
            actor,
            false,
            self.policy.reauthentication_max_age,
        )
        .await?;
        let row = lock_invitation_by_id(&mut transaction, invitation_id)
            .await?
            .ok_or(OrganizationInvitationServiceError::NotFound)?;
        let status: String = required(&row, "status")?;
        let expires_at: OffsetDateTime = required(&row, "expires_at")?;
        let now = transaction_now_datetime(&mut transaction).await?;
        if status != "pending" || expires_at <= now {
            if status == "pending" {
                mark_expired(&mut transaction, invitation_id).await?;
            }
            append_audit(
                &mut transaction,
                audit,
                organization_id,
                invitation_id,
                AuditInput::denied("organization.invitation_revoke", "INVITATION_NOT_PENDING"),
            )
            .await?;
            transaction.commit().await.map_err(database_error)?;
            return Ok(OrganizationInvitationRevokeResult::AlreadyInactive);
        }
        transition_pending(&mut transaction, invitation_id, "revoked", "revoked_at").await?;
        append_audit(
            &mut transaction,
            audit,
            organization_id,
            invitation_id,
            AuditInput::success("organization.invitation_revoked", &["status", "revoked_at"]),
        )
        .await?;
        transaction.commit().await.map_err(database_error)?;
        Ok(OrganizationInvitationRevokeResult::Revoked)
    }

    async fn accept_inner(
        &self,
        digest: OrganizationInvitationTokenDigest,
        invitee: &OrganizationInvitationInvitee,
        audit: &OrganizationInvitationAuditContext,
    ) -> Result<OrganizationInvitation, OrganizationInvitationServiceError> {
        let mut connection = self.acquire().await?;
        let mut transaction = connection.begin().await.map_err(database_error)?;
        let organization_id = invitation_organization_by_digest(&mut transaction, digest)
            .await?
            .ok_or(OrganizationInvitationServiceError::InvalidInvitation)?;
        lock_membership_admission(&mut transaction, organization_id).await?;
        lock_organization(&mut transaction, organization_id).await?;
        let row = lock_invitation_by_digest(&mut transaction, digest)
            .await?
            .ok_or(OrganizationInvitationServiceError::InvalidInvitation)?;
        let invitation_id = parse_id(&row, "id")?;
        let now = transaction_now_datetime(&mut transaction).await?;
        if pending_state(&mut transaction, &row, invitation_id, now).await? != PendingState::Pending
        {
            append_audit(
                &mut transaction,
                audit,
                organization_id,
                invitation_id,
                AuditInput::denied("organization.invitation_accept", "INVITATION_INVALID"),
            )
            .await?;
            transaction.commit().await.map_err(database_error)?;
            return Err(OrganizationInvitationServiceError::InvalidInvitation);
        }
        verify_invitee(&mut transaction, &row, invitee).await?;
        ensure_not_member(&mut transaction, organization_id, invitee.user_id).await?;
        ensure_member_capacity(&mut transaction, organization_id).await?;
        let role = parse_role(&required::<String>(&row, "proposed_role")?)?;
        sqlx::query(
            "INSERT INTO organization_memberships \
             (organization_id, user_id, role, created_at, updated_at) \
             VALUES ($1::uuid, $2::uuid, $3, transaction_timestamp(), transaction_timestamp())",
        )
        .bind(organization_id.to_string())
        .bind(invitee.user_id.to_string())
        .bind(role_name(role))
        .execute(&mut *transaction)
        .await
        .map_err(membership_write_error)?;
        let accepted = transition_pending_returning(
            &mut transaction,
            invitation_id,
            digest,
            "accepted",
            "accepted_at",
        )
        .await?;
        let invitation = invitation_from_row(&accepted)?;
        append_audit(
            &mut transaction,
            audit,
            organization_id,
            invitation_id,
            AuditInput::success(
                "organization.invitation_accepted",
                &["status", "accepted_at", "membership"],
            ),
        )
        .await?;
        transaction.commit().await.map_err(database_error)?;
        Ok(invitation)
    }

    async fn decline_inner(
        &self,
        digest: OrganizationInvitationTokenDigest,
        invitee: &OrganizationInvitationInvitee,
        audit: &OrganizationInvitationAuditContext,
    ) -> Result<OrganizationInvitation, OrganizationInvitationServiceError> {
        let mut connection = self.acquire().await?;
        let mut transaction = connection.begin().await.map_err(database_error)?;
        let organization_id = invitation_organization_by_digest(&mut transaction, digest)
            .await?
            .ok_or(OrganizationInvitationServiceError::InvalidInvitation)?;
        lock_organization(&mut transaction, organization_id).await?;
        let row = lock_invitation_by_digest(&mut transaction, digest)
            .await?
            .ok_or(OrganizationInvitationServiceError::InvalidInvitation)?;
        let invitation_id = parse_id(&row, "id")?;
        let now = transaction_now_datetime(&mut transaction).await?;
        if pending_state(&mut transaction, &row, invitation_id, now).await? != PendingState::Pending
        {
            append_audit(
                &mut transaction,
                audit,
                organization_id,
                invitation_id,
                AuditInput::denied("organization.invitation_decline", "INVITATION_INVALID"),
            )
            .await?;
            transaction.commit().await.map_err(database_error)?;
            return Err(OrganizationInvitationServiceError::InvalidInvitation);
        }
        verify_invitee(&mut transaction, &row, invitee).await?;
        let declined = transition_pending_returning(
            &mut transaction,
            invitation_id,
            digest,
            "declined",
            "declined_at",
        )
        .await?;
        let invitation = invitation_from_row(&declined)?;
        append_audit(
            &mut transaction,
            audit,
            organization_id,
            invitation_id,
            AuditInput::success(
                "organization.invitation_declined",
                &["status", "declined_at"],
            ),
        )
        .await?;
        transaction.commit().await.map_err(database_error)?;
        Ok(invitation)
    }

    async fn acquire(
        &self,
    ) -> Result<sqlx::pool::PoolConnection<Postgres>, OrganizationInvitationServiceError> {
        self.pool
            .acquire()
            .await
            .map_err(|_| OrganizationInvitationServiceError::DatabaseUnavailable)
    }
}

struct PendingInsert<'a> {
    id: OrganizationInvitationId,
    organization_id: OrganizationId,
    invitee_user_id: UserId,
    email: &'a NormalizedEmail,
    inviter_user_id: UserId,
    role: OrganizationRole,
    digest: OrganizationInvitationTokenDigest,
    created_at: Timestamp,
    expires_at: Timestamp,
}

struct AuditInput {
    action: &'static str,
    result: AuditResult,
    reason: Option<&'static str>,
    changed_fields: &'static [&'static str],
}

impl AuditInput {
    const fn success(action: &'static str, changed_fields: &'static [&'static str]) -> Self {
        Self {
            action,
            result: AuditResult::Succeeded,
            reason: None,
            changed_fields,
        }
    }

    const fn denied(action: &'static str, reason: &'static str) -> Self {
        Self {
            action,
            result: AuditResult::Denied,
            reason: Some(reason),
            changed_fields: &[],
        }
    }
}

async fn authorize_owner(
    transaction: &mut Transaction<'_, Postgres>,
    organization_id: OrganizationId,
    actor: OrganizationInvitationActor,
    require_recent_reauthentication: bool,
    reauthentication_max_age: Duration,
) -> Result<(), OrganizationInvitationServiceError> {
    let reauth_seconds = i64::try_from(reauthentication_max_age.as_secs())
        .map_err(|_| OrganizationInvitationServiceError::InvalidInput)?;
    let row: Option<(String, Option<OffsetDateTime>)> = sqlx::query_as(
        "SELECT organization.status, session.last_reauthenticated_at \
         FROM organizations organization \
         JOIN organization_memberships membership \
           ON membership.organization_id = organization.id \
          AND membership.user_id = $2::uuid AND membership.role = 'owner' \
         JOIN users actor ON actor.id = membership.user_id AND actor.status = 'active' \
         JOIN sessions session ON session.id = $3::uuid AND session.user_id = actor.id \
         WHERE organization.id = $1::uuid \
           AND session.revoked_at IS NULL \
           AND session.idle_expires_at > transaction_timestamp() \
           AND session.absolute_expires_at > transaction_timestamp() \
         FOR UPDATE OF organization, membership, actor, session",
    )
    .bind(organization_id.to_string())
    .bind(actor.user_id.to_string())
    .bind(actor.session_id.to_string())
    .fetch_optional(&mut **transaction)
    .await
    .map_err(database_error)?;
    let Some((organization_status, reauthenticated_at)) = row else {
        return Err(OrganizationInvitationServiceError::Unauthorized);
    };
    if organization_status != "active" {
        return Err(OrganizationInvitationServiceError::InvalidInvitation);
    }
    if require_recent_reauthentication {
        let now = transaction_now_datetime(transaction).await?;
        let cutoff = now - time::Duration::seconds(reauth_seconds);
        if !reauthenticated_at.is_some_and(|at| at >= cutoff && at <= now) {
            return Err(OrganizationInvitationServiceError::ReauthenticationRequired);
        }
    }
    Ok(())
}

async fn lock_organization(
    transaction: &mut Transaction<'_, Postgres>,
    organization_id: OrganizationId,
) -> Result<(), OrganizationInvitationServiceError> {
    let active: Option<bool> = sqlx::query_scalar(
        "SELECT status = 'active' FROM organizations WHERE id = $1::uuid FOR UPDATE",
    )
    .bind(organization_id.to_string())
    .fetch_optional(&mut **transaction)
    .await
    .map_err(database_error)?;
    if active != Some(true) {
        return Err(OrganizationInvitationServiceError::InvalidInvitation);
    }
    Ok(())
}

async fn require_active_invitee_by_id(
    transaction: &mut Transaction<'_, Postgres>,
    invitee_user_id: UserId,
) -> Result<NormalizedEmail, OrganizationInvitationServiceError> {
    let email: Option<String> = sqlx::query_scalar(
        "SELECT normalized_email FROM users \
         WHERE id = $1::uuid AND status = 'active' FOR UPDATE",
    )
    .bind(invitee_user_id.to_string())
    .fetch_optional(&mut **transaction)
    .await
    .map_err(database_error)?;
    email
        .ok_or(OrganizationInvitationServiceError::InviteeUnavailable)
        .and_then(|value| {
            NormalizedEmail::parse(value)
                .map_err(|_| OrganizationInvitationServiceError::InvariantViolation)
        })
}

async fn resolve_active_invitee(
    transaction: &mut Transaction<'_, Postgres>,
    invitee_email: &NormalizedEmail,
) -> Result<(UserId, NormalizedEmail), OrganizationInvitationServiceError> {
    let row: Option<(String, String)> = sqlx::query_as(
        "SELECT id::text, normalized_email FROM users \
         WHERE normalized_email = $1 AND status = 'active' FOR UPDATE",
    )
    .bind(invitee_email.as_str())
    .fetch_optional(&mut **transaction)
    .await
    .map_err(database_error)?;
    let Some((user_id, stored_email)) = row else {
        return Err(OrganizationInvitationServiceError::InviteeUnavailable);
    };
    let user_id = user_id
        .parse()
        .map_err(|_| OrganizationInvitationServiceError::InvariantViolation)?;
    let stored_email = NormalizedEmail::parse(stored_email)
        .map_err(|_| OrganizationInvitationServiceError::InvariantViolation)?;
    if stored_email != *invitee_email {
        return Err(OrganizationInvitationServiceError::InvariantViolation);
    }
    Ok((user_id, stored_email))
}

fn enumeration_safe_issue_error(
    error: OrganizationInvitationServiceError,
) -> OrganizationInvitationServiceError {
    match error {
        OrganizationInvitationServiceError::Unauthorized => {
            OrganizationInvitationServiceError::InviteeUnavailable
        }
        other => other,
    }
}

async fn verify_invitee(
    transaction: &mut Transaction<'_, Postgres>,
    row: &sqlx::postgres::PgRow,
    invitee: &OrganizationInvitationInvitee,
) -> Result<(), OrganizationInvitationServiceError> {
    let invited_user: UserId = parse_id(row, "invitee_user_id")?;
    let invited_email = NormalizedEmail::parse(required(row, "normalized_email")?)
        .map_err(|_| OrganizationInvitationServiceError::InvariantViolation)?;
    if invited_user != invitee.user_id || invited_email != invitee.verified_email {
        return Err(OrganizationInvitationServiceError::InvalidInvitation);
    }
    let authenticated: Option<String> = sqlx::query_scalar(
        "SELECT actor.normalized_email FROM users actor \
         JOIN sessions session ON session.user_id = actor.id AND session.id = $2::uuid \
         WHERE actor.id = $1::uuid AND actor.status = 'active' \
           AND session.revoked_at IS NULL \
           AND session.idle_expires_at > transaction_timestamp() \
           AND session.absolute_expires_at > transaction_timestamp() \
         FOR UPDATE OF actor, session",
    )
    .bind(invitee.user_id.to_string())
    .bind(invitee.session_id.to_string())
    .fetch_optional(&mut **transaction)
    .await
    .map_err(database_error)?;
    if authenticated.as_deref() != Some(invitee.verified_email.as_str()) {
        return Err(OrganizationInvitationServiceError::InviteeUnavailable);
    }
    Ok(())
}

async fn ensure_not_member(
    transaction: &mut Transaction<'_, Postgres>,
    organization_id: OrganizationId,
    user_id: UserId,
) -> Result<(), OrganizationInvitationServiceError> {
    let exists: bool = sqlx::query_scalar(
        "SELECT EXISTS(SELECT 1 FROM organization_memberships \
         WHERE organization_id = $1::uuid AND user_id = $2::uuid)",
    )
    .bind(organization_id.to_string())
    .bind(user_id.to_string())
    .fetch_one(&mut **transaction)
    .await
    .map_err(database_error)?;
    if exists {
        return Err(OrganizationInvitationServiceError::AlreadyMember);
    }
    Ok(())
}

async fn lock_membership_admission(
    transaction: &mut Transaction<'_, Postgres>,
    organization_id: OrganizationId,
) -> Result<(), OrganizationInvitationServiceError> {
    sqlx::query("SELECT pg_advisory_xact_lock(1314212943, hashtext($1))")
        .bind(organization_id.to_string())
        .execute(&mut **transaction)
        .await
        .map_err(database_error)?;
    Ok(())
}

async fn ensure_member_capacity(
    transaction: &mut Transaction<'_, Postgres>,
    organization_id: OrganizationId,
) -> Result<(), OrganizationInvitationServiceError> {
    let members: i64 = sqlx::query_scalar(
        "SELECT COUNT(*) FROM organization_memberships \
         WHERE organization_id = $1::uuid",
    )
    .bind(organization_id.to_string())
    .fetch_one(&mut **transaction)
    .await
    .map_err(database_error)?;
    if members >= super::MAX_MEMBERS {
        return Err(OrganizationInvitationServiceError::MemberLimitReached);
    }
    Ok(())
}

fn membership_write_error(error: sqlx::Error) -> OrganizationInvitationServiceError {
    if error.as_database_error().is_some_and(|database| {
        database.code().as_deref() == Some("23514")
            && database.constraint() == Some("organization_member_limit")
    }) {
        OrganizationInvitationServiceError::MemberLimitReached
    } else {
        OrganizationInvitationServiceError::DatabaseUnavailable
    }
}

async fn expire_pending(
    transaction: &mut Transaction<'_, Postgres>,
    organization_id: OrganizationId,
    invitee_user_id: UserId,
) -> Result<(), OrganizationInvitationServiceError> {
    sqlx::query(
        "UPDATE organization_invitations SET status = 'expired', \
         expired_at = transaction_timestamp() \
         WHERE organization_id = $1::uuid AND invitee_user_id = $2::uuid \
           AND status = 'pending' AND expires_at <= transaction_timestamp()",
    )
    .bind(organization_id.to_string())
    .bind(invitee_user_id.to_string())
    .execute(&mut **transaction)
    .await
    .map_err(database_error)?;
    Ok(())
}

async fn pending_exists(
    transaction: &mut Transaction<'_, Postgres>,
    organization_id: OrganizationId,
    invitee_user_id: UserId,
) -> Result<bool, OrganizationInvitationServiceError> {
    sqlx::query_scalar(
        "SELECT EXISTS(SELECT 1 FROM organization_invitations \
         WHERE organization_id = $1::uuid AND invitee_user_id = $2::uuid \
           AND status = 'pending')",
    )
    .bind(organization_id.to_string())
    .bind(invitee_user_id.to_string())
    .fetch_one(&mut **transaction)
    .await
    .map_err(database_error)
}

async fn invitation_organization(
    transaction: &mut Transaction<'_, Postgres>,
    invitation_id: OrganizationInvitationId,
) -> Result<Option<OrganizationId>, OrganizationInvitationServiceError> {
    sqlx::query_scalar::<_, String>(
        "SELECT organization_id::text FROM organization_invitations WHERE id = $1::uuid",
    )
    .bind(invitation_id.to_string())
    .fetch_optional(&mut **transaction)
    .await
    .map_err(database_error)?
    .map(|value| {
        value
            .parse()
            .map_err(|_| OrganizationInvitationServiceError::InvariantViolation)
    })
    .transpose()
}

async fn invitation_organization_by_digest(
    transaction: &mut Transaction<'_, Postgres>,
    digest: OrganizationInvitationTokenDigest,
) -> Result<Option<OrganizationId>, OrganizationInvitationServiceError> {
    sqlx::query_scalar::<_, String>(
        "SELECT organization_id::text FROM organization_invitations WHERE token_hash = $1",
    )
    .bind(digest.as_bytes().as_slice())
    .fetch_optional(&mut **transaction)
    .await
    .map_err(database_error)?
    .map(|value| {
        value
            .parse()
            .map_err(|_| OrganizationInvitationServiceError::InvariantViolation)
    })
    .transpose()
}

async fn lock_invitation_by_id(
    transaction: &mut Transaction<'_, Postgres>,
    id: OrganizationInvitationId,
) -> Result<Option<sqlx::postgres::PgRow>, OrganizationInvitationServiceError> {
    invitation_query()
        .bind(id.to_string())
        .fetch_optional(&mut **transaction)
        .await
        .map_err(database_error)
}

async fn lock_invitation_by_digest(
    transaction: &mut Transaction<'_, Postgres>,
    digest: OrganizationInvitationTokenDigest,
) -> Result<Option<sqlx::postgres::PgRow>, OrganizationInvitationServiceError> {
    sqlx::query(concat!(
        "SELECT id::text, organization_id::text, invitee_user_id::text, normalized_email, ",
        "invited_by_user_id::text, proposed_role, status, created_at, expires_at, ",
        "accepted_at, declined_at, expired_at, revoked_at, superseded_at, ",
        "replaced_by_invitation_id::text FROM organization_invitations ",
        "WHERE token_hash = $1 FOR UPDATE"
    ))
    .bind(digest.as_bytes().as_slice())
    .fetch_optional(&mut **transaction)
    .await
    .map_err(database_error)
}

fn invitation_query() -> sqlx::query::Query<'static, Postgres, sqlx::postgres::PgArguments> {
    sqlx::query(concat!(
        "SELECT id::text, organization_id::text, invitee_user_id::text, normalized_email, ",
        "invited_by_user_id::text, proposed_role, status, created_at, expires_at, ",
        "accepted_at, declined_at, expired_at, revoked_at, superseded_at, ",
        "replaced_by_invitation_id::text FROM organization_invitations ",
        "WHERE id = $1::uuid FOR UPDATE"
    ))
}

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
enum PendingState {
    Pending,
    Expired,
    Inactive,
}

async fn pending_state(
    transaction: &mut Transaction<'_, Postgres>,
    row: &sqlx::postgres::PgRow,
    invitation_id: OrganizationInvitationId,
    now: OffsetDateTime,
) -> Result<PendingState, OrganizationInvitationServiceError> {
    let status: String = required(row, "status")?;
    let expires_at: OffsetDateTime = required(row, "expires_at")?;
    if status != "pending" {
        return Ok(PendingState::Inactive);
    }
    if expires_at <= now {
        mark_expired(transaction, invitation_id).await?;
        return Ok(PendingState::Expired);
    }
    Ok(PendingState::Pending)
}

async fn mark_expired(
    transaction: &mut Transaction<'_, Postgres>,
    invitation_id: OrganizationInvitationId,
) -> Result<(), OrganizationInvitationServiceError> {
    let result = sqlx::query(
        "UPDATE organization_invitations SET status = 'expired', \
         expired_at = transaction_timestamp() WHERE id = $1::uuid AND status = 'pending' \
         AND expires_at <= transaction_timestamp()",
    )
    .bind(invitation_id.to_string())
    .execute(&mut **transaction)
    .await
    .map_err(database_error)?;
    if result.rows_affected() != 1 {
        return Err(OrganizationInvitationServiceError::InvariantViolation);
    }
    Ok(())
}

async fn transition_pending(
    transaction: &mut Transaction<'_, Postgres>,
    invitation_id: OrganizationInvitationId,
    status: &str,
    timestamp_column: &str,
) -> Result<(), OrganizationInvitationServiceError> {
    let statement = match (status, timestamp_column) {
        ("revoked", "revoked_at") => {
            "UPDATE organization_invitations SET status = 'revoked', \
             revoked_at = transaction_timestamp() WHERE id = $1::uuid AND status = 'pending' \
             AND expires_at > transaction_timestamp()"
        }
        _ => return Err(OrganizationInvitationServiceError::InvariantViolation),
    };
    let result = sqlx::query(statement)
        .bind(invitation_id.to_string())
        .execute(&mut **transaction)
        .await
        .map_err(database_error)?;
    if result.rows_affected() != 1 {
        return Err(OrganizationInvitationServiceError::InvariantViolation);
    }
    Ok(())
}

async fn transition_pending_returning(
    transaction: &mut Transaction<'_, Postgres>,
    invitation_id: OrganizationInvitationId,
    digest: OrganizationInvitationTokenDigest,
    status: &str,
    timestamp_column: &str,
) -> Result<sqlx::postgres::PgRow, OrganizationInvitationServiceError> {
    let statement = match (status, timestamp_column) {
        ("accepted", "accepted_at") => concat!(
            "UPDATE organization_invitations SET status = 'accepted', ",
            "accepted_at = transaction_timestamp() WHERE id = $1::uuid AND token_hash = $2 ",
            "AND status = 'pending' AND expires_at > transaction_timestamp() RETURNING ",
            "id::text, organization_id::text, invitee_user_id::text, normalized_email, ",
            "invited_by_user_id::text, proposed_role, status, created_at, expires_at, ",
            "accepted_at, declined_at, expired_at, revoked_at, superseded_at, ",
            "replaced_by_invitation_id::text"
        ),
        ("declined", "declined_at") => concat!(
            "UPDATE organization_invitations SET status = 'declined', ",
            "declined_at = transaction_timestamp() WHERE id = $1::uuid AND token_hash = $2 ",
            "AND status = 'pending' AND expires_at > transaction_timestamp() RETURNING ",
            "id::text, organization_id::text, invitee_user_id::text, normalized_email, ",
            "invited_by_user_id::text, proposed_role, status, created_at, expires_at, ",
            "accepted_at, declined_at, expired_at, revoked_at, superseded_at, ",
            "replaced_by_invitation_id::text"
        ),
        _ => return Err(OrganizationInvitationServiceError::InvariantViolation),
    };
    sqlx::query(statement)
        .bind(invitation_id.to_string())
        .bind(digest.as_bytes().as_slice())
        .fetch_optional(&mut **transaction)
        .await
        .map_err(database_error)?
        .ok_or(OrganizationInvitationServiceError::InvariantViolation)
}

async fn insert_pending(
    transaction: &mut Transaction<'_, Postgres>,
    input: PendingInsert<'_>,
) -> Result<sqlx::postgres::PgRow, OrganizationInvitationServiceError> {
    sqlx::query(concat!(
        "INSERT INTO organization_invitations (id, organization_id, invitee_user_id, ",
        "normalized_email, invited_by_user_id, proposed_role, token_hash, created_at, expires_at) ",
        "VALUES ($1::uuid, $2::uuid, $3::uuid, $4, $5::uuid, $6, $7, ",
        "$8::timestamptz, $9::timestamptz) RETURNING id::text, organization_id::text, ",
        "invitee_user_id::text, normalized_email, invited_by_user_id::text, proposed_role, ",
        "status, created_at, expires_at, accepted_at, declined_at, expired_at, revoked_at, ",
        "superseded_at, replaced_by_invitation_id::text"
    ))
    .bind(input.id.to_string())
    .bind(input.organization_id.to_string())
    .bind(input.invitee_user_id.to_string())
    .bind(input.email.as_str())
    .bind(input.inviter_user_id.to_string())
    .bind(role_name(input.role))
    .bind(input.digest.as_bytes().as_slice())
    .bind(input.created_at.to_string())
    .bind(input.expires_at.to_string())
    .fetch_one(&mut **transaction)
    .await
    .map_err(database_error)
}

async fn append_audit(
    transaction: &mut Transaction<'_, Postgres>,
    context: &OrganizationInvitationAuditContext,
    organization_id: OrganizationId,
    invitation_id: OrganizationInvitationId,
    input: AuditInput,
) -> Result<(), OrganizationInvitationServiceError> {
    let event = AuditEvent::new(AuditEventFields {
        id: context.event_id,
        occurred_at: transaction_now(transaction).await?,
        actor: AuditActor {
            kind: ActorType::User,
            id: context.actor_user_id.to_string(),
            user_id: Some(context.actor_user_id),
            display_name: context.actor_display_name.clone(),
        },
        action_code: input.action.into(),
        target: AuditTarget {
            kind: "organization_invitation".into(),
            id: invitation_id.to_string(),
        },
        scope: AuditScope {
            kind: ScopeType::Organization,
            id: organization_id.to_string(),
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
        metadata: AuditMetadata::new(json!({"source": "organization-invitation-service"}))
            .map_err(|_| OrganizationInvitationServiceError::InvalidAuditContext)?,
    })
    .map_err(|_| OrganizationInvitationServiceError::InvalidAuditContext)?;
    AuditWriter::append(transaction, &event)
        .await
        .map_err(|_| OrganizationInvitationServiceError::AuditUnavailable)
}

async fn enqueue_organization_invitation_email(
    transaction: &mut Transaction<'_, Postgres>,
    invitation_id: OrganizationInvitationId,
    invitee_user_id: UserId,
    email: &NormalizedEmail,
) -> Result<bool, OrganizationInvitationServiceError> {
    let enabled: Option<bool> = sqlx::query_scalar(
        "SELECT value='true'::jsonb FROM instance_settings WHERE key='smtp.enabled' FOR SHARE",
    )
    .fetch_optional(&mut **transaction)
    .await
    .map_err(database_error)?;
    if enabled != Some(true) {
        return Ok(false);
    }
    let notification_id = Uuid::now_v7().to_string();
    let outbox_id = Uuid::now_v7().to_string();
    sqlx::query(
        "INSERT INTO notifications
         (id,recipient_user_id,classification,event_code,template_id,locale,resource_type,
          resource_id,rendering_data,action_state,first_occurred_at,last_occurred_at)
         VALUES($1::uuid,$2::uuid,'collaboration','organization.invited',
                'organization.invited','en-US','organization_invitation',$3,'{}'::jsonb,
                'pending',transaction_timestamp(),transaction_timestamp())",
    )
    .bind(&notification_id)
    .bind(invitee_user_id.to_string())
    .bind(invitation_id.to_string())
    .execute(&mut **transaction)
    .await
    .map_err(database_error)?;
    sqlx::query(
        "INSERT INTO email_outbox
         (id,notification_id,recipient_user_id,recipient_email,classification,template_id,locale,
          resource_type,resource_id)
         VALUES($1::uuid,$2::uuid,$3::uuid,$4,'collaboration','organization.invited','en-US',
                'organization_invitation',$5)",
    )
    .bind(outbox_id)
    .bind(notification_id)
    .bind(invitee_user_id.to_string())
    .bind(email.as_str())
    .bind(invitation_id.to_string())
    .execute(&mut **transaction)
    .await
    .map_err(database_error)?;
    Ok(true)
}

fn invitation_from_row(
    row: &sqlx::postgres::PgRow,
) -> Result<OrganizationInvitation, OrganizationInvitationServiceError> {
    OrganizationInvitation::new(OrganizationInvitationFields {
        id: parse_id(row, "id")?,
        organization_id: parse_id(row, "organization_id")?,
        invitee_user_id: parse_id(row, "invitee_user_id")?,
        normalized_email: NormalizedEmail::parse(required(row, "normalized_email")?)
            .map_err(|_| OrganizationInvitationServiceError::InvariantViolation)?,
        invited_by_user_id: parse_id(row, "invited_by_user_id")?,
        proposed_role: parse_role(&required::<String>(row, "proposed_role")?)?,
        status: parse_status(&required::<String>(row, "status")?)?,
        created_at: parse_timestamp(row, "created_at")?,
        expires_at: parse_timestamp(row, "expires_at")?,
        accepted_at: parse_optional_timestamp(row, "accepted_at")?,
        declined_at: parse_optional_timestamp(row, "declined_at")?,
        expired_at: parse_optional_timestamp(row, "expired_at")?,
        revoked_at: parse_optional_timestamp(row, "revoked_at")?,
        superseded_at: parse_optional_timestamp(row, "superseded_at")?,
        replaced_by_invitation_id: parse_optional_id(row, "replaced_by_invitation_id")?,
    })
    .map_err(|_| OrganizationInvitationServiceError::InvariantViolation)
}

fn parse_status(
    value: &str,
) -> Result<OrganizationInvitationStatus, OrganizationInvitationServiceError> {
    match value {
        "pending" => Ok(OrganizationInvitationStatus::Pending),
        "accepted" => Ok(OrganizationInvitationStatus::Accepted),
        "declined" => Ok(OrganizationInvitationStatus::Declined),
        "expired" => Ok(OrganizationInvitationStatus::Expired),
        "revoked" => Ok(OrganizationInvitationStatus::Revoked),
        "superseded" => Ok(OrganizationInvitationStatus::Superseded),
        _ => Err(OrganizationInvitationServiceError::InvariantViolation),
    }
}

fn role_name(role: OrganizationRole) -> &'static str {
    match role {
        OrganizationRole::Owner => "owner",
        OrganizationRole::Member => "member",
    }
}

fn parse_role(value: &str) -> Result<OrganizationRole, OrganizationInvitationServiceError> {
    match value {
        "owner" => Ok(OrganizationRole::Owner),
        "member" => Ok(OrganizationRole::Member),
        _ => Err(OrganizationInvitationServiceError::InvariantViolation),
    }
}

fn ensure_audit_actor(
    actor: UserId,
    audit: &OrganizationInvitationAuditContext,
) -> Result<(), OrganizationInvitationServiceError> {
    if audit.actor_user_id != actor {
        return Err(OrganizationInvitationServiceError::InvalidAuditContext);
    }
    Ok(())
}

async fn transaction_now(
    transaction: &mut Transaction<'_, Postgres>,
) -> Result<Timestamp, OrganizationInvitationServiceError> {
    Timestamp::from_datetime(transaction_now_datetime(transaction).await?)
        .map_err(|_| OrganizationInvitationServiceError::InvariantViolation)
}

async fn transaction_now_datetime(
    transaction: &mut Transaction<'_, Postgres>,
) -> Result<OffsetDateTime, OrganizationInvitationServiceError> {
    sqlx::query_scalar("SELECT transaction_timestamp()")
        .fetch_one(&mut **transaction)
        .await
        .map_err(database_error)
}

fn required<T>(
    row: &sqlx::postgres::PgRow,
    column: &str,
) -> Result<T, OrganizationInvitationServiceError>
where
    T: for<'r> sqlx::Decode<'r, Postgres> + sqlx::Type<Postgres>,
{
    row.try_get(column)
        .map_err(|_| OrganizationInvitationServiceError::InvariantViolation)
}

fn parse_id<T>(
    row: &sqlx::postgres::PgRow,
    column: &str,
) -> Result<T, OrganizationInvitationServiceError>
where
    T: std::str::FromStr,
{
    required::<String>(row, column)?
        .parse()
        .map_err(|_| OrganizationInvitationServiceError::InvariantViolation)
}

fn parse_optional_id<T>(
    row: &sqlx::postgres::PgRow,
    column: &str,
) -> Result<Option<T>, OrganizationInvitationServiceError>
where
    T: std::str::FromStr,
{
    required::<Option<String>>(row, column)?
        .map(|value| {
            value
                .parse()
                .map_err(|_| OrganizationInvitationServiceError::InvariantViolation)
        })
        .transpose()
}

fn parse_timestamp(
    row: &sqlx::postgres::PgRow,
    column: &str,
) -> Result<Timestamp, OrganizationInvitationServiceError> {
    Timestamp::from_datetime(required(row, column)?)
        .map_err(|_| OrganizationInvitationServiceError::InvariantViolation)
}

fn parse_optional_timestamp(
    row: &sqlx::postgres::PgRow,
    column: &str,
) -> Result<Option<Timestamp>, OrganizationInvitationServiceError> {
    required::<Option<OffsetDateTime>>(row, column)?
        .map(Timestamp::from_datetime)
        .transpose()
        .map_err(|_| OrganizationInvitationServiceError::InvariantViolation)
}

fn database_error(_: sqlx::Error) -> OrganizationInvitationServiceError {
    OrganizationInvitationServiceError::DatabaseUnavailable
}

#[cfg(test)]
mod tests;
