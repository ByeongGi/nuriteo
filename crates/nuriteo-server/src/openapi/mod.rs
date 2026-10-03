use axum::{Json, Router};
use serde::Serialize;
use utoipa::{OpenApi, ToSchema};
use utoipa_axum::routes;
use utoipa_swagger_ui::{Config, SwaggerUi};

use crate::VERSION;
use crate::auth::{self, AuthService};

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
    tags(
        (name = "system", description = "Public instance compatibility information"),
        (name = "authentication", description = "Local browser Session lifecycle")
    ),
    servers((url = "/", description = "Current self-hosted instance"))
)]
struct ApiDocument;

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
    openapi_parts(AuthService::unconfigured()).1
}

pub fn router(auth: AuthService) -> Router {
    let (api_routes, document) = openapi_parts(auth);
    let config = Config::new([DOCUMENT_PATH]).validator_url("none");
    let docs = SwaggerUi::new(DOCS_PATH)
        .url(DOCUMENT_PATH, document)
        .config(config);

    api_routes.merge(Router::from(docs))
}

fn openapi_parts(auth: AuthService) -> (Router, utoipa::openapi::OpenApi) {
    auth::openapi_router(ApiDocument::openapi())
        .routes(routes!(version))
        .with_state(auth)
        .split_for_parts()
}
