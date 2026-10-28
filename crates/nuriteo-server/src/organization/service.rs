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


#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum OrganizationPrincipal {
    Owner(UserId),
    InstanceAdministrator(UserId),
}


#[derive(Clone)]
pub struct OrganizationAuditContext {
    event_id: AuditEventId,
    actor_user_id: UserId,
    actor_display_name: Option<String>,
    correlation_id: String,
    source_ip: Option<IpAddr>,
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


#[derive(Clone)]
pub struct OrganizationService {
    pool: DatabasePool,
    policy: OrganizationServicePolicy,
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


#[cfg(test)]
mod tests;


mod organizations;
pub(crate) use organizations::*;
mod member_audit;
pub(crate) use member_audit::*;
