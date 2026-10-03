use axum::Json;
use axum::extract::{Extension, State};
use axum::http::header::CACHE_CONTROL;
use axum::http::{HeaderValue, StatusCode};
use axum::response::{IntoResponse, Response};
use utoipa_axum::{router::OpenApiRouter, routes};

use crate::http::{HttpError, RequestId};

use super::SetupStatusService;

const SETUP_STATUS_PATH: &str = "/api/v1/setup/status";
const NO_STORE: HeaderValue = HeaderValue::from_static("no-store");

pub(crate) fn openapi_router(
    document: utoipa::openapi::OpenApi,
) -> OpenApiRouter<SetupStatusService> {
    OpenApiRouter::with_openapi(document).routes(routes!(setup_status))
}

#[utoipa::path(
    get,
    path = "/api/v1/setup/status",
    tag = "setup",
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
            description = "Whether the CLI-only Instance Administrator bootstrap is required",
            body = crate::setup::SetupStatus,
            headers(
                ("cache-control" = String, description = "Always no-store"),
                ("x-request-id" = String, description = "Validated or server-generated correlation ID")
            )
        ),
        (
            status = 500,
            description = "Setup status could not be determined safely",
            body = crate::openapi::ProblemDetails,
            content_type = "application/problem+json",
            headers(
                ("cache-control" = String, description = "Always no-store"),
                ("x-request-id" = String, description = "Validated or server-generated correlation ID")
            )
        )
    )
)]
async fn setup_status(
    State(service): State<SetupStatusService>,
    Extension(request_id): Extension<RequestId>,
) -> Response {
    let mut response = match service.status().await {
        Ok(status) => (StatusCode::OK, Json(status)).into_response(),
        Err(_) => HttpError::internal(request_id, SETUP_STATUS_PATH).into_response(),
    };
    response.headers_mut().insert(CACHE_CONTROL, NO_STORE);
    response
}
