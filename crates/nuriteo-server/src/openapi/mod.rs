use axum::{Json, Router};
use serde::Serialize;
use utoipa::Modify;
use utoipa::openapi::security::{ApiKey, ApiKeyValue, SecurityScheme};
use utoipa::{OpenApi, ToSchema};
use utoipa_axum::routes;
use utoipa_swagger_ui::{Config, SwaggerUi};

use crate::VERSION;
use crate::auth::{self, AuthService};
use crate::invitations::{self, InvitationHttpService};
use crate::organization::{self, OrganizationHttpService};
use crate::project::{self, ProjectHttpService};
use crate::setup::{self, SetupStatusService};
use crate::workspace;

pub const DOCUMENT_PATH: &str = "/api/openapi.json";
pub const DOCS_PATH: &str = "/api/docs";

#[derive(OpenApi)]
#[openapi(
    info(
        title = "NURITEO Public API",
        version = "1.0.0",
        description = "Versioned public REST API for a self-hosted NURITEO instance."
    ),
    components(schemas(VersionResponse, ProblemDetails, FieldViolation)),
    modifiers(&ProjectSessionSecurity),
    tags(
        (name = "system", description = "Public instance compatibility information"),
        (name = "setup", description = "Public secret-free instance setup state"),
        (name = "authentication", description = "Local browser Session lifecycle"),
        (name = "workspaces", description = "Authenticated Workspace projections"),
        (name = "invitations", description = "Administrator invitation and public account activation lifecycle"),
        (name = "organizations", description = "Authenticated Organization lifecycle and membership administration"),
        (name = "organization-invitations", description = "Role-bound Organization invitation lifecycle")
        ,(name = "projects", description = "Workspace-owned Project lifecycle")
        ,(name = "project-roles", description = "Organization Project direct role administration")
    ),
    servers((url = "/", description = "Current self-hosted instance"))
)]
struct ApiDocument;

const PROJECT_SESSION_SCHEME: &str = "projectSessionCookie";

struct ProjectSessionSecurity;

impl Modify for ProjectSessionSecurity {
    fn modify(&self, openapi: &mut utoipa::openapi::OpenApi) {
        let components = openapi.components.get_or_insert_default();
        components.add_security_scheme(
            PROJECT_SESSION_SCHEME,
            SecurityScheme::ApiKey(ApiKey::Cookie(
                ApiKeyValue::with_description(
                    "__Host-nuriteo_session",
                    "Host-only, Secure, HttpOnly browser Session cookie. Loopback development uses the equivalent nuriteo_dev_session cookie.",
                ),
            )),
        );
    }
}

#[derive(Debug, Serialize, ToSchema)]
struct VersionResponse {
    #[schema(example = "0.1.0")]
    version: &'static str,
}

#[derive(Debug, Serialize, ToSchema)]
struct FieldViolation {
    #[schema(example = "name")]
    path: String,
    #[schema(example = "INVALID")]
    code: String,
    #[schema(example = "The field is invalid.")]
    detail: String,
}

#[derive(Debug, Serialize, ToSchema)]
pub(crate) struct ProblemDetails {
    #[serde(rename = "type")]
    #[schema(example = "/docs/problems/validation-failed")]
    type_uri: String,
    #[schema(example = "Validation failed")]
    title: String,
    #[schema(example = 422)]
    status: u16,
    #[schema(example = "One or more fields are invalid.")]
    detail: String,
    #[schema(example = "/api/v1/projects")]
    instance: String,
    #[schema(example = "VALIDATION_FAILED")]
    code: String,
    #[schema(example = "0199ee6c-c777-7000-8000-000000000001")]
    request_id: String,
    errors: Vec<FieldViolation>,
}

#[utoipa::path(
    get,
    path = "/api/v1/version",
    tag = "system",
    params(
        (
            "x-request-id" = Option<String>,
            Header,
            description = "Optional caller correlation ID. Invalid or duplicate values are replaced."
        )
    ),
    responses(
        (
            status = 200,
            description = "Server release version",
            body = VersionResponse,
            headers(
                ("x-request-id" = String, description = "Validated or server-generated correlation ID")
            )
        ),
        (
            status = 405,
            description = "Method not allowed",
            body = ProblemDetails,
            content_type = "application/problem+json",
            headers(
                ("x-request-id" = String, description = "Validated or server-generated correlation ID")
            )
        )
    )
)]
async fn version() -> Json<VersionResponse> {
    Json(VersionResponse { version: VERSION })
}

#[must_use]
pub fn document() -> utoipa::openapi::OpenApi {
    openapi_parts(
        AuthService::unconfigured(),
        InvitationHttpService::unconfigured(),
        OrganizationHttpService::unconfigured(),
        ProjectHttpService::unconfigured(),
        SetupStatusService::unconfigured(),
    )
    .1
}

pub fn router(
    auth: AuthService,
    invitations: InvitationHttpService,
    organizations: OrganizationHttpService,
    projects: ProjectHttpService,
    setup: SetupStatusService,
) -> Router {
    let (api_routes, document) = openapi_parts(auth, invitations, organizations, projects, setup);
    let config = Config::new([DOCUMENT_PATH]).validator_url("none");
    let docs = SwaggerUi::new(DOCS_PATH)
        .url(DOCUMENT_PATH, document)
        .config(config);

    api_routes.merge(Router::from(docs))
}

fn openapi_parts(
    auth: AuthService,
    invitations: InvitationHttpService,
    organizations: OrganizationHttpService,
    projects: ProjectHttpService,
    setup: SetupStatusService,
) -> (Router, utoipa::openapi::OpenApi) {
    let (auth_routes, document) =
        workspace::openapi_router(auth::openapi_router(ApiDocument::openapi()))
            .with_state::<()>(auth)
            .split_for_parts();
    let (invitation_routes, document) = invitations::openapi_router(document)
        .routes(routes!(version))
        .with_state(invitations)
        .split_for_parts();
    let (organization_routes, document) = organization::openapi_router(document)
        .with_state(organizations)
        .split_for_parts();
    let (project_routes, document) = project::openapi_router(document)
        .with_state(projects)
        .split_for_parts();
    let (setup_routes, document) = setup::openapi_router(document)
        .with_state(setup)
        .split_for_parts();
    (
        auth_routes
            .merge(invitation_routes)
            .merge(organization_routes)
            .merge(project_routes)
            .merge(setup_routes),
        document,
    )
}
