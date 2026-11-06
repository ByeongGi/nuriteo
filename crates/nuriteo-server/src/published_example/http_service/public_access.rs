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

#[derive(Clone, Debug, Serialize, ToSchema)]
#[serde(rename_all = "camelCase")]
pub struct ForkedProjectView {
    pub id: String,
    pub owner_type: &'static str,
    pub owner_id: String,
    pub slug: String,
    pub name: String,
    pub state: &'static str,
    pub version: i64,
    pub created_at: String,
    pub updated_at: String,
}

impl From<Project> for ForkedProjectView {
    fn from(project: Project) -> Self {
        let (owner_type, owner_id) = match project.owner() {
            ProjectOwner::User(id) => ("user", id.to_string()),
            ProjectOwner::Organization(id) => ("organization", id.to_string()),
        };
        Self {
            id: project.id().to_string(),
            owner_type,
            owner_id,
            slug: project.slug().as_str().to_owned(),
            name: project.name().as_str().to_owned(),
            state: match project.state() {
                crate::project::ProjectState::Active => "active",
                crate::project::ProjectState::Archived => "archived",
            },
            version: project.lock_version().get(),
            created_at: project.created_at().to_string(),
            updated_at: project.updated_at().to_string(),
        }
    }
}

#[derive(Clone, Debug, Serialize, ToSchema)]
#[serde(rename_all = "camelCase")]
pub struct PublishedExampleForkView {
    pub project: ForkedProjectView,
    pub source_version_number: i64,
    pub idempotent_retry: bool,
}

impl From<PublishedExampleForkResult> for PublishedExampleForkView {
    fn from(result: PublishedExampleForkResult) -> Self {
        Self {
            project: result.project().clone().into(),
            source_version_number: result.source_version_number(),
            idempotent_retry: result.is_idempotent_retry(),
        }
    }
}

fn map_content_error(error: PublishedContentError) -> PublishedExampleHttpError {
    match error {
        PublishedContentError::InvalidInput => PublishedExampleHttpError::InvalidInput,
        PublishedContentError::NotFound => PublishedExampleHttpError::NotFound,
        PublishedContentError::OperationTimeout => PublishedExampleHttpError::OperationTimeout,
        PublishedContentError::ObjectUnavailable
        | PublishedContentError::PersistenceUnavailable
        | PublishedContentError::TooLarge => PublishedExampleHttpError::Unavailable,
        PublishedContentError::ObjectMismatch | PublishedContentError::InvariantViolation => {
            PublishedExampleHttpError::Internal
        }
    }
}

fn map_fork_error(error: PublishedExampleForkError) -> PublishedExampleHttpError {
    match error {
        PublishedExampleForkError::InvalidInput => PublishedExampleHttpError::InvalidInput,
        PublishedExampleForkError::ActorUnavailable => {
            PublishedExampleHttpError::AuthenticationFailed
        }
        PublishedExampleForkError::Forbidden => PublishedExampleHttpError::Forbidden,
        PublishedExampleForkError::SourceUnavailable => PublishedExampleHttpError::NotFound,
        PublishedExampleForkError::NamespaceUnavailable
        | PublishedExampleForkError::IdempotencyConflict
        | PublishedExampleForkError::ResultUnavailable => PublishedExampleHttpError::Conflict,
        PublishedExampleForkError::QuotaExceeded => PublishedExampleHttpError::QuotaExceeded,
        PublishedExampleForkError::AuditUnavailable
        | PublishedExampleForkError::DatabaseUnavailable => PublishedExampleHttpError::Unavailable,
        PublishedExampleForkError::OperationTimeout => PublishedExampleHttpError::OperationTimeout,
        PublishedExampleForkError::CommitOutcomeUnknown => {
            PublishedExampleHttpError::CommitOutcomeUnknown
        }
        PublishedExampleForkError::InvariantViolation => PublishedExampleHttpError::Internal,
    }
}

impl PublishedExampleHttpService {
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

    pub(crate) async fn charge_public_preview_binding(
        &self,
        public_id: &PublishedExamplePublicId,
        abuse_key: Uuid,
        version_number: i64,
        proof: &str,
    ) -> Result<(), PublishedExampleHttpError> {
        let runtime = self.runtime()?;
        let key = runtime
            .preview_admission_key
            .as_ref()
            .ok_or(PublishedExampleHttpError::Unavailable)?;
        let proof = URL_SAFE_NO_PAD
            .decode(proof)
            .map_err(|_| PublishedExampleHttpError::InvalidInput)?;
        let mut mac = <Hmac<Sha256> as KeyInit>::new_from_slice(&key.0)
            .map_err(|_| PublishedExampleHttpError::Internal)?;
        mac.update(
            format!(
                "public-preview-admission-v1\0{abuse_key}\0{}\0{version_number}",
                public_id.as_str()
            )
            .as_bytes(),
        );
        mac.verify_slice(&proof)
            .map_err(|_| PublishedExampleHttpError::InvalidInput)?;
        let mut connection = runtime
            .pool
            .acquire()
            .await
            .map_err(|_| PublishedExampleHttpError::Unavailable)?;
        sqlx::query(
            "WITH expired AS (SELECT abuse_key,public_id,window_started_at \
             FROM public_preview_rate_limit_buckets \
             WHERE window_started_at<date_trunc('minute',transaction_timestamp())-interval '1 minute' \
             ORDER BY window_started_at,abuse_key,public_id FOR UPDATE SKIP LOCKED LIMIT 100) \
             DELETE FROM public_preview_rate_limit_buckets bucket USING expired \
             WHERE bucket.abuse_key=expired.abuse_key AND bucket.public_id=expired.public_id \
             AND bucket.window_started_at=expired.window_started_at",
        )
        .execute(&mut *connection)
        .await
        .map_err(|_| PublishedExampleHttpError::Unavailable)?;
        let accepted: Option<i32> = sqlx::query_scalar(
            "INSERT INTO public_preview_rate_limit_buckets \
             (abuse_key,public_id,window_started_at,used_bindings) \
             VALUES($1::uuid,$2,date_trunc('minute',transaction_timestamp()),1) \
             ON CONFLICT(abuse_key,public_id,window_started_at) DO UPDATE SET \
               used_bindings=public_preview_rate_limit_buckets.used_bindings+1, \
               updated_at=transaction_timestamp() \
             WHERE public_preview_rate_limit_buckets.used_bindings<$3 \
             RETURNING used_bindings",
        )
        .bind(abuse_key.to_string())
        .bind(public_id.as_str())
        .bind(PUBLIC_PREVIEW_BINDINGS_PER_MINUTE)
        .fetch_optional(&mut *connection)
        .await
        .map_err(|_| PublishedExampleHttpError::Unavailable)?;
        if accepted.is_none() {
            return Err(PublishedExampleHttpError::RateLimited);
        }
        Ok(())
    }

    pub(crate) async fn download_public_content(
        &self,
        public_id: &PublishedExamplePublicId,
        version_number: Option<i64>,
    ) -> Result<PublishedContentDownload, PublishedExampleHttpError> {
        self.runtime()?
            .content
            .download(public_id, version_number)
            .await
            .map_err(map_content_error)
    }

    #[allow(
        clippy::too_many_arguments,
        reason = "fork keeps public source, destination namespace, idempotency, and audit fences explicit"
    )]
    pub(crate) async fn fork_public(
        &self,
        request: BrowserRequestHeaders<'_>,
        public_id: PublishedExamplePublicId,
        version_number: Option<i64>,
        destination_owner: ProjectOwner,
        destination_slug: ProjectSlug,
        destination_name: ProjectName,
        idempotency_key: PublishedExampleForkKey,
        correlation_id: &str,
    ) -> Result<PublishedExampleForkView, PublishedExampleHttpError> {
        let runtime = self.runtime()?;
        let identity = runtime.authenticate(request).await?;
        runtime
            .forks
            .fork(
                ForkPublishedExample {
                    actor_user_id: identity.user_id,
                    source_public_id: public_id,
                    source_version_number: version_number,
                    destination_owner,
                    destination_slug,
                    destination_name,
                    idempotency_key,
                },
                &identity.audit(correlation_id),
            )
            .await
            .map(PublishedExampleForkView::from)
            .map_err(map_fork_error)
    }
}
