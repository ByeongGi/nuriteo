use std::{fmt, sync::Arc};

use serde::Serialize;
use url::Url;
use utoipa::ToSchema;

use crate::{
    database::DatabasePool,
    identity::{
        BrowserCookieBoundary, BrowserCookieError, BrowserRequestHeaders, SessionPolicy,
        SessionService, SessionServiceError, UserId,
    },
    project::{ProjectId, ProjectOwner},
    save::ProjectVersionId,
};

use super::{
    CreatePublishedExample, PublicPublishedExample, PublishedExample,
    PublishedExampleDeleteConfirmation, PublishedExampleError, PublishedExampleId,
    PublishedExampleName, PublishedExamplePublicId, PublishedExampleService,
    PublishedExampleServicePolicy, PublishedExampleState, PublishedExampleVersion,
    PublishedExampleVersionId, PublishedExampleVisibility,
};

const REAUTHENTICATION_WINDOW_SECONDS: i64 = 15 * 60;

#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub enum PublishedExampleHttpError {
    AuthenticationFailed,
    Forbidden,
    NotFound,
    InvalidInput,
    Conflict,
    PreconditionFailed,
    ConfirmationRequired,
    Unavailable,
    OperationTimeout,
    CommitOutcomeUnknown,
    Internal,
}

impl fmt::Display for PublishedExampleHttpError {
    fn fmt(&self, formatter: &mut fmt::Formatter<'_>) -> fmt::Result {
        formatter.write_str(match self {
            Self::AuthenticationFailed => "Published Example authentication failed",
            Self::Forbidden => "Published Example request is forbidden",
            Self::NotFound => "Published Example was not found",
            Self::InvalidInput => "Published Example request is invalid",
            Self::Conflict => "Published Example state conflicts with the request",
            Self::PreconditionFailed => "Published Example generation is stale",
            Self::ConfirmationRequired => "Published Example deletion confirmation is required",
            Self::Unavailable => "Published Example service is unavailable",
            Self::OperationTimeout => "Published Example operation timed out",
            Self::CommitOutcomeUnknown => "Published Example commit outcome is unknown",
            Self::Internal => "Published Example operation failed",
        })
    }
}

impl std::error::Error for PublishedExampleHttpError {}

#[derive(Clone)]
pub struct PublishedExampleHttpService {
    runtime: Option<Arc<Runtime>>,
}

struct Runtime {
    pool: DatabasePool,
    cookies: BrowserCookieBoundary,
    sessions: SessionService,
    examples: PublishedExampleService,
}

impl fmt::Debug for PublishedExampleHttpService {
    fn fmt(&self, formatter: &mut fmt::Formatter<'_>) -> fmt::Result {
        formatter
            .debug_struct("PublishedExampleHttpService")
            .field("configured", &self.runtime.is_some())
            .finish()
    }
}

impl PublishedExampleHttpService {
    #[must_use]
    pub const fn unconfigured() -> Self {
        Self { runtime: None }
    }

    pub fn production(
        pool: DatabasePool,
        external_url: &Url,
        service_policy: PublishedExampleServicePolicy,
        session_policy: SessionPolicy,
    ) -> Result<Self, PublishedExampleHttpError> {
        let cookies = BrowserCookieBoundary::new(external_url).map_err(map_browser_error)?;
        Ok(Self {
            runtime: Some(Arc::new(Runtime {
                examples: PublishedExampleService::new(pool.clone(), service_policy),
                sessions: SessionService::new(pool.clone(), session_policy),
                pool,
                cookies,
            })),
        })
    }

    pub(crate) async fn create(
        &self,
        request: BrowserRequestHeaders<'_>,
        owner: ProjectOwner,
        project_id: ProjectId,
        project_version_id: ProjectVersionId,
        name: PublishedExampleName,
        visibility: PublishedExampleVisibility,
    ) -> Result<PublishedExampleCreateView, PublishedExampleHttpError> {
        let runtime = self.runtime()?;
        let identity = runtime.authenticate(request).await?;
        runtime.require_project_path(owner, project_id).await?;
        let (example, version) = runtime
            .examples
            .create(CreatePublishedExample {
                actor_user_id: identity.user_id,
                project_id,
                project_version_id,
                name,
                visibility,
            })
            .await
            .map_err(map_domain_error)?;
        Ok(PublishedExampleCreateView {
            example: example.into(),
            version: version.into(),
        })
    }

    pub(crate) async fn add_version(
        &self,
        request: BrowserRequestHeaders<'_>,
        owner: ProjectOwner,
        project_id: ProjectId,
        example_id: PublishedExampleId,
        project_version_id: ProjectVersionId,
        expected_generation: i64,
    ) -> Result<PublishedExampleVersionMutationView, PublishedExampleHttpError> {
        let runtime = self.runtime()?;
        let identity = runtime.authenticate(request).await?;
        runtime
            .require_example_path(owner, project_id, example_id)
            .await?;
        let version = runtime
            .examples
            .add_version(
                identity.user_id,
                example_id,
                project_version_id,
                expected_generation,
            )
            .await
            .map_err(map_domain_error)?;
        Ok(PublishedExampleVersionMutationView {
            version: version.into(),
            generation: expected_generation
                .checked_add(1)
                .ok_or(PublishedExampleHttpError::Internal)?,
        })
    }

    #[allow(
        clippy::too_many_arguments,
        reason = "HTTP mutation keeps path and concurrency fences explicit"
    )]
    pub(crate) async fn select_active_version(
        &self,
        request: BrowserRequestHeaders<'_>,
        owner: ProjectOwner,
        project_id: ProjectId,
        example_id: PublishedExampleId,
        version_id: PublishedExampleVersionId,
        expected_generation: i64,
    ) -> Result<PublishedExampleView, PublishedExampleHttpError> {
        let (runtime, identity) = self
            .management_context(request, owner, project_id, example_id)
            .await?;
        runtime
            .examples
            .select_active_version(
                identity.user_id,
                example_id,
                version_id,
                expected_generation,
            )
            .await
            .map(Into::into)
            .map_err(map_domain_error)
    }

    #[allow(
        clippy::too_many_arguments,
        reason = "HTTP mutation keeps path and concurrency fences explicit"
    )]
    pub(crate) async fn set_visibility(
        &self,
        request: BrowserRequestHeaders<'_>,
        owner: ProjectOwner,
        project_id: ProjectId,
        example_id: PublishedExampleId,
        visibility: PublishedExampleVisibility,
        expected_generation: i64,
    ) -> Result<PublishedExampleView, PublishedExampleHttpError> {
        let (runtime, identity) = self
            .management_context(request, owner, project_id, example_id)
            .await?;
        runtime
            .examples
            .set_visibility(
                identity.user_id,
                example_id,
                visibility,
                expected_generation,
            )
            .await
            .map(Into::into)
            .map_err(map_domain_error)
    }

    pub(crate) async fn unpublish(
        &self,
        request: BrowserRequestHeaders<'_>,
        owner: ProjectOwner,
        project_id: ProjectId,
        example_id: PublishedExampleId,
        expected_generation: i64,
    ) -> Result<PublishedExampleView, PublishedExampleHttpError> {
        self.publication_mutation(
            request,
            owner,
            project_id,
            example_id,
            expected_generation,
            false,
        )
        .await
    }

    pub(crate) async fn republish(
        &self,
        request: BrowserRequestHeaders<'_>,
        owner: ProjectOwner,
        project_id: ProjectId,
        example_id: PublishedExampleId,
        expected_generation: i64,
    ) -> Result<PublishedExampleView, PublishedExampleHttpError> {
        self.publication_mutation(
            request,
            owner,
            project_id,
            example_id,
            expected_generation,
            true,
        )
        .await
    }

    async fn publication_mutation(
        &self,
        request: BrowserRequestHeaders<'_>,
        owner: ProjectOwner,
        project_id: ProjectId,
        example_id: PublishedExampleId,
        expected_generation: i64,
        republish: bool,
    ) -> Result<PublishedExampleView, PublishedExampleHttpError> {
        let (runtime, identity) = self
            .management_context(request, owner, project_id, example_id)
            .await?;
        let result = if republish {
            runtime
                .examples
                .republish(identity.user_id, example_id, expected_generation)
                .await
        } else {
            runtime
                .examples
                .unpublish(identity.user_id, example_id, expected_generation)
                .await
        };
        result.map(Into::into).map_err(map_domain_error)
    }

    #[allow(
        clippy::too_many_arguments,
        reason = "destructive HTTP operation keeps every security fence explicit"
    )]
    pub(crate) async fn delete(
        &self,
        request: BrowserRequestHeaders<'_>,
        owner: ProjectOwner,
        project_id: ProjectId,
        example_id: PublishedExampleId,
        expected_generation: i64,
        name: PublishedExampleName,
    ) -> Result<(), PublishedExampleHttpError> {
        let (runtime, identity) = self
            .management_context(request, owner, project_id, example_id)
            .await?;
        runtime
            .examples
            .delete(
                identity.user_id,
                example_id,
                expected_generation,
                &PublishedExampleDeleteConfirmation {
                    name,
                    recently_reauthenticated: identity.recently_reauthenticated,
                },
            )
            .await
            .map_err(map_domain_error)
    }

    pub(crate) async fn list_public(
        &self,
        limit: u16,
    ) -> Result<PublicPublishedExampleListView, PublishedExampleHttpError> {
        let items = self
            .runtime()?
            .examples
            .list_public(limit)
            .await
            .map_err(map_domain_error)?
            .into_iter()
            .map(Into::into)
            .collect();
        Ok(PublicPublishedExampleListView { items })
    }

    pub(crate) async fn resolve_public(
        &self,
        public_id: &PublishedExamplePublicId,
        version_number: Option<i64>,
    ) -> Result<PublicPublishedExampleView, PublishedExampleHttpError> {
        self.runtime()?
            .examples
            .resolve_public(public_id, version_number)
            .await
            .map(Into::into)
            .map_err(map_domain_error)
    }

    async fn management_context(
        &self,
        request: BrowserRequestHeaders<'_>,
        owner: ProjectOwner,
        project_id: ProjectId,
        example_id: PublishedExampleId,
    ) -> Result<(&Runtime, BrowserIdentity), PublishedExampleHttpError> {
        let runtime = self.runtime()?;
        let identity = runtime.authenticate(request).await?;
        runtime
            .require_example_path(owner, project_id, example_id)
            .await?;
        Ok((runtime, identity))
    }

    fn runtime(&self) -> Result<&Runtime, PublishedExampleHttpError> {
        self.runtime
            .as_deref()
            .ok_or(PublishedExampleHttpError::Unavailable)
    }
}

struct BrowserIdentity {
    user_id: UserId,
    recently_reauthenticated: bool,
}

impl Runtime {
    async fn authenticate(
        &self,
        request: BrowserRequestHeaders<'_>,
    ) -> Result<BrowserIdentity, PublishedExampleHttpError> {
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
        let active: Option<bool> =
            sqlx::query_scalar("SELECT status='active' FROM users WHERE id=$1::uuid")
                .bind(fields.user_id.to_string())
                .fetch_optional(
                    &mut *self
                        .pool
                        .acquire()
                        .await
                        .map_err(|_| PublishedExampleHttpError::Unavailable)?,
                )
                .await
                .map_err(|_| PublishedExampleHttpError::Unavailable)?;
        if active != Some(true) {
            return Err(PublishedExampleHttpError::AuthenticationFailed);
        }
        let now = fields.last_seen_at.into_datetime();
        let recently_reauthenticated = fields.last_reauthenticated_at.is_some_and(|at| {
            let age = now - at.into_datetime();
            !age.is_negative() && age.whole_seconds() <= REAUTHENTICATION_WINDOW_SECONDS
        });
        Ok(BrowserIdentity {
            user_id: fields.user_id,
            recently_reauthenticated,
        })
    }

    async fn require_project_path(
        &self,
        owner: ProjectOwner,
        project_id: ProjectId,
    ) -> Result<(), PublishedExampleHttpError> {
        self.require_path(owner, project_id, None).await
    }

    async fn require_example_path(
        &self,
        owner: ProjectOwner,
        project_id: ProjectId,
        example_id: PublishedExampleId,
    ) -> Result<(), PublishedExampleHttpError> {
        self.require_path(owner, project_id, Some(example_id)).await
    }

    async fn require_path(
        &self,
        owner: ProjectOwner,
        project_id: ProjectId,
        example_id: Option<PublishedExampleId>,
    ) -> Result<(), PublishedExampleHttpError> {
        let (owner_kind, owner_id) = match owner {
            ProjectOwner::User(id) => ("user", id.to_string()),
            ProjectOwner::Organization(id) => ("organization", id.to_string()),
        };
        let found: bool = sqlx::query_scalar(
            "SELECT EXISTS(SELECT 1 FROM projects project \
             WHERE project.id=$1::uuid \
               AND (($2='user' AND project.owner_user_id=$3::uuid) \
                 OR ($2='organization' AND project.owner_organization_id=$3::uuid)) \
               AND ($4::uuid IS NULL OR EXISTS(SELECT 1 FROM published_examples example \
                 WHERE example.id=$4::uuid AND example.project_id=project.id)))",
        )
        .bind(project_id.to_string())
        .bind(owner_kind)
        .bind(owner_id)
        .bind(example_id.map(|id| id.to_string()))
        .fetch_one(
            &mut *self
                .pool
                .acquire()
                .await
                .map_err(|_| PublishedExampleHttpError::Unavailable)?,
        )
        .await
        .map_err(|_| PublishedExampleHttpError::Unavailable)?;
        if found {
            Ok(())
        } else {
            Err(PublishedExampleHttpError::NotFound)
        }
    }
}

#[derive(Clone, Debug, Serialize, ToSchema)]
#[serde(rename_all = "camelCase")]
pub struct PublishedExampleView {
    pub id: String,
    pub public_id: String,
    pub name: String,
    pub visibility: &'static str,
    pub state: &'static str,
    pub active_version_id: String,
    pub generation: i64,
    pub created_at: String,
    pub updated_at: String,
    pub unpublished_at: Option<String>,
}

impl From<PublishedExample> for PublishedExampleView {
    fn from(value: PublishedExample) -> Self {
        Self {
            id: value.id().to_string(),
            public_id: value.public_id().to_string(),
            name: value.name().as_str().to_owned(),
            visibility: visibility_name(value.visibility()),
            state: state_name(value.state()),
            active_version_id: value.active_version_id().to_string(),
            generation: value.generation(),
            created_at: value.created_at().to_string(),
            updated_at: value.updated_at().to_string(),
            unpublished_at: value.unpublished_at().map(|at| at.to_string()),
        }
    }
}

#[derive(Clone, Debug, Serialize, ToSchema)]
#[serde(rename_all = "camelCase")]
pub struct PublishedExampleVersionView {
    pub id: String,
    pub project_version_id: String,
    pub version_number: i64,
    pub created_at: String,
}

impl From<PublishedExampleVersion> for PublishedExampleVersionView {
    fn from(value: PublishedExampleVersion) -> Self {
        Self {
            id: value.id().to_string(),
            project_version_id: value.project_version_id().to_string(),
            version_number: value.version_number(),
            created_at: value.created_at().to_string(),
        }
    }
}

#[derive(Clone, Debug, Serialize, ToSchema)]
#[serde(rename_all = "camelCase")]
pub struct PublishedExampleCreateView {
    pub example: PublishedExampleView,
    pub version: PublishedExampleVersionView,
}

#[derive(Clone, Debug, Serialize, ToSchema)]
#[serde(rename_all = "camelCase")]
pub struct PublishedExampleVersionMutationView {
    pub version: PublishedExampleVersionView,
    pub generation: i64,
}

/// Public projection. Internal project, version, bundle, user, and storage IDs
/// are deliberately absent from this type.
#[derive(Clone, Debug, Serialize, ToSchema)]
#[serde(rename_all = "camelCase")]
pub struct PublicPublishedExampleView {
    pub public_id: String,
    pub name: String,
    pub visibility: &'static str,
    pub version_number: i64,
    pub published_at: String,
}

impl From<PublicPublishedExample> for PublicPublishedExampleView {
    fn from(value: PublicPublishedExample) -> Self {
        Self {
            public_id: value.public_id().to_string(),
            name: value.name().as_str().to_owned(),
            visibility: visibility_name(value.visibility()),
            version_number: value.version_number(),
            published_at: value.published_at().to_string(),
        }
    }
}

#[derive(Clone, Debug, Serialize, ToSchema)]
pub struct PublicPublishedExampleListView {
    pub items: Vec<PublicPublishedExampleView>,
}

fn map_browser_error(error: BrowserCookieError) -> PublishedExampleHttpError {
    match error {
        BrowserCookieError::MissingSessionCookie | BrowserCookieError::InvalidSessionCookie => {
            PublishedExampleHttpError::AuthenticationFailed
        }
        _ => PublishedExampleHttpError::Forbidden,
    }
}

fn map_session_error(error: SessionServiceError) -> PublishedExampleHttpError {
    match error {
        SessionServiceError::InvalidToken | SessionServiceError::UserUnavailable => {
            PublishedExampleHttpError::AuthenticationFailed
        }
        SessionServiceError::OperationTimeout => PublishedExampleHttpError::OperationTimeout,
        SessionServiceError::DatabaseUnavailable => PublishedExampleHttpError::Unavailable,
        _ => PublishedExampleHttpError::Internal,
    }
}

fn map_domain_error(error: PublishedExampleError) -> PublishedExampleHttpError {
    match error {
        PublishedExampleError::InvalidInput => PublishedExampleHttpError::InvalidInput,
        PublishedExampleError::NotFound => PublishedExampleHttpError::NotFound,
        PublishedExampleError::Forbidden => PublishedExampleHttpError::Forbidden,
        PublishedExampleError::ProjectUnavailable
        | PublishedExampleError::VersionUnavailable
        | PublishedExampleError::InvalidLifecycle
        | PublishedExampleError::PublicIdConflict => PublishedExampleHttpError::Conflict,
        PublishedExampleError::StaleGeneration => PublishedExampleHttpError::PreconditionFailed,
        PublishedExampleError::ConfirmationRequired => {
            PublishedExampleHttpError::ConfirmationRequired
        }
        PublishedExampleError::OperationTimeout => PublishedExampleHttpError::OperationTimeout,
        PublishedExampleError::DatabaseUnavailable => PublishedExampleHttpError::Unavailable,
        PublishedExampleError::CommitOutcomeUnknown => {
            PublishedExampleHttpError::CommitOutcomeUnknown
        }
        PublishedExampleError::EntropyUnavailable | PublishedExampleError::InvariantViolation => {
            PublishedExampleHttpError::Internal
        }
    }
}

const fn visibility_name(value: PublishedExampleVisibility) -> &'static str {
    match value {
        PublishedExampleVisibility::Unlisted => "unlisted",
        PublishedExampleVisibility::Public => "public",
    }
}

const fn state_name(value: PublishedExampleState) -> &'static str {
    match value {
        PublishedExampleState::Published => "published",
        PublishedExampleState::Unpublished => "unpublished",
    }
}
