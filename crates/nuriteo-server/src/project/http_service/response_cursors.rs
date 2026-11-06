#![allow(unused_imports)]
use super::project_api::*;
use super::*;
use std::fmt;

use std::sync::Arc;

use std::time::Duration;

use base64::Engine;

use base64::engine::general_purpose::URL_SAFE_NO_PAD;

use hmac::{Hmac, KeyInit, Mac};

use serde::{Deserialize, Serialize};

use sha2::Sha256;

use sqlx::{Acquire, Postgres, Transaction};

use subtle::ConstantTimeEq;

use time::OffsetDateTime;

use tokio::time as tokio_time;

use url::Url;

use utoipa::ToSchema;

use crate::access_token::{
    AccessTokenAuthenticator, AccessTokenPrincipal, AccessTokenRequest, AccessTokenScope,
    AccessTokenServiceError, ApiCategory,
};

use crate::audit::AuditEventId;

use crate::database::DatabasePool;

use crate::identity::{
    BrowserCookieBoundary, BrowserCookieError, BrowserRequestHeaders, SessionPolicy,
    SessionService, SessionServiceError, UserId,
};

use crate::object_storage::S3ObjectStore;

use crate::project::ProjectAccessError;

use crate::project::{EffectiveProjectRole, ProjectAccessRepository};

use crate::save::{
    ContentDescriptor, ContentDownload, ContentError, ContentService, ContentServicePolicy,
    CreateProjectVersion, ExplicitProjectVersion, HistoricalPromotionOutcome,
    HistoricalReferenceKind, ProjectHistoryError, ProjectHistoryService,
    ProjectHistoryServicePolicy, ProjectVersionError, ProjectVersionName, ProjectVersionPageKey,
    ProjectVersionPageLimit, ProjectVersionService, ProjectVersionServicePolicy,
    PromoteHistoricalReference, RecoveryCheckpoint,
};

use super::super::{
    DirectProjectRoleGrant, Project, ProjectAuditContext, ProjectDeleteConfirmation, ProjectId,
    ProjectName, ProjectOwner, ProjectPageKey, ProjectPageLimit, ProjectRepository, ProjectRole,
    ProjectRoleMutationResult, ProjectRolePageKey, ProjectRolePageLimit, ProjectService,
    ProjectServiceError, ProjectServicePolicy, ProjectSlug, ProjectState, ProjectTemplate,
    ProjectVersion,
};
use super::{
    BrowserIdentity, CURSOR_KEY_BYTES, CURSOR_PREFIX, CURSOR_TTL_SECONDS, CursorBinding,
    CursorClaims, CursorPosition, CursorSigner, MAX_CURSOR_BYTES, ProjectHttpError,
    ProjectHttpPolicy, ProjectHttpService, Runtime,
};

impl super::BrowserIdentity {
    pub(crate) fn audit(&self, correlation_id: &str) -> ProjectAuditContext {
        ProjectAuditContext::new(
            AuditEventId::new(),
            self.user_id,
            Some(self.display_name.clone()),
            correlation_id.to_owned(),
            None,
        )
    }
}

impl Runtime {
    pub(crate) async fn authenticate(
        &self,
        request: BrowserRequestHeaders<'_>,
    ) -> Result<BrowserIdentity, ProjectHttpError> {
        let token = self
            .cookies
            .validate(request)
            .map_err(map_browser_error)?
            .into_session_token();
        let fields = self
            .sessions
            .authenticate(&token)
            .await
            .map_err(map_session_error)?
            .into_fields();
        let mut connection = self
            .pool
            .acquire()
            .await
            .map_err(|_| ProjectHttpError::Unavailable)?;
        let row: Option<(String, String)> =
            sqlx::query_as("SELECT display_name,status FROM users WHERE id=$1::uuid")
                .bind(fields.user_id.to_string())
                .fetch_optional(&mut *connection)
                .await
                .map_err(|_| ProjectHttpError::Unavailable)?;
        let (display_name, status) = row.ok_or(ProjectHttpError::AuthenticationFailed)?;
        if status != "active" {
            return Err(ProjectHttpError::AuthenticationFailed);
        }
        Ok(BrowserIdentity {
            user_id: fields.user_id,
            display_name,
        })
    }
}

impl CursorBinding {
    pub(crate) fn projects(
        actor: UserId,
        owner: ProjectOwner,
        state: Option<ProjectState>,
        page_size: u16,
    ) -> Self {
        let (owner_type, owner_id) = owner_parts(owner);
        Self {
            kind: "projects",
            actor_id: actor.to_string(),
            owner_type,
            owner_id,
            project_id: None,
            state: match state {
                Some(ProjectState::Active) => "active",
                Some(ProjectState::Archived) => "archived",
                None => "all",
            },
            page_size,
        }
    }
    pub(crate) fn roles(
        actor: UserId,
        owner: ProjectOwner,
        project: ProjectId,
        page_size: u16,
    ) -> Self {
        let (owner_type, owner_id) = owner_parts(owner);
        Self {
            kind: "roles",
            actor_id: actor.to_string(),
            owner_type,
            owner_id,
            project_id: Some(project.to_string()),
            state: "roles",
            page_size,
        }
    }
    pub(crate) fn versions(
        actor: UserId,
        owner: ProjectOwner,
        project: ProjectId,
        page_size: u16,
    ) -> Self {
        let (owner_type, owner_id) = owner_parts(owner);
        Self {
            kind: "versions",
            actor_id: actor.to_string(),
            owner_type,
            owner_id,
            project_id: Some(project.to_string()),
            state: "versions",
            page_size,
        }
    }
}

pub(crate) fn owner_parts(owner: ProjectOwner) -> (&'static str, String) {
    match owner {
        ProjectOwner::User(id) => ("user", id.to_string()),
        ProjectOwner::Organization(id) => ("organization", id.to_string()),
    }
}

impl CursorSigner {
    pub(crate) const fn new(key: [u8; CURSOR_KEY_BYTES]) -> Self {
        Self { key }
    }

    pub(crate) fn encode_project(
        &self,
        key: &ProjectPageKey,
        binding: &CursorBinding,
        now: OffsetDateTime,
    ) -> Result<String, ProjectHttpError> {
        self.encode(
            binding,
            now,
            CursorPosition::Project {
                slug: key.slug().to_string(),
                id: key.id().to_string(),
            },
        )
    }
    pub(crate) fn encode_role(
        &self,
        key: ProjectRolePageKey,
        binding: &CursorBinding,
        now: OffsetDateTime,
    ) -> Result<String, ProjectHttpError> {
        self.encode(
            binding,
            now,
            CursorPosition::Role {
                user_id: key.user_id().to_string(),
            },
        )
    }
    pub(crate) fn encode_version(
        &self,
        key: ProjectVersionPageKey,
        binding: &CursorBinding,
        now: OffsetDateTime,
    ) -> Result<String, ProjectHttpError> {
        self.encode(
            binding,
            now,
            CursorPosition::Version {
                created_at: key.created_at().unix_timestamp_nanos(),
                id: key.id().to_string(),
            },
        )
    }
    pub(crate) fn encode(
        &self,
        binding: &CursorBinding,
        now: OffsetDateTime,
        position: CursorPosition,
    ) -> Result<String, ProjectHttpError> {
        let (
            after_slug,
            after_project_id,
            after_user_id,
            after_version_created_at,
            after_version_id,
        ) = match position {
            CursorPosition::Project { slug, id } => (Some(slug), Some(id), None, None, None),
            CursorPosition::Role { user_id } => (None, None, Some(user_id), None, None),
            CursorPosition::Version { created_at, id } => {
                (None, None, None, Some(created_at), Some(id))
            }
        };
        let claims = CursorClaims {
            version: 1,
            kind: binding.kind.into(),
            actor_id: binding.actor_id.clone(),
            owner_type: binding.owner_type.into(),
            owner_id: binding.owner_id.clone(),
            project_id: binding.project_id.clone(),
            state: binding.state.into(),
            page_size: binding.page_size,
            expires_at: now.unix_timestamp() + CURSOR_TTL_SECONDS,
            after_slug,
            after_project_id,
            after_user_id,
            after_version_created_at,
            after_version_id,
        };
        let payload = serde_json::to_vec(&claims).map_err(|_| ProjectHttpError::Internal)?;
        let signature = hmac_sha256(&self.key, &payload);
        Ok(format!(
            "{CURSOR_PREFIX}{}.{}",
            URL_SAFE_NO_PAD.encode(payload),
            URL_SAFE_NO_PAD.encode(signature)
        ))
    }
    pub(crate) fn decode_project(
        &self,
        value: &str,
        binding: &CursorBinding,
        now: OffsetDateTime,
    ) -> Result<ProjectPageKey, ProjectHttpError> {
        let claims = self.decode(value, binding, now)?;
        match (
            claims.after_slug,
            claims.after_project_id,
            claims.after_user_id,
        ) {
            (Some(slug), Some(id), None) => Ok(ProjectPageKey::new(
                slug.parse().map_err(|_| ProjectHttpError::InvalidInput)?,
                id.parse().map_err(|_| ProjectHttpError::InvalidInput)?,
            )),
            _ => Err(ProjectHttpError::InvalidInput),
        }
    }
    pub(crate) fn decode_role(
        &self,
        value: &str,
        binding: &CursorBinding,
        now: OffsetDateTime,
    ) -> Result<ProjectRolePageKey, ProjectHttpError> {
        let claims = self.decode(value, binding, now)?;
        match (
            claims.after_slug,
            claims.after_project_id,
            claims.after_user_id,
        ) {
            (None, None, Some(id)) => Ok(ProjectRolePageKey::new(
                id.parse().map_err(|_| ProjectHttpError::InvalidInput)?,
            )),
            _ => Err(ProjectHttpError::InvalidInput),
        }
    }
    pub(crate) fn decode_version(
        &self,
        value: &str,
        binding: &CursorBinding,
        now: OffsetDateTime,
    ) -> Result<ProjectVersionPageKey, ProjectHttpError> {
        let claims = self.decode(value, binding, now)?;
        match (
            claims.after_slug,
            claims.after_project_id,
            claims.after_user_id,
            claims.after_version_created_at,
            claims.after_version_id,
        ) {
            (None, None, None, Some(created_at), Some(id)) => Ok(ProjectVersionPageKey::new(
                OffsetDateTime::from_unix_timestamp_nanos(created_at)
                    .map_err(|_| ProjectHttpError::InvalidInput)?,
                id.parse().map_err(|_| ProjectHttpError::InvalidInput)?,
            )),
            _ => Err(ProjectHttpError::InvalidInput),
        }
    }
    pub(crate) fn decode(
        &self,
        value: &str,
        binding: &CursorBinding,
        now: OffsetDateTime,
    ) -> Result<CursorClaims, ProjectHttpError> {
        if value.len() > MAX_CURSOR_BYTES {
            return Err(ProjectHttpError::InvalidInput);
        }
        let encoded = value
            .strip_prefix(CURSOR_PREFIX)
            .ok_or(ProjectHttpError::InvalidInput)?;
        let (payload, signature) = encoded
            .split_once('.')
            .ok_or(ProjectHttpError::InvalidInput)?;
        if signature.contains('.') {
            return Err(ProjectHttpError::InvalidInput);
        }
        let payload = URL_SAFE_NO_PAD
            .decode(payload)
            .map_err(|_| ProjectHttpError::InvalidInput)?;
        let signature = URL_SAFE_NO_PAD
            .decode(signature)
            .map_err(|_| ProjectHttpError::InvalidInput)?;
        let expected = hmac_sha256(&self.key, &payload);
        if signature.len() != expected.len() || !bool::from(signature.ct_eq(expected.as_slice())) {
            return Err(ProjectHttpError::InvalidInput);
        }
        let claims: CursorClaims =
            serde_json::from_slice(&payload).map_err(|_| ProjectHttpError::InvalidInput)?;
        if claims.version != 1
            || claims.expires_at <= now.unix_timestamp()
            || claims.kind != binding.kind
            || claims.actor_id != binding.actor_id
            || claims.owner_type != binding.owner_type
            || claims.owner_id != binding.owner_id
            || claims.project_id != binding.project_id
            || claims.state != binding.state
            || claims.page_size != binding.page_size
        {
            return Err(ProjectHttpError::InvalidInput);
        }
        Ok(claims)
    }
}

pub(crate) fn hmac_sha256(key: &[u8], message: &[u8]) -> [u8; 32] {
    let mut mac = Hmac::<Sha256>::new_from_slice(key)
        .expect("HMAC-SHA256 accepts a key of any bounded length");
    mac.update(message);
    mac.finalize().into_bytes().into()
}

pub(crate) fn hex_lower(bytes: &[u8]) -> String {
    use std::fmt::Write as _;

    let mut output = String::with_capacity(bytes.len() * 2);
    for byte in bytes {
        let _ = write!(output, "{byte:02x}");
    }
    output
}

pub(crate) async fn configure_save_authorization_deadline(
    transaction: &mut Transaction<'_, Postgres>,
    operation_timeout: Duration,
) -> Result<(), ProjectHttpError> {
    let millis = operation_timeout
        .saturating_sub(Duration::from_millis(25))
        .max(Duration::from_millis(1))
        .as_millis()
        .min(i32::MAX as u128);
    sqlx::query(
        "SELECT set_config('statement_timeout', $1, true), \
                set_config('lock_timeout', $1, true)",
    )
    .bind(format!("{millis}ms"))
    .execute(&mut **transaction)
    .await
    .map_err(map_save_authorization_query)?;
    Ok(())
}

pub(crate) fn map_save_authorization_query(error: sqlx::Error) -> ProjectHttpError {
    if error
        .as_database_error()
        .and_then(sqlx::error::DatabaseError::code)
        .is_some_and(|code| matches!(code.as_ref(), "57014" | "55P03"))
    {
        ProjectHttpError::OperationTimeout
    } else {
        ProjectHttpError::Unavailable
    }
}

pub(crate) fn map_version_error(error: ProjectVersionError) -> ProjectHttpError {
    match error {
        ProjectVersionError::InvalidInput => ProjectHttpError::InvalidInput,
        ProjectVersionError::NotFound => ProjectHttpError::NotFound,
        ProjectVersionError::Forbidden => ProjectHttpError::Forbidden,
        ProjectVersionError::ProjectUnavailable
        | ProjectVersionError::WorkingHeadUnavailable
        | ProjectVersionError::IdempotencyConflict
        | ProjectVersionError::NameConflict => ProjectHttpError::Conflict,
        ProjectVersionError::StaleProjectVersion => ProjectHttpError::PreconditionFailed,
        ProjectVersionError::OperationTimeout => ProjectHttpError::OperationTimeout,
        ProjectVersionError::DatabaseUnavailable => ProjectHttpError::Unavailable,
        ProjectVersionError::CommitOutcomeUnknown => ProjectHttpError::CommitOutcomeUnknown,
        ProjectVersionError::InvariantViolation => ProjectHttpError::Internal,
    }
}

pub(crate) fn map_history_error(error: ProjectHistoryError) -> ProjectHttpError {
    match error {
        ProjectHistoryError::InvalidInput => ProjectHttpError::InvalidInput,
        ProjectHistoryError::NotFound => ProjectHttpError::NotFound,
        ProjectHistoryError::Forbidden => ProjectHttpError::Forbidden,
        ProjectHistoryError::ProjectUnavailable | ProjectHistoryError::IdempotencyConflict => {
            ProjectHttpError::Conflict
        }
        ProjectHistoryError::StaleProjectVersion => ProjectHttpError::PreconditionFailed,
        ProjectHistoryError::OperationTimeout => ProjectHttpError::OperationTimeout,
        ProjectHistoryError::DatabaseUnavailable => ProjectHttpError::Unavailable,
        ProjectHistoryError::AuditUnavailable => ProjectHttpError::AuditUnavailable,
        ProjectHistoryError::CommitOutcomeUnknown => ProjectHttpError::CommitOutcomeUnknown,
        ProjectHistoryError::InvariantViolation => ProjectHttpError::Internal,
    }
}

pub(crate) fn map_session_error(error: SessionServiceError) -> ProjectHttpError {
    match error {
        SessionServiceError::InvalidToken | SessionServiceError::UserUnavailable => {
            ProjectHttpError::AuthenticationFailed
        }
        SessionServiceError::DatabaseUnavailable => ProjectHttpError::Unavailable,
        SessionServiceError::OperationTimeout => ProjectHttpError::OperationTimeout,
        _ => ProjectHttpError::Internal,
    }
}

pub(crate) fn map_access_token_error(error: AccessTokenServiceError) -> ProjectHttpError {
    match error {
        AccessTokenServiceError::AuthenticationFailed => ProjectHttpError::AuthenticationFailed,
        AccessTokenServiceError::Forbidden => ProjectHttpError::Forbidden,
        AccessTokenServiceError::RateLimited => ProjectHttpError::RateLimited,
        AccessTokenServiceError::OperationTimeout => ProjectHttpError::OperationTimeout,
        AccessTokenServiceError::Unavailable => ProjectHttpError::Unavailable,
        AccessTokenServiceError::InvalidPersistedState => ProjectHttpError::Internal,
    }
}

pub(crate) fn map_browser_error(error: BrowserCookieError) -> ProjectHttpError {
    match error {
        BrowserCookieError::MissingSessionCookie | BrowserCookieError::InvalidSessionCookie => {
            ProjectHttpError::AuthenticationFailed
        }
        _ => ProjectHttpError::Forbidden,
    }
}

pub(crate) fn map_project_error(error: ProjectServiceError) -> ProjectHttpError {
    match error {
        ProjectServiceError::InvalidInput => ProjectHttpError::InvalidInput,
        ProjectServiceError::NotFound => ProjectHttpError::NotFound,
        ProjectServiceError::Unauthorized
        | ProjectServiceError::UserUnavailable
        | ProjectServiceError::MemberUnavailable => ProjectHttpError::Forbidden,
        ProjectServiceError::Archived
        | ProjectServiceError::InvalidLifecycle
        | ProjectServiceError::NamespaceUnavailable
        | ProjectServiceError::RoleAlreadyExists => ProjectHttpError::Conflict,
        ProjectServiceError::StaleVersion => ProjectHttpError::PreconditionFailed,
        ProjectServiceError::ConfirmationRequired => ProjectHttpError::ConfirmationRequired,
        ProjectServiceError::AuditUnavailable => ProjectHttpError::AuditUnavailable,
        ProjectServiceError::DatabaseUnavailable => ProjectHttpError::Unavailable,
        ProjectServiceError::OperationTimeout => ProjectHttpError::OperationTimeout,
        ProjectServiceError::CommitOutcomeUnknown => ProjectHttpError::CommitOutcomeUnknown,
        ProjectServiceError::InvariantViolation => ProjectHttpError::Internal,
    }
}

pub(crate) fn map_content_error(error: ContentError) -> ProjectHttpError {
    match error {
        ContentError::InvalidInput => ProjectHttpError::InvalidInput,
        // Read endpoints preserve the Project GET enumeration boundary: an
        // authenticated non-member cannot distinguish a private Project from
        // an absent one. Mutation authorization continues to use Forbidden.
        ContentError::Unauthorized => ProjectHttpError::NotFound,
        ContentError::NotFound | ContentError::NoWorkingHead => ProjectHttpError::NotFound,
        ContentError::ProjectUnavailable | ContentError::ObjectMismatch => {
            ProjectHttpError::Conflict
        }
        ContentError::StaleDescriptor => ProjectHttpError::PreconditionFailed,
        ContentError::ObjectUnavailable | ContentError::PersistenceUnavailable => {
            ProjectHttpError::Unavailable
        }
        ContentError::OperationTimeout => ProjectHttpError::OperationTimeout,
        ContentError::InvariantViolation => ProjectHttpError::Internal,
    }
}
