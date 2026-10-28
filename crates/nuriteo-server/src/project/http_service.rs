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


use super::{
    DirectProjectRoleGrant, Project, ProjectAuditContext, ProjectDeleteConfirmation, ProjectId,
    ProjectName, ProjectOwner, ProjectPageKey, ProjectPageLimit, ProjectRepository, ProjectRole,
    ProjectRoleMutationResult, ProjectRolePageKey, ProjectRolePageLimit, ProjectService,
    ProjectServiceError, ProjectServicePolicy, ProjectSlug, ProjectState, ProjectTemplate,
    ProjectVersion,
};


const CURSOR_PREFIX: &str = "nrt_project_cursor_";

const CURSOR_TTL_SECONDS: i64 = 15 * 60;

const CURSOR_KEY_BYTES: usize = 32;

const MAX_CURSOR_BYTES: usize = 2048;


#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub struct ProjectHttpPolicy {
    operation_timeout: Duration,
}


#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum ProjectHttpError {
    AuthenticationFailed,
    Forbidden,
    NotFound,
    InvalidInput,
    Conflict,
    PreconditionFailed,
    ConfirmationRequired,
    AuditUnavailable,
    Unavailable,
    RateLimited,
    OperationTimeout,
    CommitOutcomeUnknown,
    Internal,
}


#[derive(Clone)]
pub struct ProjectHttpService {
    runtime: Option<Arc<Runtime>>,
}


struct Runtime {
    pool: DatabasePool,
    operation_timeout: Duration,
    sessions: SessionService,
    cookies: BrowserCookieBoundary,
    projects: ProjectService,
    access_tokens: AccessTokenAuthenticator,
    cursor: CursorSigner,
    content: Option<ContentService>,
    versions: ProjectVersionService,
    history: ProjectHistoryService,
}


#[derive(Debug, Clone, Copy)]
pub(crate) enum RoleOperation {
    Grant,
    Change,
    Revoke,
}


#[derive(Debug, Clone, Copy)]
pub(crate) struct SaveProjectContext {
    pub(crate) actor_user_id: UserId,
    pub(crate) project_id: ProjectId,
    pub(crate) storage_scope_id: crate::workspace::StorageScopeId,
    pub(crate) project_version: ProjectVersion,
}


struct BrowserIdentity {
    user_id: UserId,
    display_name: String,
}


pub(crate) enum ProjectAccessTokenIdentity {
    User {
        user_id: UserId,
        display_name: String,
    },
    Project {
        bound_project_id: ProjectId,
    },
}


#[derive(Debug, Clone, Serialize, ToSchema)]
#[serde(rename_all = "camelCase")]
pub(crate) struct ProjectView {
    pub(crate) id: String,
    pub(crate) owner_type: &'static str,
    pub(crate) owner_id: String,
    pub(crate) storage_scope_id: String,
    pub(crate) slug: String,
    pub(crate) name: String,
    pub(crate) template_id: &'static str,
    pub(crate) state: &'static str,
    pub(crate) created_at: String,
    pub(crate) updated_at: String,
    pub(crate) archived_at: Option<String>,
    pub(crate) version: i64,
}


#[derive(Debug, Clone, Serialize, ToSchema)]
#[serde(rename_all = "camelCase")]
pub(crate) struct ProjectListView {
    pub(crate) items: Vec<ProjectView>,
    pub(crate) next_cursor: Option<String>,
}


#[derive(Debug, Clone, Serialize, ToSchema)]
#[serde(rename_all = "camelCase")]
pub(crate) struct ProjectRoleView {
    project_id: String,
    organization_id: String,
    user_id: String,
    role: ProjectRole,
    created_at: String,
    updated_at: String,
    version: i64,
}


#[derive(Debug, Clone, Serialize, ToSchema)]
#[serde(rename_all = "camelCase")]
pub(crate) struct ProjectRoleListView {
    pub(crate) items: Vec<ProjectRoleView>,
    pub(crate) next_cursor: Option<String>,
}


#[derive(Debug, Clone, Serialize, ToSchema)]
#[serde(rename_all = "camelCase")]
pub(crate) struct ProjectRoleMutationView {
    pub(crate) changed: bool,
    pub(crate) grant: Option<ProjectRoleView>,
    pub(crate) project_version: i64,
}


#[derive(Debug, Clone, Serialize, ToSchema)]
#[serde(rename_all = "camelCase")]
pub(crate) struct ProjectVersionView {
    id: String,
    project_id: String,
    bundle_id: String,
    name: String,
    created_by_user_id: String,
    source_project_version: i64,
    created_at: String,
    sha256: String,
    physical_bytes: u64,
    logical_bytes: u64,
    file_count: u32,
    format: String,
}


#[derive(Debug, Clone, Serialize, ToSchema)]
#[serde(rename_all = "camelCase")]
pub(crate) struct ProjectVersionCreateView {
    pub(crate) version: ProjectVersionView,
    pub(crate) idempotent_retry: bool,
}


#[derive(Debug, Clone, Serialize, ToSchema)]
#[serde(rename_all = "camelCase")]
pub(crate) struct ProjectVersionListView {
    pub(crate) items: Vec<ProjectVersionView>,
    pub(crate) next_cursor: Option<String>,
}


#[derive(Debug, Clone, Serialize, ToSchema)]
#[serde(rename_all = "camelCase")]
pub(crate) struct RecoveryCheckpointView {
    id: String,
    project_id: String,
    bundle_id: String,
    position: u8,
    created_by_user_id: String,
    created_at: String,
    sha256: String,
    physical_bytes: u64,
    logical_bytes: u64,
    file_count: u32,
    format: String,
}


#[derive(Debug, Clone, Serialize, ToSchema)]
#[serde(rename_all = "camelCase")]
pub(crate) struct RecoveryCheckpointListView {
    pub(crate) items: Vec<RecoveryCheckpointView>,
}


#[derive(Debug, Clone, Serialize, ToSchema)]
#[serde(rename_all = "camelCase")]
pub(crate) struct HistoricalPromotionView {
    operation_id: String,
    reference_kind: String,
    reference_id: String,
    bundle_id: String,
    pub(crate) project_version: i64,
    changed: bool,
    idempotent_retry: bool,
}


#[derive(Clone)]
struct CursorSigner {
    key: [u8; CURSOR_KEY_BYTES],
}


#[derive(Debug, Serialize, Deserialize)]
struct CursorClaims {
    version: u8,
    kind: String,
    actor_id: String,
    owner_type: String,
    owner_id: String,
    project_id: Option<String>,
    state: String,
    page_size: u16,
    expires_at: i64,
    after_slug: Option<String>,
    after_project_id: Option<String>,
    after_user_id: Option<String>,
    after_version_created_at: Option<i128>,
    after_version_id: Option<String>,
}


struct CursorBinding {
    kind: &'static str,
    actor_id: String,
    owner_type: &'static str,
    owner_id: String,
    project_id: Option<String>,
    state: &'static str,
    page_size: u16,
}


enum CursorPosition {
    Project { slug: String, id: String },
    Role { user_id: String },
    Version { created_at: i128, id: String },
}


#[cfg(test)]
mod tests {
    use super::*;
    #[test]
    fn cursor_is_authenticated_expiring_and_bound() {
        let signer = CursorSigner::new([7; 32]);
        let actor: UserId = "0199ee6c-c777-7000-8000-000000000001".parse().unwrap();
        let owner = ProjectOwner::User(actor);
        let project: ProjectId = "0199ee6c-c777-7000-8000-000000000002".parse().unwrap();
        let key = ProjectPageKey::new("alpha".parse().unwrap(), project);
        let binding = CursorBinding::projects(actor, owner, Some(ProjectState::Active), 50);
        let now = OffsetDateTime::from_unix_timestamp(2_000_000_000).unwrap();
        let encoded = signer.encode_project(&key, &binding, now).unwrap();
        assert_eq!(signer.decode_project(&encoded, &binding, now).unwrap(), key);
        let mut tampered = encoded.into_bytes();
        let last = tampered.len() - 1;
        tampered[last] = if tampered[last] == b'A' { b'B' } else { b'A' };
        assert!(
            signer
                .decode_project(std::str::from_utf8(&tampered).unwrap(), &binding, now)
                .is_err()
        );
        let encoded = signer.encode_project(&key, &binding, now).unwrap();
        assert!(
            signer
                .decode_project(&encoded, &binding, now + time::Duration::minutes(15))
                .is_err()
        );
        let wrong = CursorBinding::projects(actor, owner, Some(ProjectState::Archived), 50);
        assert!(signer.decode_project(&encoded, &wrong, now).is_err());
        let wrong = CursorBinding::projects(actor, owner, Some(ProjectState::Active), 100);
        assert!(signer.decode_project(&encoded, &wrong, now).is_err());
    }
}


mod project_api;
pub(crate) use project_api::*;
mod response_cursors;
pub(crate) use response_cursors::*;
