#![allow(unused_imports)]
use super::activation::*;
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

pub(crate) async fn lock_invitation(
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

pub(crate) async fn lock_invitation_by_digest(
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

pub(crate) async fn mark_expired(
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

pub(crate) async fn insert_pending(
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

pub(crate) async fn transaction_now(
    transaction: &mut Transaction<'_, Postgres>,
) -> Result<Timestamp, InvitationServiceError> {
    Timestamp::from_datetime(transaction_now_datetime(transaction).await?)
        .map_err(|_| InvitationServiceError::InvariantViolation)
}

pub(crate) async fn enqueue_activation_email(
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

pub(crate) async fn transaction_now_datetime(
    transaction: &mut Transaction<'_, Postgres>,
) -> Result<OffsetDateTime, InvitationServiceError> {
    sqlx::query_scalar("SELECT transaction_timestamp()")
        .fetch_one(&mut **transaction)
        .await
        .map_err(database_error)
}

pub(crate) async fn append_denied_and_commit(
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

pub(crate) async fn append_audit(
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

pub(crate) fn invitation_from_row(
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

pub(crate) fn required<T>(
    row: &sqlx::postgres::PgRow,
    column: &str,
) -> Result<T, InvitationServiceError>
where
    T: for<'r> sqlx::Decode<'r, Postgres> + sqlx::Type<Postgres>,
{
    row.try_get(column)
        .map_err(|_| InvitationServiceError::InvariantViolation)
}

pub(crate) fn parse_id<T>(
    row: &sqlx::postgres::PgRow,
    column: &str,
) -> Result<T, InvitationServiceError>
where
    T: std::str::FromStr,
{
    required::<String>(row, column)?
        .parse()
        .map_err(|_| InvitationServiceError::InvariantViolation)
}

pub(crate) fn parse_optional_id<T>(
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

pub(crate) fn parse_timestamp(
    row: &sqlx::postgres::PgRow,
    column: &str,
) -> Result<Timestamp, InvitationServiceError> {
    Timestamp::from_datetime(required(row, column)?)
        .map_err(|_| InvitationServiceError::InvariantViolation)
}

pub(crate) fn parse_optional_timestamp(
    row: &sqlx::postgres::PgRow,
    column: &str,
) -> Result<Option<Timestamp>, InvitationServiceError> {
    required::<Option<OffsetDateTime>>(row, column)?
        .map(Timestamp::from_datetime)
        .transpose()
        .map_err(|_| InvitationServiceError::InvariantViolation)
}

pub(crate) fn database_error(_: sqlx::Error) -> InvitationServiceError {
    InvitationServiceError::DatabaseUnavailable
}
