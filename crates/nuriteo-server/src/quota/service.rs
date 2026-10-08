use std::fmt;
use std::future::Future;
use std::time::Duration;

use sqlx::{Acquire, Postgres, Transaction};
use time::OffsetDateTime;
use tokio::time::{self as tokio_time, Instant};

use crate::database::{DatabaseError, DatabasePool};
use crate::policy::EffectivePolicyEngine;
use crate::project::ProjectId;
use crate::workspace::StorageScopeId;

use super::QuotaRepository;
use super::types::{
    EffectiveQuota, QuotaProjection, ReservationRequest, ReservationResult, SaveSessionId,
    TerminalSaveState,
};

const DEFAULT_OPERATION_TIMEOUT: Duration = Duration::from_secs(5);
const MIN_OPERATION_TIMEOUT: Duration = Duration::from_millis(100);
const MAX_OPERATION_TIMEOUT: Duration = Duration::from_secs(30);
const SQL_TIMEOUT_MARGIN: Duration = Duration::from_millis(25);
const EXPIRY_SWEEP_BATCH_SIZE: i64 = 100;

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub struct QuotaServicePolicy {
    operation_timeout: Duration,
}

impl QuotaServicePolicy {
    pub fn new(operation_timeout: Duration) -> Result<Self, QuotaServiceError> {
        if !(MIN_OPERATION_TIMEOUT..=MAX_OPERATION_TIMEOUT).contains(&operation_timeout) {
            return Err(QuotaServiceError::InvalidInput);
        }
        Ok(Self { operation_timeout })
    }

    #[must_use]
    pub const fn operation_timeout(self) -> Duration {
        self.operation_timeout
    }
}

impl Default for QuotaServicePolicy {
    fn default() -> Self {
        Self {
            operation_timeout: DEFAULT_OPERATION_TIMEOUT,
        }
    }
}

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
#[non_exhaustive]
pub enum QuotaServiceError {
    InvalidInput,
    ScopeNotFound,
    ProjectNotFound,
    SessionNotFound,
    WrongScope,
    SessionTerminal,
    SessionExpired,
    ReservationConflict,
    QuotaExceeded,
    ArithmeticOverflow,
    OperationTimeout,
    DatabaseUnavailable,
    CommitOutcomeUnknown,
    InvariantViolation,
}

impl fmt::Display for QuotaServiceError {
    fn fmt(&self, formatter: &mut fmt::Formatter<'_>) -> fmt::Result {
        formatter.write_str(match self {
            Self::InvalidInput => "quota reservation input is invalid",
            Self::ScopeNotFound => "storage scope was not found",
            Self::ProjectNotFound => "project was not found",
            Self::SessionNotFound => "save session was not found",
            Self::WrongScope => "save session does not belong to the storage scope",
            Self::SessionTerminal => "save session is terminal",
            Self::SessionExpired => "save session has expired",
            Self::ReservationConflict => {
                "save session reservation conflicts with the existing reservation"
            }
            Self::QuotaExceeded => "workspace storage quota is exceeded",
            Self::ArithmeticOverflow => "workspace storage accounting overflowed",
            Self::OperationTimeout => "quota operation timed out",
            Self::DatabaseUnavailable => "quota persistence is unavailable",
            Self::CommitOutcomeUnknown => "quota transaction commit outcome is unknown",
            Self::InvariantViolation => "quota persistence state is invalid",
        })
    }
}

impl std::error::Error for QuotaServiceError {}

#[derive(Clone)]
pub struct QuotaService {
    pool: DatabasePool,
    policy: QuotaServicePolicy,
    live_instance_defaults: bool,
}

#[derive(Clone, Copy)]
struct OperationDeadline(Instant);

impl OperationDeadline {
    fn new(timeout: Duration) -> Self {
        Self(Instant::now() + timeout)
    }

    fn remaining(self) -> Result<Duration, QuotaServiceError> {
        let remaining = self.0.saturating_duration_since(Instant::now());
        if remaining.is_zero() {
            Err(QuotaServiceError::OperationTimeout)
        } else {
            Ok(remaining)
        }
    }

    async fn run<T>(self, future: impl Future<Output = T>) -> Result<T, QuotaServiceError> {
        tokio_time::timeout_at(self.0, future)
            .await
            .map_err(|_| QuotaServiceError::OperationTimeout)
    }
}

enum ReserveOutcome {
    Reserved(ReservationResult),
    Expired,
}

pub(crate) enum ReservationAdmission {
    Reserved,
    Expired,
}

impl ReservationAdmission {
    pub(crate) const fn is_expired(&self) -> bool {
        matches!(self, Self::Expired)
    }
}

impl QuotaService {
    #[must_use]
    pub const fn new(pool: DatabasePool, policy: QuotaServicePolicy) -> Self {
        Self {
            pool,
            policy,
            live_instance_defaults: false,
        }
    }

    #[must_use]
    pub const fn new_live(pool: DatabasePool, policy: QuotaServicePolicy) -> Self {
        Self {
            pool,
            policy,
            live_instance_defaults: true,
        }
    }

    pub async fn projection(
        &self,
        storage_scope_id: StorageScopeId,
        effective_quota: EffectiveQuota,
    ) -> Result<QuotaProjection, QuotaServiceError> {
        let effective_quota = effective_quota.validate()?;
        let deadline = OperationDeadline::new(self.policy.operation_timeout);
        let mut connection = deadline
            .run(self.pool.acquire())
            .await?
            .map_err(map_database_error)?;
        let mut transaction = deadline
            .run(connection.begin())
            .await?
            .map_err(map_sql_error)?;
        configure_transaction(&mut transaction, deadline).await?;
        lock_scope(&mut transaction, storage_scope_id, deadline).await?;
        let effective_quota = if self.live_instance_defaults {
            live_quota(
                &mut transaction,
                storage_scope_id,
                effective_quota,
                deadline,
            )
            .await?
        } else {
            effective_quota
        };
        let projection = load_projection(
            &mut transaction,
            storage_scope_id,
            effective_quota,
            deadline,
        )
        .await?;
        deadline
            .run(transaction.rollback())
            .await?
            .map_err(map_sql_error)?;
        Ok(projection)
    }

    pub async fn reserve(
        &self,
        request: ReservationRequest,
    ) -> Result<ReservationResult, QuotaServiceError> {
        let mut request = request.validate()?;
        let deadline = OperationDeadline::new(self.policy.operation_timeout);
        let mut connection = deadline
            .run(self.pool.acquire())
            .await?
            .map_err(map_database_error)?;
        let mut transaction = deadline
            .run(connection.begin())
            .await?
            .map_err(map_sql_error)?;
        configure_transaction(&mut transaction, deadline).await?;
        if self.live_instance_defaults {
            lock_scope(&mut transaction, request.storage_scope_id, deadline).await?;
            request.effective_quota = live_quota(
                &mut transaction,
                request.storage_scope_id,
                request.effective_quota,
                deadline,
            )
            .await?;
        }
        let outcome = reserve_in_transaction(&mut transaction, request, deadline).await?;
        commit(transaction, deadline).await?;
        match outcome {
            ReserveOutcome::Reserved(result) => Ok(result),
            ReserveOutcome::Expired => Err(QuotaServiceError::SessionExpired),
        }
    }

    /// Admits a Save session inside its caller-owned transaction while
    /// preserving the service's authoritative live-policy source.
    pub(crate) async fn reserve_before_commit(
        &self,
        transaction: &mut Transaction<'_, Postgres>,
        mut request: ReservationRequest,
        absolute_deadline: Instant,
    ) -> Result<ReservationAdmission, QuotaServiceError> {
        request = request.validate()?;
        let deadline = OperationDeadline(absolute_deadline);
        configure_transaction(transaction, deadline).await?;
        if self.live_instance_defaults {
            lock_scope(transaction, request.storage_scope_id, deadline).await?;
            request.effective_quota = live_quota(
                transaction,
                request.storage_scope_id,
                request.effective_quota,
                deadline,
            )
            .await?;
        }
        match reserve_in_transaction(transaction, request, deadline).await? {
            ReserveOutcome::Reserved(_) => Ok(ReservationAdmission::Reserved),
            ReserveOutcome::Expired => Ok(ReservationAdmission::Expired),
        }
    }

    /// Expires stale active Save sessions and releases their reservations in
    /// one transaction. The storage scope and affected Projects are locked in
    /// the same order as reservation and terminal-transition operations.
    pub async fn release_expired(
        &self,
        storage_scope_id: StorageScopeId,
    ) -> Result<u64, QuotaServiceError> {
        let deadline = OperationDeadline::new(self.policy.operation_timeout);
        let mut connection = deadline
            .run(self.pool.acquire())
            .await?
            .map_err(map_database_error)?;
        let mut transaction = deadline
            .run(connection.begin())
            .await?
            .map_err(map_sql_error)?;
        configure_transaction(&mut transaction, deadline).await?;
        lock_scope(&mut transaction, storage_scope_id, deadline).await?;
        let released =
            release_expired_in_transaction(&mut transaction, storage_scope_id, deadline).await?;
        commit(transaction, deadline).await?;
        Ok(released)
    }

    pub async fn transition_terminal(
        &self,
        storage_scope_id: StorageScopeId,
        project_id: ProjectId,
        save_session_id: SaveSessionId,
        state: TerminalSaveState,
    ) -> Result<(), QuotaServiceError> {
        self.transition_terminal_before(
            storage_scope_id,
            project_id,
            save_session_id,
            state,
            Instant::now() + self.policy.operation_timeout,
        )
        .await
    }

    pub(crate) async fn transition_terminal_before(
        &self,
        storage_scope_id: StorageScopeId,
        project_id: ProjectId,
        save_session_id: SaveSessionId,
        state: TerminalSaveState,
        absolute_deadline: Instant,
    ) -> Result<(), QuotaServiceError> {
        let deadline = OperationDeadline(absolute_deadline);
        let mut connection = deadline
            .run(self.pool.acquire())
            .await?
            .map_err(map_database_error)?;
        let mut transaction = deadline
            .run(connection.begin())
            .await?
            .map_err(map_sql_error)?;
        configure_transaction(&mut transaction, deadline).await?;
        lock_scope(&mut transaction, storage_scope_id, deadline).await?;
        lock_project(&mut transaction, storage_scope_id, project_id, deadline).await?;
        let session = load_session(
            &mut transaction,
            storage_scope_id,
            project_id,
            save_session_id,
            deadline,
        )
        .await?;
        if is_terminal(&session.state) {
            if session.state == state.as_str() {
                deadline
                    .run(transaction.rollback())
                    .await?
                    .map_err(map_sql_error)?;
                return Ok(());
            }
            return Err(QuotaServiceError::SessionTerminal);
        }
        if state != TerminalSaveState::Expired && session.expired {
            return Err(QuotaServiceError::SessionExpired);
        }
        let result = deadline
            .run(
                sqlx::query(
                    "UPDATE save_sessions SET state = $2, terminal_at = transaction_timestamp(), \
                     updated_at = transaction_timestamp() WHERE id = $1::uuid",
                )
                .bind(save_session_id.to_string())
                .bind(state.as_str())
                .execute(&mut *transaction),
            )
            .await?
            .map_err(map_sql_error)?;
        if result.rows_affected() != 1 {
            return Err(QuotaServiceError::InvariantViolation);
        }
        commit(transaction, deadline).await
    }
}

async fn reserve_in_transaction(
    transaction: &mut Transaction<'_, Postgres>,
    request: ReservationRequest,
    deadline: OperationDeadline,
) -> Result<ReserveOutcome, QuotaServiceError> {
    lock_scope(transaction, request.storage_scope_id, deadline).await?;
    lock_project(
        transaction,
        request.storage_scope_id,
        request.project_id,
        deadline,
    )
    .await?;
    let session = load_session(
        transaction,
        request.storage_scope_id,
        request.project_id,
        request.save_session_id,
        deadline,
    )
    .await?;
    if session.state == "expired" {
        return Err(QuotaServiceError::SessionExpired);
    }
    if is_terminal(&session.state) {
        return Err(QuotaServiceError::SessionTerminal);
    }
    if session.expired {
        deadline
            .run(
                sqlx::query(
                    "UPDATE save_sessions SET state = 'expired', terminal_at = transaction_timestamp(), \
                     updated_at = transaction_timestamp() WHERE id = $1::uuid",
                )
                .bind(request.save_session_id.to_string())
                .execute(&mut **transaction),
            )
            .await?
            .map_err(map_sql_error)?;
        return Ok(ReserveOutcome::Expired);
    }
    if let Some(existing) = load_reservation(transaction, request.save_session_id, deadline).await?
    {
        if existing.storage_scope_id != request.storage_scope_id.to_string()
            || existing.reserved_bytes != request.requested_bytes
        {
            return Err(QuotaServiceError::ReservationConflict);
        }
        let projection = load_projection(
            transaction,
            request.storage_scope_id,
            request.effective_quota,
            deadline,
        )
        .await?;
        return Ok(ReserveOutcome::Reserved(ReservationResult::new(
            request.save_session_id,
            request.requested_bytes,
            existing.expires_at,
            projection,
            true,
        )));
    }

    let before = load_projection(
        transaction,
        request.storage_scope_id,
        request.effective_quota,
        deadline,
    )
    .await?;
    let committed = before
        .used_bytes()
        .checked_add(before.reserved_bytes())
        .and_then(|value| value.checked_add(request.requested_bytes))
        .ok_or(QuotaServiceError::ArithmeticOverflow)?;
    if request
        .effective_quota
        .limit_bytes()
        .is_some_and(|limit| committed > limit)
    {
        return Err(QuotaServiceError::QuotaExceeded);
    }
    deadline
        .run(
            sqlx::query(
                "INSERT INTO storage_reservations \
                 (save_session_id, storage_scope_id, reserved_bytes, expires_at) \
                 VALUES ($1::uuid, $2::uuid, $3, $4)",
            )
            .bind(request.save_session_id.to_string())
            .bind(request.storage_scope_id.to_string())
            .bind(
                i64::try_from(request.requested_bytes)
                    .map_err(|_| QuotaServiceError::ArithmeticOverflow)?,
            )
            .bind(session.expires_at)
            .execute(&mut **transaction),
        )
        .await?
        .map_err(map_sql_error)?;
    let projection = QuotaProjection::new(
        request.storage_scope_id,
        before.used_bytes(),
        before
            .reserved_bytes()
            .checked_add(request.requested_bytes)
            .ok_or(QuotaServiceError::ArithmeticOverflow)?,
        request.effective_quota,
    )?;
    Ok(ReserveOutcome::Reserved(ReservationResult::new(
        request.save_session_id,
        request.requested_bytes,
        session.expires_at,
        projection,
        false,
    )))
}

async fn release_expired_in_transaction(
    transaction: &mut Transaction<'_, Postgres>,
    storage_scope_id: StorageScopeId,
    deadline: OperationDeadline,
) -> Result<u64, QuotaServiceError> {
    // Lock the bounded batch's Project rows before Save rows. This preserves the
    // scope -> Project -> Save order required by Project deletion and the
    // SAVE-001 terminal transition trigger. Repeated calls drain larger queues.
    deadline
        .run(
            sqlx::query(
                "SELECT project.id FROM projects project \
                 WHERE project.id IN ( \
                    SELECT batch.project_id FROM ( \
                        SELECT session.project_id FROM save_sessions session \
                        WHERE session.storage_scope_id = $1::uuid \
                          AND session.state IN ('created', 'uploading', 'verifying') \
                          AND session.expires_at <= transaction_timestamp() \
                        ORDER BY session.id LIMIT $2 \
                    ) batch \
                 ) ORDER BY project.id FOR UPDATE",
            )
            .bind(storage_scope_id.to_string())
            .bind(EXPIRY_SWEEP_BATCH_SIZE)
            .fetch_all(&mut **transaction),
        )
        .await?
        .map_err(map_sql_error)?;
    let result = deadline
        .run(
            sqlx::query(
                "UPDATE save_sessions SET state = 'expired', \
                 terminal_at = transaction_timestamp(), updated_at = transaction_timestamp() \
                 WHERE id IN ( \
                    SELECT session.id FROM save_sessions session \
                    WHERE session.storage_scope_id = $1::uuid \
                      AND session.state IN ('created', 'uploading', 'verifying') \
                      AND session.expires_at <= transaction_timestamp() \
                    ORDER BY session.id LIMIT $2 \
                 )",
            )
            .bind(storage_scope_id.to_string())
            .bind(EXPIRY_SWEEP_BATCH_SIZE)
            .execute(&mut **transaction),
        )
        .await?
        .map_err(map_sql_error)?;
    Ok(result.rows_affected())
}

struct SessionRow {
    state: String,
    expires_at: OffsetDateTime,
    expired: bool,
}

async fn lock_scope(
    transaction: &mut Transaction<'_, Postgres>,
    storage_scope_id: StorageScopeId,
    deadline: OperationDeadline,
) -> Result<(), QuotaServiceError> {
    let found = deadline
        .run(QuotaRepository::lock_storage_scope(
            transaction,
            storage_scope_id,
        ))
        .await?
        .map_err(map_sql_error)?;
    if found {
        Ok(())
    } else {
        Err(QuotaServiceError::ScopeNotFound)
    }
}

async fn live_quota(
    transaction: &mut Transaction<'_, Postgres>,
    storage_scope_id: StorageScopeId,
    fallback: EffectiveQuota,
    deadline: OperationDeadline,
) -> Result<EffectiveQuota, QuotaServiceError> {
    let organization: bool = deadline
        .run(
            sqlx::query_scalar(
                "SELECT owner_organization_id IS NOT NULL FROM storage_scopes WHERE id=$1::uuid",
            )
            .bind(storage_scope_id.to_string())
            .fetch_optional(&mut **transaction),
        )
        .await?
        .map_err(map_sql_error)?
        .ok_or(QuotaServiceError::ScopeNotFound)?;
    deadline
        .run(EffectivePolicyEngine::load_optional_in_transaction(
            transaction,
        ))
        .await?
        .and_then(|snapshot| {
            snapshot.map_or(Ok(fallback), |snapshot| {
                snapshot.workspace_quota(organization)
            })
        })
        .map_err(|_| QuotaServiceError::InvariantViolation)
}

async fn lock_project(
    transaction: &mut Transaction<'_, Postgres>,
    storage_scope_id: StorageScopeId,
    project_id: ProjectId,
    deadline: OperationDeadline,
) -> Result<(), QuotaServiceError> {
    let scope = deadline
        .run(QuotaRepository::lock_project_scope(transaction, project_id))
        .await?
        .map_err(map_sql_error)?;
    match scope {
        None => Err(QuotaServiceError::ProjectNotFound),
        Some(scope) if scope != storage_scope_id.to_string() => Err(QuotaServiceError::WrongScope),
        Some(_) => Ok(()),
    }
}

async fn load_session(
    transaction: &mut Transaction<'_, Postgres>,
    storage_scope_id: StorageScopeId,
    project_id: ProjectId,
    save_session_id: SaveSessionId,
    deadline: OperationDeadline,
) -> Result<SessionRow, QuotaServiceError> {
    let row: Option<(String, String, String, OffsetDateTime, bool)> = deadline
        .run(
            sqlx::query_as(
                "SELECT project_id::text, storage_scope_id::text, state, expires_at, \
                        expires_at <= transaction_timestamp() \
                 FROM save_sessions WHERE id = $1::uuid FOR UPDATE",
            )
            .bind(save_session_id.to_string())
            .fetch_optional(&mut **transaction),
        )
        .await?
        .map_err(map_sql_error)?;
    match row {
        None => Err(QuotaServiceError::SessionNotFound),
        Some((session_project, session_scope, _, _, _))
            if session_project != project_id.to_string()
                || session_scope != storage_scope_id.to_string() =>
        {
            Err(QuotaServiceError::WrongScope)
        }
        Some((_, _, state, expires_at, expired)) => Ok(SessionRow {
            state,
            expires_at,
            expired,
        }),
    }
}

struct ReservationRow {
    storage_scope_id: String,
    reserved_bytes: u64,
    expires_at: OffsetDateTime,
}

async fn load_reservation(
    transaction: &mut Transaction<'_, Postgres>,
    save_session_id: SaveSessionId,
    deadline: OperationDeadline,
) -> Result<Option<ReservationRow>, QuotaServiceError> {
    let row: Option<(String, i64, OffsetDateTime)> = deadline
        .run(
            sqlx::query_as(
                "SELECT storage_scope_id::text, reserved_bytes, expires_at \
                 FROM storage_reservations WHERE save_session_id = $1::uuid",
            )
            .bind(save_session_id.to_string())
            .fetch_optional(&mut **transaction),
        )
        .await?
        .map_err(map_sql_error)?;
    row.map(|(storage_scope_id, reserved_bytes, expires_at)| {
        Ok(ReservationRow {
            storage_scope_id,
            reserved_bytes: u64::try_from(reserved_bytes)
                .map_err(|_| QuotaServiceError::InvariantViolation)?,
            expires_at,
        })
    })
    .transpose()
}

async fn load_projection(
    transaction: &mut Transaction<'_, Postgres>,
    storage_scope_id: StorageScopeId,
    effective_quota: EffectiveQuota,
    deadline: OperationDeadline,
) -> Result<QuotaProjection, QuotaServiceError> {
    let (used, reserved): (String, String) = deadline
        .run(
            sqlx::query_as(
                "WITH live_bundles AS ( \
                    SELECT project.storage_scope_id, project.working_head_bundle_id AS bundle_id \
                    FROM projects project \
                    WHERE project.storage_scope_id = $1::uuid \
                      AND project.working_head_bundle_id IS NOT NULL \
                    UNION \
                    SELECT reference.storage_scope_id, reference.bundle_id \
                    FROM project_bundle_refs reference \
                    WHERE reference.storage_scope_id = $1::uuid \
                 ), used AS ( \
                    SELECT COALESCE(SUM(bundle.physical_bytes), 0)::text AS bytes \
                    FROM live_bundles live JOIN bundles bundle ON bundle.id = live.bundle_id \
                 ), reserved AS ( \
                    SELECT COALESCE(SUM(reservation.reserved_bytes), 0)::text AS bytes \
                    FROM storage_reservations reservation \
                    JOIN save_sessions session ON session.id = reservation.save_session_id \
                    WHERE reservation.storage_scope_id = $1::uuid \
                      AND reservation.expires_at > transaction_timestamp() \
                      AND session.state IN ('created', 'uploading', 'verifying') \
                 ) SELECT used.bytes, reserved.bytes FROM used CROSS JOIN reserved",
            )
            .bind(storage_scope_id.to_string())
            .fetch_one(&mut **transaction),
        )
        .await?
        .map_err(map_sql_error)?;
    QuotaProjection::new(
        storage_scope_id,
        parse_usage(&used)?,
        parse_usage(&reserved)?,
        effective_quota,
    )
}

fn parse_usage(value: &str) -> Result<u64, QuotaServiceError> {
    value
        .parse::<u64>()
        .map_err(|_| QuotaServiceError::ArithmeticOverflow)
}

async fn configure_transaction(
    transaction: &mut Transaction<'_, Postgres>,
    deadline: OperationDeadline,
) -> Result<(), QuotaServiceError> {
    let sql_timeout = deadline
        .remaining()?
        .saturating_sub(SQL_TIMEOUT_MARGIN)
        .max(Duration::from_millis(1));
    let milliseconds = sql_timeout.as_millis().min(i64::MAX as u128).to_string();
    deadline
        .run(
            sqlx::query(
                "SELECT set_config('lock_timeout', $1, true), \
                        set_config('statement_timeout', $1, true)",
            )
            .bind(format!("{milliseconds}ms"))
            .execute(&mut **transaction),
        )
        .await?
        .map_err(map_sql_error)?;
    Ok(())
}

async fn commit(
    transaction: Transaction<'_, Postgres>,
    deadline: OperationDeadline,
) -> Result<(), QuotaServiceError> {
    match tokio_time::timeout_at(deadline.0, transaction.commit()).await {
        Ok(Ok(())) => Ok(()),
        Ok(Err(error)) => Err(map_commit_error(error)),
        Err(_) => Err(QuotaServiceError::CommitOutcomeUnknown),
    }
}

fn is_terminal(state: &str) -> bool {
    matches!(state, "committed" | "aborted" | "expired" | "failed")
}

fn map_database_error(error: DatabaseError) -> QuotaServiceError {
    match error {
        DatabaseError::AcquireTimeout => QuotaServiceError::OperationTimeout,
        _ => QuotaServiceError::DatabaseUnavailable,
    }
}

fn map_sql_error(error: sqlx::Error) -> QuotaServiceError {
    match error
        .as_database_error()
        .and_then(|error| error.code())
        .as_deref()
    {
        Some("57014" | "55P03") => QuotaServiceError::OperationTimeout,
        Some("23505") => QuotaServiceError::ReservationConflict,
        Some("23503" | "23514") => QuotaServiceError::InvariantViolation,
        _ => QuotaServiceError::DatabaseUnavailable,
    }
}

pub(super) fn map_commit_error(error: sqlx::Error) -> QuotaServiceError {
    if error.as_database_error().is_none() {
        QuotaServiceError::CommitOutcomeUnknown
    } else {
        map_sql_error(error)
    }
}
