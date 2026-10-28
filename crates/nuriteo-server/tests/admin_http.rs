use std::env;

use std::ffi::OsString;

use std::fs;

use std::io;

use std::path::Path;

use std::time::Duration;


use axum::Router;

use axum::body::{Body, to_bytes};

use axum::http::header::{CACHE_CONTROL, CONTENT_TYPE, COOKIE, ETAG, IF_MATCH, ORIGIN, SET_COOKIE};

use axum::http::{Method, Request, Response, StatusCode};

use base64::{Engine as _, engine::general_purpose::URL_SAFE_NO_PAD};

use nuriteo_server::admin::{AdminHttpPolicy, AdminHttpService};

use nuriteo_server::app::{MfaHttpService, build_router_with_mfa_service};

use nuriteo_server::audit::AuditEventId;

use nuriteo_server::auth::{AuthPolicy, AuthService};

use nuriteo_server::config::{Environment, FileReader, InstanceSettingBootstrap};

use nuriteo_server::database::{
    DatabasePool, DatabasePoolConfig, DatabaseTlsConfig, MigrationOptions, run_embedded_migrations,
};

use nuriteo_server::health::HealthService;

use nuriteo_server::identity::{SessionPolicy, UserId};

use nuriteo_server::instance_settings::InstanceSettingsRepository;

use nuriteo_server::integration::MasterKeyring;

use nuriteo_server::invitations::InvitationHttpService;

use nuriteo_server::organization::OrganizationHttpService;

use nuriteo_server::project::ProjectHttpService;

use nuriteo_server::save::{CleanupOperationsPolicy, CleanupOperationsService, SaveHttpService};

use nuriteo_server::setup::SetupStatusService;

use nuriteo_server::team::TeamHttpService;

use serde_json::{Value, json};

use tower::ServiceExt;

use url::Url;


const DATABASE_URL_ENV: &str = "NURITEO_TEST_DATABASE_URL";

const DATABASE_CA_ENV: &str = "NURITEO_TEST_DATABASE_CA";

const ORIGIN_VALUE: &str = "http://localhost:3000";

const REQUEST_ID: &str = "request:admin-http-fixture";

const PASSWORD: &str = "correct horse battery staple";

const PASSWORD_HASH: &str = "$argon2id$v=19$m=19456,t=2,p=1$a25vd24tc2FsdC12YWx1ZQ$yERZcGD1B/gLkNTYDHwutSjFbbs93oG/oqH/OErHrm0";

const SETTING_PATH: &str = "/api/v1/admin/settings/invitations.default_expiry_hours";


#[derive(Clone)]
struct Browser {
    cookie: String,
    csrf: String,
}


#[derive(Clone)]
struct TestEnvironment(Vec<(OsString, OsString)>);


struct NoFiles;

#[path = "admin_http/settings.rs"]
mod settings;
pub(crate) use settings::*;
#[path = "admin_http/audit.rs"]
mod audit;
pub(crate) use audit::*;
