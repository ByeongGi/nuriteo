use axum::extract::Extension;
use axum::middleware;
use axum::routing::get;
use axum::{Json, Router};
use serde::Serialize;

use crate::http::{HttpError, RequestId, propagate_request_id};

#[derive(Debug, Serialize)]
struct Liveness {
    status: &'static str,
}

pub fn build_router() -> Router {
    Router::new()
        .route("/health/live", get(liveness))
        .fallback(not_found)
        .method_not_allowed_fallback(method_not_allowed)
        .layer(middleware::from_fn(propagate_request_id))
}

async fn liveness() -> Json<Liveness> {
    Json(Liveness { status: "ok" })
}

async fn not_found(Extension(request_id): Extension<RequestId>) -> HttpError {
    HttpError::not_found(request_id)
}

async fn method_not_allowed(Extension(request_id): Extension<RequestId>) -> HttpError {
    HttpError::method_not_allowed(request_id)
}
