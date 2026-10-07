use crate::admin::AdminHttpService;
use crate::auth::AuthService;
use crate::health::HealthService;
use crate::http::{HttpError, RequestId, propagate_request_id};
use crate::invitations::InvitationHttpService;
use crate::openapi;
use crate::organization::OrganizationHttpService;
use crate::project::ProjectHttpService;
use crate::save::SaveHttpService;
use crate::setup::SetupStatusService;
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
    build_router_with_setup_service(
        health,
        auth,
        invitations,
        organizations,
        SetupStatusService::unconfigured(),
    )
}

pub fn build_router_with_setup_service(
    health: HealthService,
    auth: AuthService,
    invitations: InvitationHttpService,
    organizations: OrganizationHttpService,
    setup: SetupStatusService,
) -> Router {
    build_router_with_project_service(
        health,
        auth,
        invitations,
        organizations,
        ProjectHttpService::unconfigured(),
        setup,
    )
}

pub fn build_router_with_project_service(
    health: HealthService,
    auth: AuthService,
    invitations: InvitationHttpService,
    organizations: OrganizationHttpService,
    projects: ProjectHttpService,
    setup: SetupStatusService,
) -> Router {
    build_router_with_save_service(
        health,
        auth,
        invitations,
        organizations,
        projects,
        SaveHttpService::unconfigured(),
        setup,
    )
}

pub fn build_router_with_save_service(
    health: HealthService,
    auth: AuthService,
    invitations: InvitationHttpService,
    organizations: OrganizationHttpService,
    projects: ProjectHttpService,
    save: SaveHttpService,
    setup: SetupStatusService,
) -> Router {
    build_router_with_admin_service(
        health,
        auth,
        invitations,
        organizations,
        projects,
        save,
        setup,
        AdminHttpService::unconfigured(),
    )
}

#[allow(clippy::too_many_arguments)]
pub fn build_router_with_admin_service(
    health: HealthService,
    auth: AuthService,
    invitations: InvitationHttpService,
    organizations: OrganizationHttpService,
    projects: ProjectHttpService,
    save: SaveHttpService,
    setup: SetupStatusService,
    admin: AdminHttpService,
) -> Router {
    openapi::router(
        auth,
        invitations,
        organizations,
        projects,
        save,
        setup,
        admin,
    )
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
