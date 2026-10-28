#![allow(unused_imports)]
use super::*;
use super::admission::*;
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


use super::super::invitation::OrganizationInvitationTokenDigest;

use super::super::{
    OrganizationId, OrganizationInvitation, OrganizationInvitationFields, OrganizationInvitationId,
    OrganizationInvitationStatus, OrganizationInvitationToken, OrganizationRole,
};
use super::{DEFAULT_OPERATION_TIMEOUT, MIN_OPERATION_TIMEOUT, MAX_OPERATION_TIMEOUT, DEFAULT_REAUTHENTICATION_AGE, MIN_REAUTHENTICATION_AGE, MAX_REAUTHENTICATION_AGE, OrganizationInvitationPolicy, OrganizationInvitationActor, OrganizationInvitationInvitee, OrganizationInvitationAuditContext, IssuedOrganizationInvitation, OrganizationInvitationRevokeResult, OrganizationInvitationServiceError, OrganizationInvitationService, PendingInsert, AuditInput, PendingState};



impl super::OrganizationInvitationPolicy {
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


impl Default for OrganizationInvitationPolicy { fn default() -> Self {
        Self {
            expiry: InvitationExpiryPolicy::default(),
            operation_timeout: DEFAULT_OPERATION_TIMEOUT,
            reauthentication_max_age: DEFAULT_REAUTHENTICATION_AGE,
        }
    }
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


impl fmt::Debug for OrganizationInvitationAuditContext { fn fmt(&self, formatter: &mut fmt::Formatter<'_>) -> fmt::Result {
        formatter
            .debug_struct("OrganizationInvitationAuditContext")
            .field("event_id", &self.event_id)
            .finish_non_exhaustive()
    }
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


impl fmt::Debug for IssuedOrganizationInvitation { fn fmt(&self, formatter: &mut fmt::Formatter<'_>) -> fmt::Result {
        formatter
            .debug_struct("IssuedOrganizationInvitation")
            .field("invitation", &self.invitation)
            .field("token", &"[REDACTED]")
            .finish()
    }
}


impl fmt::Display for OrganizationInvitationServiceError { fn fmt(&self, formatter: &mut fmt::Formatter<'_>) -> fmt::Result {
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
            super::super::OrganizationInvitationError::EntropyUnavailable => {
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

    pub(crate) async fn within_deadline<T>(
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
    pub(crate) async fn issue_inner(
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

    pub(crate) async fn reissue_inner(
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

    pub(crate) async fn effective_expiry(
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

    pub(crate) async fn revoke_inner(
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

    pub(crate) async fn accept_inner(
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

    pub(crate) async fn decline_inner(
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

    pub(crate) async fn acquire(
        &self,
    ) -> Result<sqlx::pool::PoolConnection<Postgres>, OrganizationInvitationServiceError> {
        self.pool
            .acquire()
            .await
            .map_err(|_| OrganizationInvitationServiceError::DatabaseUnavailable)
    }
}


impl AuditInput {
    pub(crate) const fn success(action: &'static str, changed_fields: &'static [&'static str]) -> Self {
        Self {
            action,
            result: AuditResult::Succeeded,
            reason: None,
            changed_fields,
        }
    }

    pub(crate) const fn denied(action: &'static str, reason: &'static str) -> Self {
        Self {
            action,
            result: AuditResult::Denied,
            reason: Some(reason),
            changed_fields: &[],
        }
    }
}


pub(crate) async fn authorize_owner(    transaction: &mut Transaction<'_, Postgres>,
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


pub(crate) async fn lock_organization(    transaction: &mut Transaction<'_, Postgres>,
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


pub(crate) async fn require_active_invitee_by_id(    transaction: &mut Transaction<'_, Postgres>,
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
