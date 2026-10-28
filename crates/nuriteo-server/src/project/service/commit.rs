#![allow(unused_imports)]
use super::audit_context::*;
use super::authorization::*;
use super::projects::*;
use super::*;
use std::fmt;

use std::future::Future;

use std::net::IpAddr;

use std::sync::{
    Arc,
    atomic::{AtomicBool, Ordering},
};

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

use crate::organization::OrganizationId;

use crate::workspace::StorageScopeId;

use super::super::{
    DirectProjectRoleGrant, EffectiveProjectRole, NewProject, Project, ProjectAccessError,
    ProjectAccessRepository, ProjectConflict, ProjectId, ProjectName, ProjectOwner, ProjectPageKey,
    ProjectPageLimit, ProjectRepository, ProjectRepositoryError, ProjectRole, ProjectRoleVersion,
    ProjectSlug, ProjectState, ProjectTemplate, ProjectVersion,
};
use super::{
    COMMIT_RESOLUTION_GRACE, DATABASE_TIMEOUT_RESOLUTION_MARGIN, DEFAULT_OPERATION_TIMEOUT,
    DEFAULT_PROJECT_ROLE_PAGE_SIZE, DirectProjectRolePage, GrantRow, ListAuthorization,
    MAX_OPERATION_TIMEOUT, MAX_PROJECT_ROLE_PAGE_SIZE, MIN_DATABASE_TIMEOUT, MIN_OPERATION_TIMEOUT,
    MutationDeadline, ProjectAuditContext, ProjectDeleteConfirmation, ProjectListPage,
    ProjectRoleMutationResult, ProjectRolePageKey, ProjectRolePageLimit, ProjectRow,
    ProjectService, ProjectServiceError, ProjectServicePolicy,
};

pub(crate) async fn configure_transaction_deadline(
    transaction: &mut Transaction<'_, Postgres>,
    deadline: &MutationDeadline,
) -> Result<(), ProjectServiceError> {
    let timeout = postgres_timeout(deadline.remaining()?);
    sqlx::query(
        "SELECT set_config('statement_timeout', $1, true), \
                set_config('lock_timeout', $1, true)",
    )
    .bind(timeout)
    .execute(&mut **transaction)
    .await
    .map_err(map_service_query_error)?;
    Ok(())
}

pub(crate) fn postgres_timeout(remaining: Duration) -> String {
    let millis = remaining
        .saturating_sub(DATABASE_TIMEOUT_RESOLUTION_MARGIN)
        .max(MIN_DATABASE_TIMEOUT)
        .as_millis()
        .min(i32::MAX as u128);
    format!("{millis}ms")
}

pub(crate) async fn commit(
    mut transaction: Transaction<'_, Postgres>,
    deadline: &MutationDeadline,
) -> Result<(), ProjectServiceError> {
    configure_transaction_deadline(&mut transaction, deadline).await?;
    // Once COMMIT is sent, the operation deadline no longer cancels it: doing
    // so could turn a committed mutation into an apparent rollback. A separate
    // bounded resolution grace classifies response loss as unknown instead.
    deadline.commit_started.store(true, Ordering::Release);
    resolve_commit(transaction.commit(), COMMIT_RESOLUTION_GRACE).await
}

pub(crate) async fn resolve_commit(
    commit: impl Future<Output = Result<(), sqlx::Error>>,
    resolution_grace: Duration,
) -> Result<(), ProjectServiceError> {
    match tokio_time::timeout(resolution_grace, commit).await {
        Ok(result) => result.map_err(map_commit_error),
        Err(_) => Err(ProjectServiceError::CommitOutcomeUnknown),
    }
}

pub(crate) fn map_commit_error(error: sqlx::Error) -> ProjectServiceError {
    match error.as_database_error().and_then(|error| error.code()) {
        Some(code) if code == "57014" || code == "55P03" => ProjectServiceError::OperationTimeout,
        Some(_) => ProjectServiceError::DatabaseUnavailable,
        None => ProjectServiceError::CommitOutcomeUnknown,
    }
}

pub(crate) fn map_service_query_error(error: sqlx::Error) -> ProjectServiceError {
    match error.as_database_error().and_then(|error| error.code()) {
        Some(code) if code == "57014" || code == "55P03" => ProjectServiceError::OperationTimeout,
        _ => ProjectServiceError::DatabaseUnavailable,
    }
}

pub(crate) fn map_repository_error(error: ProjectRepositoryError) -> ProjectServiceError {
    match error {
        ProjectRepositoryError::Conflict(ProjectConflict::NamespaceUnavailable) => {
            ProjectServiceError::NamespaceUnavailable
        }
        ProjectRepositoryError::Conflict(
            ProjectConflict::IdentifierExists | ProjectConflict::OwnerScopeMismatch,
        )
        | ProjectRepositoryError::InvalidPersistedState => ProjectServiceError::InvariantViolation,
        ProjectRepositoryError::InvalidPageLimit => ProjectServiceError::InvalidInput,
        ProjectRepositoryError::OperationTimeout => ProjectServiceError::OperationTimeout,
        ProjectRepositoryError::PersistenceUnavailable => ProjectServiceError::DatabaseUnavailable,
    }
}

pub(crate) fn map_access_error(error: ProjectAccessError) -> ProjectServiceError {
    match error {
        ProjectAccessError::ProjectUnavailable => ProjectServiceError::NotFound,
        ProjectAccessError::ProjectNotOrganizationOwned => ProjectServiceError::Unauthorized,
        ProjectAccessError::MemberUnavailable => ProjectServiceError::MemberUnavailable,
        ProjectAccessError::AlreadyGranted => ProjectServiceError::RoleAlreadyExists,
        ProjectAccessError::InvalidPersistedState => ProjectServiceError::InvariantViolation,
        ProjectAccessError::OperationTimeout => ProjectServiceError::OperationTimeout,
        ProjectAccessError::PersistenceUnavailable => ProjectServiceError::DatabaseUnavailable,
    }
}
