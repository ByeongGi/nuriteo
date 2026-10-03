use crate::auth::AuthService;
use crate::health::HealthService;
use crate::http::{HttpError, RequestId, propagate_request_id};
use crate::invitations::InvitationHttpService;
use crate::openapi;
use crate::organization::OrganizationHttpService;
use axum::Router;
use axum::extract::Extension;
use axum::http::Uri;
use axum::middleware;

pub fn build_router() -> Router {
    build_router_with_services(HealthService::unconfigured(), AuthService::unconfigured())
}

pub fn build_router_with_health(health: HealthService) -> Router {
    build_router_with_services(health, AuthService::unconfigured())
}

pub fn build_router_with_services(health: HealthService, auth: AuthService) -> Router {
    build_router_with_all_services(health, auth, InvitationHttpService::unconfigured())
}

pub fn build_router_with_all_services(
    health: HealthService,
    auth: AuthService,
    invitations: InvitationHttpService,
) -> Router {
    build_router_with_http_services(
        health,
        auth,
        invitations,
        OrganizationHttpService::unconfigured(),
    )
}

pub fn build_router_with_http_services(
    health: HealthService,
    auth: AuthService,
    invitations: InvitationHttpService,
    organizations: OrganizationHttpService,
) -> Router {
    openapi::router(auth, invitations, organizations)
        .merge(health.router())
        .fallback(not_found)
        .method_not_allowed_fallback(method_not_allowed)
        .layer(middleware::from_fn(propagate_request_id))
}

async fn not_found(uri: Uri, Extension(request_id): Extension<RequestId>) -> HttpError {
    HttpError::not_found(request_id, uri.path())
}

async fn method_not_allowed(uri: Uri, Extension(request_id): Extension<RequestId>) -> HttpError {
    HttpError::method_not_allowed(request_id, uri.path())
}
