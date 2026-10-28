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

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub struct InvitationServicePolicy {
    expiry: InvitationExpiryPolicy,
    operation_timeout: Duration,
}

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum InvitationServicePolicyError {
    InvalidOperationTimeout,
}

pub struct IssuedActivationInvitation {
    invitation: ActivationInvitation,
    token: ActivationToken,
    email_delivery_queued: bool,
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

#[derive(Clone)]
pub struct InvitationService {
    pool: DatabasePool,
    policy: InvitationServicePolicy,
    live_default_expiry: bool,
}

pub(crate) struct AuditInput {
    action: &'static str,
    target_id: String,
    result: AuditResult,
    reason: Option<&'static str>,
    changed_fields: &'static [&'static str],
    metadata: serde_json::Value,
}

const fn map_token_error(error: ActivationTokenError) -> InvitationServiceError {
    match error {
        ActivationTokenError::EntropyUnavailable => InvitationServiceError::EntropyUnavailable,
        ActivationTokenError::InvalidToken => InvitationServiceError::InvariantViolation,
    }
}

#[cfg(test)]
mod tests;

mod activation;
pub(crate) use activation::*;
mod invitation_store;
pub(crate) use invitation_store::*;
