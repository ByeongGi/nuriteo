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

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub struct OrganizationInvitationActor {
    user_id: UserId,
    session_id: SessionId,
}

#[derive(Debug, Clone, PartialEq, Eq)]
pub struct OrganizationInvitationInvitee {
    user_id: UserId,
    session_id: SessionId,
    verified_email: NormalizedEmail,
}

#[derive(Clone)]
pub struct OrganizationInvitationAuditContext {
    event_id: AuditEventId,
    actor_user_id: UserId,
    actor_display_name: Option<String>,
    correlation_id: String,
    source_ip: Option<IpAddr>,
}

pub struct IssuedOrganizationInvitation {
    invitation: OrganizationInvitation,
    token: OrganizationInvitationToken,
    email_delivery_queued: bool,
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

#[derive(Clone)]
pub struct OrganizationInvitationService {
    pool: DatabasePool,
    policy: OrganizationInvitationPolicy,
    live_default_expiry: bool,
}

pub(crate) struct PendingInsert<'a> {
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

pub(crate) struct AuditInput {
    action: &'static str,
    result: AuditResult,
    reason: Option<&'static str>,
    changed_fields: &'static [&'static str],
}

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub(crate) enum PendingState {
    Pending,
    Expired,
    Inactive,
}

#[cfg(test)]
mod tests;

mod membership_invites;
pub(crate) use membership_invites::*;
mod admission;
pub(crate) use admission::*;
