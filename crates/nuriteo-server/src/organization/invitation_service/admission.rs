#![allow(unused_imports)]
use super::*;
use super::membership_invites::*;
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



pub(crate) async fn resolve_active_invitee(    transaction: &mut Transaction<'_, Postgres>,
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


pub(crate) fn enumeration_safe_issue_error(    error: OrganizationInvitationServiceError,
) -> OrganizationInvitationServiceError {
    match error {
        OrganizationInvitationServiceError::Unauthorized => {
            OrganizationInvitationServiceError::InviteeUnavailable
        }
        other => other,
    }
}


pub(crate) async fn verify_invitee(    transaction: &mut Transaction<'_, Postgres>,
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


pub(crate) async fn ensure_not_member(    transaction: &mut Transaction<'_, Postgres>,
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


pub(crate) async fn lock_membership_admission(    transaction: &mut Transaction<'_, Postgres>,
    organization_id: OrganizationId,
) -> Result<(), OrganizationInvitationServiceError> {
    sqlx::query("SELECT pg_advisory_xact_lock(1314212943, hashtext($1))")
        .bind(organization_id.to_string())
        .execute(&mut **transaction)
        .await
        .map_err(database_error)?;
    Ok(())
}


pub(crate) async fn ensure_member_capacity(    transaction: &mut Transaction<'_, Postgres>,
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
    if members >= super::super::MAX_MEMBERS {
        return Err(OrganizationInvitationServiceError::MemberLimitReached);
    }
    Ok(())
}


pub(crate) fn membership_write_error(error: sqlx::Error) -> OrganizationInvitationServiceError {    if error.as_database_error().is_some_and(|database| {
        database.code().as_deref() == Some("23514")
            && database.constraint() == Some("organization_member_limit")
    }) {
        OrganizationInvitationServiceError::MemberLimitReached
    } else {
        OrganizationInvitationServiceError::DatabaseUnavailable
    }
}


pub(crate) async fn expire_pending(    transaction: &mut Transaction<'_, Postgres>,
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


pub(crate) async fn pending_exists(    transaction: &mut Transaction<'_, Postgres>,
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


pub(crate) async fn invitation_organization(    transaction: &mut Transaction<'_, Postgres>,
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


pub(crate) async fn invitation_organization_by_digest(    transaction: &mut Transaction<'_, Postgres>,
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


pub(crate) async fn lock_invitation_by_id(    transaction: &mut Transaction<'_, Postgres>,
    id: OrganizationInvitationId,
) -> Result<Option<sqlx::postgres::PgRow>, OrganizationInvitationServiceError> {
    invitation_query()
        .bind(id.to_string())
        .fetch_optional(&mut **transaction)
        .await
        .map_err(database_error)
}


pub(crate) async fn lock_invitation_by_digest(    transaction: &mut Transaction<'_, Postgres>,
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


pub(crate) fn invitation_query() -> sqlx::query::Query<'static, Postgres, sqlx::postgres::PgArguments> {    sqlx::query(concat!(
        "SELECT id::text, organization_id::text, invitee_user_id::text, normalized_email, ",
        "invited_by_user_id::text, proposed_role, status, created_at, expires_at, ",
        "accepted_at, declined_at, expired_at, revoked_at, superseded_at, ",
        "replaced_by_invitation_id::text FROM organization_invitations ",
        "WHERE id = $1::uuid FOR UPDATE"
    ))
}


pub(crate) async fn pending_state(    transaction: &mut Transaction<'_, Postgres>,
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


pub(crate) async fn mark_expired(    transaction: &mut Transaction<'_, Postgres>,
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


pub(crate) async fn transition_pending(    transaction: &mut Transaction<'_, Postgres>,
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


pub(crate) async fn transition_pending_returning(    transaction: &mut Transaction<'_, Postgres>,
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


pub(crate) async fn insert_pending(    transaction: &mut Transaction<'_, Postgres>,
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


pub(crate) async fn append_audit(    transaction: &mut Transaction<'_, Postgres>,
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


pub(crate) async fn enqueue_organization_invitation_email(    transaction: &mut Transaction<'_, Postgres>,
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


pub(crate) fn invitation_from_row(    row: &sqlx::postgres::PgRow,
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


pub(crate) fn parse_status(    value: &str,
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


pub(crate) fn role_name(role: OrganizationRole) -> &'static str {    match role {
        OrganizationRole::Owner => "owner",
        OrganizationRole::Member => "member",
    }
}


pub(crate) fn parse_role(value: &str) -> Result<OrganizationRole, OrganizationInvitationServiceError> {    match value {
        "owner" => Ok(OrganizationRole::Owner),
        "member" => Ok(OrganizationRole::Member),
        _ => Err(OrganizationInvitationServiceError::InvariantViolation),
    }
}


pub(crate) fn ensure_audit_actor(    actor: UserId,
    audit: &OrganizationInvitationAuditContext,
) -> Result<(), OrganizationInvitationServiceError> {
    if audit.actor_user_id != actor {
        return Err(OrganizationInvitationServiceError::InvalidAuditContext);
    }
    Ok(())
}


pub(crate) async fn transaction_now(    transaction: &mut Transaction<'_, Postgres>,
) -> Result<Timestamp, OrganizationInvitationServiceError> {
    Timestamp::from_datetime(transaction_now_datetime(transaction).await?)
        .map_err(|_| OrganizationInvitationServiceError::InvariantViolation)
}


pub(crate) async fn transaction_now_datetime(    transaction: &mut Transaction<'_, Postgres>,
) -> Result<OffsetDateTime, OrganizationInvitationServiceError> {
    sqlx::query_scalar("SELECT transaction_timestamp()")
        .fetch_one(&mut **transaction)
        .await
        .map_err(database_error)
}


pub(crate) fn required<T>(    row: &sqlx::postgres::PgRow,
    column: &str,
) -> Result<T, OrganizationInvitationServiceError>
where
    T: for<'r> sqlx::Decode<'r, Postgres> + sqlx::Type<Postgres>,
{
    row.try_get(column)
        .map_err(|_| OrganizationInvitationServiceError::InvariantViolation)
}


pub(crate) fn parse_id<T>(    row: &sqlx::postgres::PgRow,
    column: &str,
) -> Result<T, OrganizationInvitationServiceError>
where
    T: std::str::FromStr,
{
    required::<String>(row, column)?
        .parse()
        .map_err(|_| OrganizationInvitationServiceError::InvariantViolation)
}


pub(crate) fn parse_optional_id<T>(    row: &sqlx::postgres::PgRow,
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


pub(crate) fn parse_timestamp(    row: &sqlx::postgres::PgRow,
    column: &str,
) -> Result<Timestamp, OrganizationInvitationServiceError> {
    Timestamp::from_datetime(required(row, column)?)
        .map_err(|_| OrganizationInvitationServiceError::InvariantViolation)
}


pub(crate) fn parse_optional_timestamp(    row: &sqlx::postgres::PgRow,
    column: &str,
) -> Result<Option<Timestamp>, OrganizationInvitationServiceError> {
    required::<Option<OffsetDateTime>>(row, column)?
        .map(Timestamp::from_datetime)
        .transpose()
        .map_err(|_| OrganizationInvitationServiceError::InvariantViolation)
}


pub(crate) fn database_error(_: sqlx::Error) -> OrganizationInvitationServiceError {    OrganizationInvitationServiceError::DatabaseUnavailable
}
