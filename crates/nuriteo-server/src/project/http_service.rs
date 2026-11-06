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

pub(crate) struct Runtime {
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

pub(crate) struct BrowserIdentity {
    user_id: UserId,
    display_name: String,
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

mod history;
mod lifecycle;
mod project_api;
mod response_cursors;
mod roles;

pub(crate) use history::{
    HistoricalPromotionView, ProjectVersionCreateView, ProjectVersionListView, ProjectVersionView,
    RecoveryCheckpointListView, RecoveryCheckpointView, SaveProjectContext,
};
pub(crate) use lifecycle::{ProjectAccessTokenIdentity, ProjectListView, ProjectView};
pub(crate) use project_api::*;
pub(crate) use response_cursors::*;
pub(crate) use roles::{
    ProjectRoleListView, ProjectRoleMutationView, ProjectRoleView, RoleOperation,
};
