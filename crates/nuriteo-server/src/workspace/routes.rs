use axum::Json;
use axum::extract::{Extension, Request, State};
use axum::http::header::COOKIE;
use serde::Serialize;
use utoipa::ToSchema;
use utoipa_axum::{router::OpenApiRouter, routes};

use crate::auth::{AuthService, AuthServiceError};
use crate::http::{HttpError, RequestId};
use crate::identity::{BrowserMethod, BrowserRequestHeaders};

use super::{OrganizationWorkspace, PersonalWorkspace, Workspace, WorkspaceOwnerType};

const WORKSPACES_PATH: &str = "/api/v1/me/workspaces";

pub(crate) fn openapi_router(router: OpenApiRouter<AuthService>) -> OpenApiRouter<AuthService> {
    router.routes(routes!(current_workspaces))
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize, ToSchema)]
#[serde(rename_all = "camelCase")]
pub(crate) struct WorkspaceCollectionView {
    workspaces: Vec<WorkspaceView>,
}

impl WorkspaceCollectionView {
    fn new(workspaces: Vec<Workspace>) -> Self {
        Self {
            workspaces: workspaces.into_iter().map(WorkspaceView::from).collect(),
        }
    }
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize, ToSchema)]
#[serde(rename_all = "camelCase")]
pub(crate) struct WorkspaceView {
    owner_type: WorkspaceOwnerView,
    owner_id: String,
    display_label: String,
    storage_scope_id: String,
}

impl From<PersonalWorkspace> for WorkspaceView {
    fn from(workspace: PersonalWorkspace) -> Self {
        let owner_type = match workspace.owner_type() {
            WorkspaceOwnerType::User => WorkspaceOwnerView::User,
            WorkspaceOwnerType::Organization => WorkspaceOwnerView::Organization,
        };
        Self {
            owner_type,
            owner_id: workspace.owner_id().to_string(),
            display_label: workspace.display_label().to_owned(),
            storage_scope_id: workspace.storage_scope_id().to_string(),
        }
    }
}

impl From<OrganizationWorkspace> for WorkspaceView {
    fn from(workspace: OrganizationWorkspace) -> Self {
        let owner_type = match workspace.owner_type() {
            WorkspaceOwnerType::Organization => WorkspaceOwnerView::Organization,
            WorkspaceOwnerType::User => WorkspaceOwnerView::User,
        };
        Self {
            owner_type,
            owner_id: workspace.owner_id().to_string(),
            display_label: workspace.display_label().to_owned(),
            storage_scope_id: workspace.storage_scope_id().to_string(),
        }
    }
}

impl From<Workspace> for WorkspaceView {
    fn from(workspace: Workspace) -> Self {
        match workspace {
            Workspace::Personal(workspace) => workspace.into(),
            Workspace::Organization(workspace) => workspace.into(),
        }
    }
}

#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, ToSchema)]
#[serde(rename_all = "snake_case")]
pub(crate) enum WorkspaceOwnerView {
    User,
    Organization,
}

#[utoipa::path(
    get,
    path = "/api/v1/me/workspaces",
    tag = "workspaces",
    params(
        (
            "x-request-id" = Option<String>,
            Header,
            description = "Optional caller correlation ID. Invalid or duplicate values are replaced."
        )
    ),
    responses(
        (status = 200, description = "Workspaces visible to the current active User", body = WorkspaceCollectionView),
        (status = 401, description = "Session is missing, invalid, expired or revoked, or its User is unavailable", body = crate::openapi::ProblemDetails, content_type = "application/problem+json"),
        (status = 500, description = "Workspace persistence invariants could not be satisfied", body = crate::openapi::ProblemDetails, content_type = "application/problem+json")
    )
)]
pub(crate) async fn current_workspaces(
    State(service): State<AuthService>,
    Extension(request_id): Extension<RequestId>,
    request: Request,
) -> Result<Json<WorkspaceCollectionView>, HttpError> {
    let cookies = request
        .headers()
        .get_all(COOKIE)
        .iter()
        .map(|value| value.to_str())
        .collect::<Result<Vec<_>, _>>()
        .map_err(|_| HttpError::authentication(request_id.clone(), WORKSPACES_PATH))?;
    let workspaces = service
        .workspaces(BrowserRequestHeaders {
            method: BrowserMethod::Get,
            origins: &[],
            cookie_headers: &cookies,
            csrf_headers: &[],
        })
        .await
        .map_err(|error| map_service_error(error, request_id.clone()))?;
    Ok(Json(WorkspaceCollectionView::new(workspaces)))
}

fn map_service_error(error: AuthServiceError, request_id: RequestId) -> HttpError {
    match error {
        AuthServiceError::AuthenticationFailed => {
            HttpError::authentication(request_id, WORKSPACES_PATH)
        }
        AuthServiceError::RequestForbidden
        | AuthServiceError::Unavailable
        | AuthServiceError::OperationTimeout
        | AuthServiceError::Internal => HttpError::internal(request_id, WORKSPACES_PATH),
    }
}
