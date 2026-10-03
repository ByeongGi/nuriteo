use axum::extract::Extension;
use axum::http::Uri;
use axum::middleware;
use axum::routing::get;
use axum::{Json, Router};
use serde::Serialize;

use crate::VERSION;
use crate::http::{HttpError, RequestId, propagate_request_id};

#[derive(Debug, Serialize)]
struct Version {
    version: &'static str,
}

pub fn build_router() -> Router {
    Router::new()
        .route("/api/v1/version", get(version))
        .fallback(not_found)
        .method_not_allowed_fallback(method_not_allowed)
        .layer(middleware::from_fn(propagate_request_id))
}

async fn version() -> Json<Version> {
    Json(Version { version: VERSION })
}

async fn not_found(uri: Uri, Extension(request_id): Extension<RequestId>) -> HttpError {
    HttpError::not_found(request_id, uri.path())
}

async fn method_not_allowed(uri: Uri, Extension(request_id): Extension<RequestId>) -> HttpError {
    HttpError::method_not_allowed(request_id, uri.path())
}
