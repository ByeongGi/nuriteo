use std::{fmt, sync::Arc};

use base64::{Engine as _, engine::general_purpose::URL_SAFE_NO_PAD};
use hmac::{Hmac, KeyInit, Mac};
use serde::Serialize;
use sha2::Sha256;
use url::Url;
use utoipa::ToSchema;
use uuid::Uuid;

use crate::{
    audit::AuditEventId,
    database::DatabasePool,
    identity::{
        BrowserCookieBoundary, BrowserCookieError, BrowserRequestHeaders, SessionPolicy,
        SessionService, SessionServiceError, UserId,
    },
    object_storage::S3ObjectStore,
    project::{
        Project, ProjectAuditContext, ProjectId, ProjectName, ProjectOwner, ProjectSlug,
        ProjectState,
    },
    save::ProjectVersionId,
};

use super::super::{
    CreatePublishedExample, ForkPublishedExample, PublicPublishedExample, PublishedContentDownload,
    PublishedContentError, PublishedContentService, PublishedExample,
    PublishedExampleDeleteConfirmation, PublishedExampleError, PublishedExampleForkError,
    PublishedExampleForkKey, PublishedExampleForkPolicy, PublishedExampleForkResult,
    PublishedExampleForkService, PublishedExampleId, PublishedExampleName,
    PublishedExamplePublicId, PublishedExampleService, PublishedExampleServicePolicy,
    PublishedExampleState, PublishedExampleVersion, PublishedExampleVersionId,
    PublishedExampleVisibility,
};
use super::{
    BrowserIdentity, PUBLIC_PREVIEW_BINDINGS_PER_MINUTE, PublishedExampleHttpError,
    PublishedExampleHttpService, Runtime, map_domain_error, state_name, visibility_name,
};

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

impl PublishedExampleHttpService {
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
                &PublishedExampleDeleteConfirmation { name },
            )
            .await
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
}

impl Runtime {
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
