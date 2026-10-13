use axum::{Json, Router};
use serde::Serialize;
use utoipa::Modify;
use utoipa::openapi::security::{ApiKey, ApiKeyValue, HttpAuthScheme, HttpBuilder, SecurityScheme};
use utoipa::{OpenApi, ToSchema};
use utoipa_axum::routes;
use utoipa_swagger_ui::{Config, SwaggerUi};

use crate::VERSION;
use crate::access_token::{self, AccessTokenManagementService};
use crate::admin::{self, AdminHttpService};
use crate::auth::{self, AuthService};
use crate::git_operations::{self, GitHttpService};
use crate::integration_ca::{self, IntegrationCaHttpService};
use crate::invitations::{self, InvitationHttpService};
use crate::mfa::{self, MfaHttpService};
use crate::notification::{self, NotificationHttpService};
use crate::oidc::{self, OidcHttpService};
use crate::organization::{self, OrganizationHttpService};
use crate::project::{self, ProjectHttpService};
use crate::published_example::{self, PublishedExampleHttpService};
use crate::registry_gateway::{self, RegistryHttpService};
use crate::save::{self, SaveHttpService};
use crate::setup::{self, SetupStatusService};
use crate::team::{self, TeamHttpService};
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
        (name = "mfa", description = "Local account multi-factor authentication and administrator enforcement policy"),
        (name = "notifications", description = "Notification inbox, channel preferences, and administrator delivery operations"),
        (name = "workspaces", description = "Authenticated Workspace projections"),
        (name = "invitations", description = "Administrator invitation and public account activation lifecycle"),
        (name = "organizations", description = "Authenticated Organization lifecycle and membership administration"),
        (name = "organization-invitations", description = "Role-bound Organization invitation lifecycle")
        ,(name = "projects", description = "Workspace-owned Project lifecycle")
        ,(name = "project-roles", description = "Organization Project direct role administration")
        ,(name = "project-versions", description = "Immutable named Project Working Head references")
        ,(name = "project-history", description = "Recovery Checkpoints and atomic historical Working Head promotion")
        ,(name = "save", description = "Bounded Project Bundle Save session lifecycle")
        ,(name = "administration", description = "Instance administrator settings, operational status, and audit operations")
        ,(name = "teams", description = "Organization Team lifecycle")
        ,(name = "team-members", description = "Team membership administration")
        ,(name = "team-project-roles", description = "Team-to-Project role administration")
        ,(name = "access-tokens", description = "Copy-once Personal and Project Automation Token lifecycle")
        ,(name = "oidc", description = "OIDC sign-in and linked identity lifecycle")
        ,(name = "oidc-administration", description = "Instance-wide OIDC Provider administration")
        ,(name = "registry-administration", description = "Instance-wide package registry routing and credential administration")
        ,(name = "published-examples", description = "Immutable Project Version publication and public discovery")
        ,(name = "git", description = "User Git credentials and bounded Project remote operations")
        ,(name = "git-administration", description = "Instance-wide Git Provider administration")
        ,(name = "integration-ca-administration", description = "Custom CA candidate validation and activation for outbound integrations")
    ),
    servers((url = "/", description = "Current self-hosted instance"))
)]
struct ApiDocument;

const PROJECT_SESSION_SCHEME: &str = "projectSessionCookie";
const ACCESS_TOKEN_BEARER_SCHEME: &str = "accessTokenBearer";

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
        components.add_security_scheme(
            ACCESS_TOKEN_BEARER_SCHEME,
            SecurityScheme::Http(
                HttpBuilder::new()
                    .scheme(HttpAuthScheme::Bearer)
                    .bearer_format("NURITEO Personal or Project Automation Token")
                    .description(Some(
                        "Copy-once token. Endpoint authorization is the intersection of token scope, live user/Project access, and Project lifecycle state.",
                    ))
                    .build(),
            ),
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
        SaveHttpService::unconfigured(),
        SetupStatusService::unconfigured(),
        AdminHttpService::unconfigured(),
        TeamHttpService::unconfigured(),
        MfaHttpService::unconfigured(),
        NotificationHttpService::unconfigured(),
        AccessTokenManagementService::unconfigured(),
        OidcHttpService::unconfigured(),
        RegistryHttpService::unconfigured(),
        PublishedExampleHttpService::unconfigured(),
        GitHttpService::unconfigured(),
        IntegrationCaHttpService::unconfigured(),
    )
    .1
}

#[allow(
    clippy::too_many_arguments,
    reason = "top-level composition keeps independently testable HTTP services explicit"
)]
pub fn router(
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
    router_with_access_tokens(
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

#[allow(
    clippy::too_many_arguments,
    reason = "top-level composition keeps independently testable HTTP services explicit"
)]
pub(crate) fn router_with_access_tokens(
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
    router_with_oidc(
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

#[allow(
    clippy::too_many_arguments,
    reason = "top-level composition keeps independently testable HTTP services explicit"
)]
pub(crate) fn router_with_oidc(
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
    router_with_registry(
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
pub(crate) fn router_with_registry(
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
    router_with_published_examples(
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
pub(crate) fn router_with_published_examples(
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
    router_with_git(
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
pub(crate) fn router_with_git(
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
    router_with_integration_ca(
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
pub(crate) fn router_with_integration_ca(
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
    let (api_routes, document) = openapi_parts(
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
    );
    let config = Config::new([DOCUMENT_PATH]).validator_url("none");
    let docs = SwaggerUi::new(DOCS_PATH)
        .url(DOCUMENT_PATH, document)
        .config(config);

    api_routes.merge(Router::from(docs))
}

#[allow(
    clippy::too_many_arguments,
    reason = "OpenAPI composition mirrors the explicit runtime service graph"
)]
fn openapi_parts(
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
    let (save_routes, document) = save::openapi_router(document)
        .with_state(save)
        .split_for_parts();
    let (setup_routes, document) = setup::openapi_router(document)
        .with_state(setup)
        .split_for_parts();
    let (admin_routes, document) = admin::openapi_router(document)
        .with_state(admin)
        .split_for_parts();
    let (team_routes, document) = team::openapi_router(document)
        .with_state(teams)
        .split_for_parts();
    let (mfa_routes, document) = mfa::openapi_router(document)
        .with_state(mfa)
        .split_for_parts();
    let (notification_routes, document) = notification::openapi_router(document)
        .with_state(notifications)
        .split_for_parts();
    let (access_token_routes, document) = access_token::openapi_router(document)
        .with_state(access_tokens)
        .split_for_parts();
    let (oidc_routes, document) = oidc::openapi_router(document)
        .with_state(oidc)
        .split_for_parts();
    let (registry_routes, document) = registry_gateway::openapi_router(document)
        .with_state(registry)
        .split_for_parts();
    let (published_example_routes, document) = published_example::openapi_router(document)
        .with_state(published_examples)
        .split_for_parts();
    let (git_routes, document) = git_operations::openapi_router(document)
        .with_state(git)
        .split_for_parts();
    let (integration_ca_routes, document) = integration_ca::openapi_router(document)
        .with_state(integration_ca)
        .split_for_parts();
    (
        auth_routes
            .merge(invitation_routes)
            .merge(organization_routes)
            .merge(project_routes)
            .merge(save_routes)
            .merge(setup_routes)
            .merge(admin_routes)
            .merge(team_routes)
            .merge(mfa_routes)
            .merge(notification_routes)
            .merge(access_token_routes)
            .merge(oidc_routes)
            .merge(registry_routes)
            .merge(published_example_routes)
            .merge(git_routes)
            .merge(integration_ca_routes),
        document,
    )
}
