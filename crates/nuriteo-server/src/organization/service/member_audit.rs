#![allow(unused_imports)]
use super::*;
use super::organizations::*;
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


use super::super::{
    Organization, OrganizationFields, OrganizationId, OrganizationRole, OrganizationStatus,
    OrganizationVersion,
};
use super::{DEFAULT_OPERATION_TIMEOUT, MIN_OPERATION_TIMEOUT, MAX_OPERATION_TIMEOUT, OrganizationServicePolicy, OrganizationPrincipal, OrganizationAuditContext, MembershipAddResult, MembershipChangeResult, MembershipRemoveResult, OrganizationServiceError, OrganizationService, OrganizationRow, AuthorizedOrganizationRow};



pub(crate) async fn update_organization(    transaction: &mut Transaction<'_, Postgres>,
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


pub(crate) async fn append_audit(    transaction: &mut Transaction<'_, Postgres>,
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


pub(crate) async fn append_membership_audit(    transaction: &mut Transaction<'_, Postgres>,
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
pub(crate) async fn append_audit_target(    transaction: &mut Transaction<'_, Postgres>,
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


pub(crate) async fn commit(transaction: Transaction<'_, Postgres>) -> Result<(), OrganizationServiceError> {    transaction
        .commit()
        .await
        .map_err(|_| OrganizationServiceError::DatabaseUnavailable)
}


pub(crate) fn decode_organization(row: OrganizationRow) -> Result<Organization, OrganizationServiceError> {    Organization::new(OrganizationFields {
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


pub(crate) fn role_name(role: OrganizationRole) -> &'static str {    match role {
        OrganizationRole::Owner => "owner",
        OrganizationRole::Member => "member",
    }
}


pub(crate) fn parse_role(role: &str) -> Result<OrganizationRole, OrganizationServiceError> {    match role {
        "owner" => Ok(OrganizationRole::Owner),
        "member" => Ok(OrganizationRole::Member),
        _ => Err(OrganizationServiceError::InvariantViolation),
    }
}


pub(crate) async fn transaction_now(    transaction: &mut Transaction<'_, Postgres>,
) -> Result<Timestamp, OrganizationServiceError> {
    let value: OffsetDateTime = sqlx::query_scalar("SELECT transaction_timestamp()")
        .fetch_one(&mut **transaction)
        .await
        .map_err(|_| OrganizationServiceError::DatabaseUnavailable)?;
    Timestamp::from_datetime(value).map_err(|_| OrganizationServiceError::InvariantViolation)
}


pub(crate) fn is_unique_violation(error: &sqlx::Error) -> bool {    matches!(error, sqlx::Error::Database(database) if database.is_unique_violation())
}
