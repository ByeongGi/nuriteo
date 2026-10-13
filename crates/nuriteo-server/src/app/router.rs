use crate::access_token::AccessTokenManagementService;
use crate::admin::AdminHttpService;
use crate::auth::AuthService;
use crate::git_operations::GitHttpService;
use crate::health::HealthService;
use crate::http::{HttpError, RequestId, propagate_request_id};
use crate::identity::{BrowserMethod, BrowserRequestHeaders};
use crate::integration_ca::IntegrationCaHttpService;
use crate::invitations::InvitationHttpService;
use crate::maintenance::MaintenanceGate;
use crate::mfa::{MfaHttpService, MfaHttpServiceError};
use crate::notification::NotificationHttpService;
use crate::observability::{MetricsService, observe_http};
use crate::oidc::OidcHttpService;
use crate::openapi;
use crate::organization::OrganizationHttpService;
use crate::project::ProjectHttpService;
use crate::published_example::PublishedExampleHttpService;
use crate::registry_gateway::RegistryHttpService;
use crate::save::SaveHttpService;
use crate::setup::SetupStatusService;
use crate::team::TeamHttpService;
use axum::Router;
use axum::extract::{Extension, Request};
use axum::http::header::{CACHE_CONTROL, HeaderValue, RETRY_AFTER};
use axum::http::{Method, Uri};
use axum::middleware::{self, Next};
use axum::response::{IntoResponse, Response};

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
    build_router_with_team_service(
        health,
        auth,
        invitations,
        organizations,
        projects,
        save,
        setup,
        admin,
        TeamHttpService::unconfigured(),
    )
}

#[allow(clippy::too_many_arguments)]
pub fn build_router_with_team_service(
    health: HealthService,
    auth: AuthService,
    invitations: InvitationHttpService,
    organizations: OrganizationHttpService,
    projects: ProjectHttpService,
    save: SaveHttpService,
    setup: SetupStatusService,
    admin: AdminHttpService,
    teams: TeamHttpService,
) -> Router {
    build_router_with_mfa_service(
        health,
        auth,
        invitations,
        organizations,
        projects,
        save,
        setup,
        admin,
        teams,
        MfaHttpService::unconfigured(),
    )
}

#[allow(clippy::too_many_arguments)]
pub fn build_router_with_mfa_service(
    health: HealthService,
    auth: AuthService,
    invitations: InvitationHttpService,
    organizations: OrganizationHttpService,
    projects: ProjectHttpService,
    save: SaveHttpService,
    setup: SetupStatusService,
    admin: AdminHttpService,
    teams: TeamHttpService,
    mfa: MfaHttpService,
) -> Router {
    build_router_with_notification_service(
        health,
        auth,
        invitations,
        organizations,
        projects,
        save,
        setup,
        admin,
        teams,
        mfa,
        NotificationHttpService::unconfigured(),
    )
}

#[allow(clippy::too_many_arguments)]
pub(crate) fn build_router_with_notification_service(
    health: HealthService,
    auth: AuthService,
    invitations: InvitationHttpService,
    organizations: OrganizationHttpService,
    projects: ProjectHttpService,
    save: SaveHttpService,
    setup: SetupStatusService,
    admin: AdminHttpService,
    teams: TeamHttpService,
    mfa: MfaHttpService,
    notifications: NotificationHttpService,
) -> Router {
    build_router_with_access_token_service(
        health,
        auth,
        invitations,
        organizations,
        projects,
        save,
        setup,
        admin,
        teams,
        mfa,
        notifications,
        AccessTokenManagementService::unconfigured(),
    )
}

#[allow(clippy::too_many_arguments)]
pub(crate) fn build_router_with_access_token_service(
    health: HealthService,
    auth: AuthService,
    invitations: InvitationHttpService,
    organizations: OrganizationHttpService,
    projects: ProjectHttpService,
    save: SaveHttpService,
    setup: SetupStatusService,
    admin: AdminHttpService,
    teams: TeamHttpService,
    mfa: MfaHttpService,
    notifications: NotificationHttpService,
    access_tokens: AccessTokenManagementService,
) -> Router {
    build_router_with_oidc_service(
        health,
        auth,
        invitations,
        organizations,
        projects,
        save,
        setup,
        admin,
        teams,
        mfa,
        notifications,
        access_tokens,
        OidcHttpService::unconfigured(),
    )
}

#[allow(clippy::too_many_arguments)]
pub(crate) fn build_router_with_oidc_service(
    health: HealthService,
    auth: AuthService,
    invitations: InvitationHttpService,
    organizations: OrganizationHttpService,
    projects: ProjectHttpService,
    save: SaveHttpService,
    setup: SetupStatusService,
    admin: AdminHttpService,
    teams: TeamHttpService,
    mfa: MfaHttpService,
    notifications: NotificationHttpService,
    access_tokens: AccessTokenManagementService,
    oidc: OidcHttpService,
) -> Router {
    build_router_with_registry_service(
        health,
        auth,
        invitations,
        organizations,
        projects,
        save,
        setup,
        admin,
        teams,
        mfa,
        notifications,
        access_tokens,
        oidc,
        RegistryHttpService::unconfigured(),
    )
}

#[allow(clippy::too_many_arguments)]
pub(crate) fn build_router_with_registry_service(
    health: HealthService,
    auth: AuthService,
    invitations: InvitationHttpService,
    organizations: OrganizationHttpService,
    projects: ProjectHttpService,
    save: SaveHttpService,
    setup: SetupStatusService,
    admin: AdminHttpService,
    teams: TeamHttpService,
    mfa: MfaHttpService,
    notifications: NotificationHttpService,
    access_tokens: AccessTokenManagementService,
    oidc: OidcHttpService,
    registry: RegistryHttpService,
) -> Router {
    build_router_with_published_example_service(
        health,
        auth,
        invitations,
        organizations,
        projects,
        save,
        setup,
        admin,
        teams,
        mfa,
        notifications,
        access_tokens,
        oidc,
        registry,
        PublishedExampleHttpService::unconfigured(),
    )
}

#[allow(clippy::too_many_arguments)]
pub(crate) fn build_router_with_published_example_service(
    health: HealthService,
    auth: AuthService,
    invitations: InvitationHttpService,
    organizations: OrganizationHttpService,
    projects: ProjectHttpService,
    save: SaveHttpService,
    setup: SetupStatusService,
    admin: AdminHttpService,
    teams: TeamHttpService,
    mfa: MfaHttpService,
    notifications: NotificationHttpService,
    access_tokens: AccessTokenManagementService,
    oidc: OidcHttpService,
    registry: RegistryHttpService,
    published_examples: PublishedExampleHttpService,
) -> Router {
    build_router_with_git_service(
        health,
        auth,
        invitations,
        organizations,
        projects,
        save,
        setup,
        admin,
        teams,
        mfa,
        notifications,
        access_tokens,
        oidc,
        registry,
        published_examples,
        GitHttpService::unconfigured(),
    )
}

#[allow(clippy::too_many_arguments)]
pub(crate) fn build_router_with_git_service(
    health: HealthService,
    auth: AuthService,
    invitations: InvitationHttpService,
    organizations: OrganizationHttpService,
    projects: ProjectHttpService,
    save: SaveHttpService,
    setup: SetupStatusService,
    admin: AdminHttpService,
    teams: TeamHttpService,
    mfa: MfaHttpService,
    notifications: NotificationHttpService,
    access_tokens: AccessTokenManagementService,
    oidc: OidcHttpService,
    registry: RegistryHttpService,
    published_examples: PublishedExampleHttpService,
    git: GitHttpService,
) -> Router {
    build_router_with_integration_ca_service(
        health,
        auth,
        invitations,
        organizations,
        projects,
        save,
        setup,
        admin,
        teams,
        mfa,
        notifications,
        access_tokens,
        oidc,
        registry,
        published_examples,
        git,
        IntegrationCaHttpService::unconfigured(),
    )
}

#[allow(clippy::too_many_arguments)]
pub(crate) fn build_router_with_integration_ca_service(
    health: HealthService,
    auth: AuthService,
    invitations: InvitationHttpService,
    organizations: OrganizationHttpService,
    projects: ProjectHttpService,
    save: SaveHttpService,
    setup: SetupStatusService,
    admin: AdminHttpService,
    teams: TeamHttpService,
    mfa: MfaHttpService,
    notifications: NotificationHttpService,
    access_tokens: AccessTokenManagementService,
    oidc: OidcHttpService,
    registry: RegistryHttpService,
    published_examples: PublishedExampleHttpService,
    git: GitHttpService,
    integration_ca: IntegrationCaHttpService,
) -> Router {
    let enforcement = mfa.clone();
    let api = openapi::router_with_integration_ca(
        auth,
        invitations,
        organizations,
        projects,
        save,
        setup,
        admin,
        teams,
        mfa,
        notifications,
        access_tokens,
        oidc,
        registry,
        published_examples,
        git,
        integration_ca,
    )
    .layer(middleware::from_fn(move |request, next| {
        enforce_mfa_deadline(enforcement.clone(), request, next)
    }));
    api.merge(health.router())
        .fallback(not_found)
        .method_not_allowed_fallback(method_not_allowed)
        .layer(middleware::from_fn(ensure_api_cache_policy))
        .layer(middleware::from_fn(propagate_request_id))
}

pub(crate) fn apply_metrics(router: Router, metrics: MetricsService) -> Router {
    router.layer(middleware::from_fn(move |request, next| {
        observe_http(metrics.clone(), request, next)
    }))
}

pub(crate) fn apply_maintenance_gate(router: Router, gate: MaintenanceGate) -> Router {
    router.layer(middleware::from_fn(move |request, next| {
        enforce_maintenance(gate.clone(), request, next)
    }))
}

async fn enforce_maintenance(gate: MaintenanceGate, request: Request, next: Next) -> Response {
    if request.uri().path() == "/api/v1/admin/maintenance" {
        return next.run(request).await;
    }
    if matches!(
        *request.method(),
        Method::GET | Method::HEAD | Method::OPTIONS
    ) {
        return next.run(request).await;
    }
    let path = request.uri().path().to_owned();
    let request_id = request
        .extensions()
        .get::<RequestId>()
        .cloned()
        .unwrap_or_else(RequestId::generate);
    let Ok(_permit) = gate.try_enter_write() else {
        let mut response = private_problem(HttpError::service_unavailable(request_id, path));
        response
            .headers_mut()
            .insert(RETRY_AFTER, HeaderValue::from_static("30"));
        return response;
    };
    next.run(request).await
}

async fn ensure_api_cache_policy(request: Request, next: Next) -> Response {
    let private_api = request.uri().path().starts_with("/api/v1/");
    let mut response = next.run(request).await;
    if private_api && !response.headers().contains_key(CACHE_CONTROL) {
        response
            .headers_mut()
            .insert(CACHE_CONTROL, HeaderValue::from_static("private, no-store"));
    }
    response
}

async fn enforce_mfa_deadline(service: MfaHttpService, request: Request, next: Next) -> Response {
    let path = request.uri().path().to_owned();
    let request_id = request
        .extensions()
        .get::<RequestId>()
        .cloned()
        .unwrap_or_else(RequestId::generate);
    let allowed = mfa_deadline_exempt(request.method(), &path);
    if allowed {
        return next.run(request).await;
    }
    let cookies = match request
        .headers()
        .get_all(axum::http::header::COOKIE)
        .iter()
        .map(|value| value.to_str())
        .collect::<Result<Vec<_>, _>>()
    {
        Ok(cookies) if !cookies.is_empty() => cookies,
        _ => return next.run(request).await,
    };
    let status = service
        .status(BrowserRequestHeaders {
            method: BrowserMethod::Get,
            origins: &[],
            cookie_headers: &cookies,
            csrf_headers: &[],
        })
        .await;
    match status {
        Ok(view) if view.restricted => private_problem(HttpError::forbidden(request_id, path)),
        Ok(_) => next.run(request).await,
        Err(MfaHttpServiceError::AuthenticationFailed | MfaHttpServiceError::Forbidden) => {
            // Missing, invalid, or expired authentication still belongs to the
            // endpoint's normal authentication boundary.
            next.run(request).await
        }
        Err(_) => private_problem(HttpError::service_unavailable(request_id, path)),
    }
}

fn mfa_deadline_exempt(method: &Method, path: &str) -> bool {
    let public_published_example_read = matches!(*method, Method::GET | Method::HEAD)
        && (path == "/api/v1/published-examples"
            || path.starts_with("/api/v1/published-examples/"));
    path == "/api/v1/me"
        || path == "/api/v1/auth/session"
        || path.starts_with("/api/v1/auth/oidc")
        || public_published_example_read
        || path.starts_with("/api/v1/mfa")
}

fn private_problem(error: HttpError) -> Response {
    let mut response = error.into_response();
    response
        .headers_mut()
        .insert(CACHE_CONTROL, HeaderValue::from_static("private, no-store"));
    response
}

async fn not_found(uri: Uri, Extension(request_id): Extension<RequestId>) -> HttpError {
    HttpError::not_found(request_id, uri.path())
}

async fn method_not_allowed(uri: Uri, Extension(request_id): Extension<RequestId>) -> HttpError {
    HttpError::method_not_allowed(request_id, uri.path())
}

#[cfg(test)]
mod tests {
    use super::*;
    use axum::body::{Body, to_bytes};
    use axum::http::{Request, StatusCode, header::CACHE_CONTROL};
    use tower::ServiceExt;

    #[tokio::test]
    async fn maintenance_gate_allows_reads_and_rejects_new_mutations() {
        let gate = MaintenanceGate::default();
        gate.enter_maintenance(std::time::Duration::from_secs(1))
            .await
            .unwrap();
        let router = apply_maintenance_gate(
            Router::new().route(
                "/api/v1/resource",
                axum::routing::get(|| async { StatusCode::OK })
                    .post(|| async { StatusCode::NO_CONTENT }),
            ),
            gate,
        );
        let read = router
            .clone()
            .oneshot(
                Request::builder()
                    .uri("/api/v1/resource")
                    .body(Body::empty())
                    .unwrap(),
            )
            .await
            .unwrap();
        assert_eq!(read.status(), StatusCode::OK);

        let write = router
            .oneshot(
                Request::builder()
                    .method(Method::POST)
                    .uri("/api/v1/resource")
                    .body(Body::empty())
                    .unwrap(),
            )
            .await
            .unwrap();
        assert_eq!(write.status(), StatusCode::SERVICE_UNAVAILABLE);
        assert_eq!(write.headers()[RETRY_AFTER], "30");
    }

    #[test]
    fn public_example_reads_bypass_mfa_deadline_but_fork_mutations_do_not() {
        let path = "/api/v1/published-examples/opaque/forks";
        assert!(mfa_deadline_exempt(&Method::GET, path));
        assert!(mfa_deadline_exempt(&Method::HEAD, path));
        assert!(!mfa_deadline_exempt(&Method::POST, path));
    }

    #[tokio::test]
    async fn authenticated_status_failure_blocks_protected_api_fail_closed() {
        let response = build_router()
            .oneshot(
                Request::builder()
                    .uri("/api/v1/me/workspaces")
                    .header(axum::http::header::COOKIE, "nuriteo_dev_session=opaque")
                    .body(Body::empty())
                    .unwrap(),
            )
            .await
            .unwrap();
        assert_eq!(response.status(), StatusCode::SERVICE_UNAVAILABLE);
        assert_eq!(response.headers()[CACHE_CONTROL], "private, no-store");
        assert_eq!(
            response.headers()[axum::http::header::CONTENT_TYPE],
            "application/problem+json"
        );
        let body: serde_json::Value =
            serde_json::from_slice(&to_bytes(response.into_body(), 1024).await.unwrap()).unwrap();
        assert_eq!(body["code"], "SERVICE_UNAVAILABLE");
    }

    #[tokio::test]
    async fn api_errors_default_to_private_no_store() {
        let response = build_router()
            .oneshot(
                Request::builder()
                    .uri("/api/v1/does-not-exist")
                    .body(Body::empty())
                    .unwrap(),
            )
            .await
            .unwrap();
        assert_eq!(response.status(), StatusCode::NOT_FOUND);
        assert_eq!(response.headers()[CACHE_CONTROL], "private, no-store");
    }

    #[tokio::test]
    async fn explicit_api_cache_policy_is_preserved() {
        let response = Router::new()
            .route(
                "/api/v1/public",
                axum::routing::get(|| async {
                    let mut response = StatusCode::OK.into_response();
                    response.headers_mut().insert(
                        CACHE_CONTROL,
                        HeaderValue::from_static("public, max-age=60"),
                    );
                    response
                }),
            )
            .layer(middleware::from_fn(ensure_api_cache_policy))
            .oneshot(
                Request::builder()
                    .uri("/api/v1/public")
                    .body(Body::empty())
                    .unwrap(),
            )
            .await
            .unwrap();
        assert_eq!(response.headers()[CACHE_CONTROL], "public, max-age=60");
    }
}
