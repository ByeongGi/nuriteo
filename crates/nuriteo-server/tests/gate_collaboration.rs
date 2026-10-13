#![cfg(unix)]

use std::env;
use std::ffi::OsString;
use std::fs;
use std::io::Read;
use std::net::{SocketAddr, TcpListener};
use std::process::{Child, Command, ExitStatus, Output, Stdio};
use std::thread::{self, JoinHandle};
use std::time::{Duration, Instant};

use aws_sdk_s3::config::{BehaviorVersion, Credentials, Region};
use aws_smithy_http_client::pool::{Client as PoolClient, ConnectionPool};
use aws_smithy_http_client::tls::rustls_provider::CryptoMode;
use aws_smithy_http_client::tls::{self, TlsContext, TrustStore};
use nuriteo_server::config::{Environment, SystemFileReader};
use nuriteo_server::database::{
    DatabasePool, DatabasePoolConfig, DatabaseTlsConfig, MigrationOptions, MigrationReport,
    run_embedded_migrations,
};
use nuriteo_server::object_storage::{ObjectStorageConfig, OperationLimits, S3ObjectStore};
use reqwest::header::{CONTENT_TYPE, COOKIE, ETAG, IF_MATCH, LOCATION, ORIGIN, SET_COOKIE};
use reqwest::{Client, Method, Response, StatusCode};
use serde_json::{Value, json};
use url::Url;

const DATABASE_URL_ENV: &str = "NURITEO_TEST_DATABASE_URL";
const DATABASE_CA_ENV: &str = "NURITEO_TEST_DATABASE_CA";
const S3_ENDPOINT_ENV: &str = "NURITEO_TEST_S3_ENDPOINT";
const S3_CA_ENV: &str = "NURITEO_TEST_S3_CA_FILE";
const BOOTSTRAP_PASSWORD_FILE_ENV: &str = "NURITEO_TEST_BOOTSTRAP_PASSWORD_FILE";
const SAVE_IDEMPOTENCY_SECRET_FILE_ENV: &str = "NURITEO_TEST_SAVE_IDEMPOTENCY_SECRET_FILE";
const GATE_PROJECT_RUNTIME_BROWSER_ENV: &str = "NURITEO_TEST_GATE_PROJECT_RUNTIME_BROWSER";
const NODE_EXECUTABLE_ENV: &str = "NURITEO_TEST_NODE_EXECUTABLE";
const BOOTSTRAP_PASSWORD: &str = "gate bootstrap password 0123456789";
const INVITEE_PASSWORD: &str = "gate invitee password 0123456789";
const ACCESS_KEY: &str = "integration-access";
const SECRET_KEY: &str = "integration-secret-0123456789";
const BUCKET: &str = "nuriteo-gate-002";
const MAX_PROCESS_OUTPUT_BYTES: usize = 1024 * 1024;

#[tokio::test]
#[ignore = "requires the GATE-002 custom-CA PostgreSQL and HTTPS RustFS fixture"]
async fn collaboration_gate_runs_actual_core_postgres_and_rustfs_journey() {
    let database_url = required_env(DATABASE_URL_ENV);
    let database_ca_path = required_env(DATABASE_CA_ENV);
    let s3_endpoint = required_env(S3_ENDPOINT_ENV);
    let s3_ca_path = required_env(S3_CA_ENV);
    let password_file = required_env(BOOTSTRAP_PASSWORD_FILE_ENV);
    let save_secret_file = required_env(SAVE_IDEMPOTENCY_SECRET_FILE_ENV);
    let pool = database_pool(&database_url, &database_ca_path).await;

    reset_schema(&pool).await;
    let migration = run_embedded_migrations(
        &pool,
        MigrationOptions::new(Duration::from_secs(5), Duration::from_secs(30)).unwrap(),
    )
    .await
    .unwrap();
    assert_current_embedded_migrations(migration);
    assert_eq!(active_administrator_count(&pool).await, 0);

    let address = available_address();
    let external_url = format!("http://{address}");
    let created = bootstrap_admin(
        &database_url,
        &database_ca_path,
        &password_file,
        &external_url,
    );
    assert_safe_bootstrap(&created, b"bootstrap-admin created\n");
    let repeated = bootstrap_admin(
        &database_url,
        &database_ca_path,
        &password_file,
        &external_url,
    );
    assert_safe_bootstrap(&repeated, b"bootstrap-admin already-initialized\n");
    assert_eq!(active_administrator_count(&pool).await, 1);

    let s3 = fixture_s3_client(&s3_endpoint, &fs::read(&s3_ca_path).unwrap());
    create_bucket(&s3).await;
    let store = object_store(&s3_endpoint, &s3_ca_path).await;
    store.check_readiness().await.unwrap();
    store
        .configure_browser_upload_cors(&Url::parse(&external_url).unwrap())
        .await
        .unwrap();

    let mut server = spawn_server(
        address,
        &database_url,
        &database_ca_path,
        &s3_endpoint,
        &s3_ca_path,
        &save_secret_file,
    );
    let client = Client::builder()
        .no_proxy()
        .timeout(Duration::from_secs(5))
        .build()
        .unwrap();
    wait_for_live(&mut server, &client, &external_url).await;
    assert_status(
        client
            .get(format!("{external_url}/health/ready"))
            .send()
            .await
            .unwrap(),
        StatusCode::OK,
    )
    .await;
    let setup = response_json(
        client
            .get(format!("{external_url}/api/v1/setup/status"))
            .send()
            .await
            .unwrap(),
    )
    .await;
    assert_eq!(setup, json!({"bootstrapRequired": false}));

    let admin = login(
        &client,
        &external_url,
        "admin@example.test",
        BOOTSTRAP_PASSWORD,
    )
    .await;
    let admin_me = get_json(&client, &external_url, "/api/v1/me", &admin).await;
    assert_eq!(admin_me["user"]["is_instance_admin"], true);
    let admin_id = admin_me["user"]["id"].as_str().unwrap().to_owned();
    let admin_workspaces = workspaces(&client, &external_url, &admin).await;
    assert_personal_only(&admin_workspaces, &admin_id);

    let activation = browser_json(
        &client,
        &external_url,
        Method::POST,
        "/api/v1/admin/activation-invitations",
        &admin,
        Some(json!({"email":"member@example.test"})),
        None,
    )
    .await;
    assert_eq!(activation.status(), StatusCode::CREATED);
    let activation = response_json(activation).await;
    let activation_url = activation["activation_url"].as_str().unwrap();
    let activation_token = query_token(activation_url);
    let activation_id = activation["id"].as_str().unwrap().to_owned();

    let listed = get_json(
        &client,
        &external_url,
        "/api/v1/admin/activation-invitations",
        &admin,
    )
    .await;
    let listed = listed.to_string();
    assert!(!listed.contains(&activation_token));
    assert!(!listed.contains("activation_url"));

    let revoked = browser_json(
        &client,
        &external_url,
        Method::POST,
        "/api/v1/admin/activation-invitations",
        &admin,
        Some(json!({"email":"revoked@example.test"})),
        None,
    )
    .await;
    assert_eq!(revoked.status(), StatusCode::CREATED);
    let revoked = response_json(revoked).await;
    let revoked_token = query_token(revoked["activation_url"].as_str().unwrap());
    let revoked_id = revoked["id"].as_str().unwrap();
    let revoked_response = browser_json(
        &client,
        &external_url,
        Method::DELETE,
        &format!("/api/v1/admin/activation-invitations/{revoked_id}"),
        &admin,
        None,
        None,
    )
    .await;
    assert_eq!(revoked_response.status(), StatusCode::NO_CONTENT);
    let revoked_activation = public_json(
        &client,
        &external_url,
        "/api/v1/auth/activation",
        json!({
            "token": revoked_token,
            "email": "revoked@example.test",
            "display_name": "Revoked User",
            "password": INVITEE_PASSWORD
        }),
    )
    .await;
    assert_safe_problem(revoked_activation, StatusCode::UNPROCESSABLE_ENTITY).await;

    let expired = browser_json(
        &client,
        &external_url,
        Method::POST,
        "/api/v1/admin/activation-invitations",
        &admin,
        Some(json!({"email":"expired@example.test"})),
        None,
    )
    .await;
    assert_eq!(expired.status(), StatusCode::CREATED);
    let expired = response_json(expired).await;
    let expired_token = query_token(expired["activation_url"].as_str().unwrap());
    expire_activation(&pool, expired["id"].as_str().unwrap()).await;
    let expired_activation = public_json(
        &client,
        &external_url,
        "/api/v1/auth/activation",
        json!({
            "token": expired_token,
            "email": "expired@example.test",
            "display_name": "Expired User",
            "password": INVITEE_PASSWORD
        }),
    )
    .await;
    assert_safe_problem(expired_activation, StatusCode::UNPROCESSABLE_ENTITY).await;

    let activated = public_json(
        &client,
        &external_url,
        "/api/v1/auth/activation",
        json!({
            "token": activation_token,
            "email": "member@example.test",
            "display_name": "Invited Member",
            "password": INVITEE_PASSWORD
        }),
    )
    .await;
    assert_eq!(activated.status(), StatusCode::NO_CONTENT);
    assert_eq!(activated.headers().get_all(SET_COOKIE).iter().count(), 0);

    let replay = public_json(
        &client,
        &external_url,
        "/api/v1/auth/activation",
        json!({
            "token": activation_token,
            "email": "member@example.test",
            "display_name": "Invited Member",
            "password": INVITEE_PASSWORD
        }),
    )
    .await;
    assert_safe_problem(replay, StatusCode::UNPROCESSABLE_ENTITY).await;

    let invitee = login(
        &client,
        &external_url,
        "member@example.test",
        INVITEE_PASSWORD,
    )
    .await;
    let invitee_me = get_json(&client, &external_url, "/api/v1/me", &invitee).await;
    let invitee_id = invitee_me["user"]["id"].as_str().unwrap().to_owned();
    assert_ne!(admin.cookie, invitee.cookie);
    assert_personal_only(
        &workspaces(&client, &external_url, &invitee).await,
        &invitee_id,
    );

    let created = browser_json(
        &client,
        &external_url,
        Method::POST,
        "/api/v1/organizations",
        &admin,
        Some(json!({"slug":"gate-team","displayName":"Gate Team"})),
        None,
    )
    .await;
    assert_eq!(created.status(), StatusCode::CREATED);
    assert_eq!(created.headers()[ETAG], "\"org-v1\"");
    let organization_path = created.headers()[LOCATION].to_str().unwrap().to_owned();
    let organization = response_json(created).await;
    let organization_id = organization["id"].as_str().unwrap().to_owned();

    let stale = browser_json(
        &client,
        &external_url,
        Method::PATCH,
        &organization_path,
        &admin,
        Some(json!({"displayName":"Stale Name"})),
        Some("\"org-v0\""),
    )
    .await;
    assert_safe_problem(stale, StatusCode::PRECONDITION_FAILED).await;

    let members_path = format!("{organization_path}/members");
    let last_owner = browser_json(
        &client,
        &external_url,
        Method::DELETE,
        &format!("{members_path}/{admin_id}"),
        &admin,
        None,
        None,
    )
    .await;
    assert_safe_problem(last_owner, StatusCode::CONFLICT).await;

    let invitations_path = format!("{organization_path}/invitations");
    let issued = browser_json(
        &client,
        &external_url,
        Method::POST,
        &invitations_path,
        &admin,
        Some(json!({"email":"member@example.test","role":"member"})),
        None,
    )
    .await;
    assert_eq!(issued.status(), StatusCode::CREATED);
    let issued = response_json(issued).await;
    let first_org_token = query_token(issued["acceptUrl"].as_str().unwrap());
    let org_invitation_id = issued["id"].as_str().unwrap().to_owned();

    let replacement = browser_json(
        &client,
        &external_url,
        Method::POST,
        &format!("{invitations_path}/{org_invitation_id}/reissue"),
        &admin,
        Some(json!({"role":"member"})),
        None,
    )
    .await;
    assert_eq!(replacement.status(), StatusCode::OK);
    let replacement = response_json(replacement).await;
    let replacement_token = query_token(replacement["acceptUrl"].as_str().unwrap());
    assert_ne!(first_org_token, replacement_token);

    let superseded = browser_json(
        &client,
        &external_url,
        Method::POST,
        "/api/v1/me/organization-invitations/accept",
        &invitee,
        Some(json!({"token":first_org_token})),
        None,
    )
    .await;
    assert_safe_problem(superseded, StatusCode::CONFLICT).await;

    let accepted = browser_json(
        &client,
        &external_url,
        Method::POST,
        "/api/v1/me/organization-invitations/accept",
        &invitee,
        Some(json!({"token":replacement_token})),
        None,
    )
    .await;
    assert_eq!(accepted.status(), StatusCode::OK);
    let accepted_body = response_json(accepted).await;
    assert_eq!(accepted_body["status"], "accepted");

    let replay = browser_json(
        &client,
        &external_url,
        Method::POST,
        "/api/v1/me/organization-invitations/accept",
        &invitee,
        Some(json!({"token":replacement_token})),
        None,
    )
    .await;
    assert_safe_problem(replay, StatusCode::CONFLICT).await;

    let visible = workspaces(&client, &external_url, &invitee).await;
    let visible = visible["workspaces"].as_array().unwrap();
    assert_eq!(visible.len(), 2);
    assert!(visible.iter().any(|workspace| {
        workspace["ownerType"] == "organization" && workspace["ownerId"] == organization_id
    }));
    assert_eq!(
        workspaces(&client, &external_url, &admin).await["workspaces"]
            .as_array()
            .unwrap()
            .len(),
        2
    );

    let forbidden = browser_json(
        &client,
        &external_url,
        Method::POST,
        &invitations_path,
        &invitee,
        Some(json!({"email":"admin@example.test","role":"member"})),
        None,
    )
    .await;
    assert_safe_problem(forbidden, StatusCode::NOT_FOUND).await;

    let invitation_list = get_json(&client, &external_url, &invitations_path, &admin).await;
    let invitation_list = invitation_list.to_string();
    for secret in [&first_org_token, &replacement_token] {
        assert!(!invitation_list.contains(secret));
    }
    assert!(!invitation_list.contains("acceptUrl"));

    assert_durable_state_is_secret_free(
        &pool,
        &[
            BOOTSTRAP_PASSWORD,
            INVITEE_PASSWORD,
            &activation_token,
            &revoked_token,
            &expired_token,
            &first_org_token,
            &replacement_token,
        ],
    )
    .await;
    assert_required_audits(&pool).await;
    assert_eq!(activation_status(&pool, &activation_id).await, "accepted");

    let output = server.terminate(Duration::from_secs(5)).await;
    assert!(output.status.success());
    assert!(output.stdout.is_empty());
    assert!(output.stderr.is_empty());
    assert!(
        !output.secret_detected,
        "actual Core output leaked a credential"
    );

    s3.delete_bucket().bucket(BUCKET).send().await.unwrap();
    reset_schema(&pool).await;
    pool.close(Duration::from_secs(2)).await.unwrap();
}

#[tokio::test]
#[ignore = "requires the GATE-003 custom-CA PostgreSQL, HTTPS RustFS, production Web build and Chromium fixture"]
async fn project_runtime_gate_runs_actual_core_and_browser_journey() {
    let database_url = required_env(DATABASE_URL_ENV);
    let database_ca_path = required_env(DATABASE_CA_ENV);
    let s3_endpoint = required_env(S3_ENDPOINT_ENV);
    let s3_ca_path = required_env(S3_CA_ENV);
    let password_file = required_env(BOOTSTRAP_PASSWORD_FILE_ENV);
    let save_secret_file = required_env(SAVE_IDEMPOTENCY_SECRET_FILE_ENV);
    let browser_fixture = required_env(GATE_PROJECT_RUNTIME_BROWSER_ENV);
    let node_executable = required_env(NODE_EXECUTABLE_ENV);
    let pool = database_pool(&database_url, &database_ca_path).await;

    reset_schema(&pool).await;
    let migration = run_embedded_migrations(
        &pool,
        MigrationOptions::new(Duration::from_secs(5), Duration::from_secs(30)).unwrap(),
    )
    .await
    .unwrap();
    assert_current_embedded_migrations(migration);

    let core_address = available_address();
    let web_address = available_address();
    let core_url = format!("http://{core_address}");
    let web_origin = format!("http://localhost:{}", web_address.port());
    let created = bootstrap_admin(
        &database_url,
        &database_ca_path,
        &password_file,
        &web_origin,
    );
    assert_safe_bootstrap(&created, b"bootstrap-admin created\n");

    let s3 = fixture_s3_client(&s3_endpoint, &fs::read(&s3_ca_path).unwrap());
    create_bucket(&s3).await;
    let store = object_store(&s3_endpoint, &s3_ca_path).await;
    store.check_readiness().await.unwrap();
    store
        .configure_browser_upload_cors(&Url::parse(&web_origin).unwrap())
        .await
        .unwrap();

    let mut server = spawn_server_with_external_url(
        core_address,
        &web_origin,
        &database_url,
        &database_ca_path,
        &s3_endpoint,
        &s3_ca_path,
        &save_secret_file,
    );
    let client = Client::builder()
        .no_proxy()
        .timeout(Duration::from_secs(5))
        .build()
        .unwrap();
    wait_for_live(&mut server, &client, &core_url).await;

    let browser = Command::new(node_executable)
        .arg("--experimental-strip-types")
        .arg(&browser_fixture)
        .env("NURITEO_TEST_CORE_URL", &core_url)
        .env("NURITEO_TEST_WEB_PORT", web_address.port().to_string())
        .env("NURITEO_TEST_ADMIN_EMAIL", "admin@example.test")
        .env("NURITEO_TEST_ADMIN_PASSWORD", BOOTSTRAP_PASSWORD)
        .stdout(Stdio::piped())
        .stderr(Stdio::piped())
        .output()
        .unwrap();
    assert_process_output_secret_free(&browser, &[BOOTSTRAP_PASSWORD, &database_url, SECRET_KEY]);
    assert!(
        browser.status.success(),
        "GATE-003 browser failed\nstdout:\n{}\nstderr:\n{}",
        String::from_utf8_lossy(&browser.stdout),
        String::from_utf8_lossy(&browser.stderr)
    );
    assert!(
        String::from_utf8_lossy(&browser.stdout)
            .contains("GATE-003 actual aggregate browser journey ok"),
        "browser fixture did not emit its terminal success marker"
    );

    let project: (String, String, String) = sqlx::query_as(
        "SELECT project.name, project.slug, project.state::text FROM projects project \
         JOIN users owner ON owner.id = project.owner_user_id \
         WHERE owner.normalized_email = 'admin@example.test'",
    )
    .fetch_one(&mut *pool.acquire().await.unwrap())
    .await
    .unwrap();
    assert_eq!(
        project,
        (
            "GATE Runtime Project".into(),
            "gate-runtime".into(),
            "active".into()
        )
    );

    let stopped = server.terminate(Duration::from_secs(5)).await;
    assert!(stopped.status.success());
    assert!(
        !stopped.secret_detected,
        "Core output leaked a fixture credential"
    );
}

#[derive(Clone)]
struct Browser {
    cookie: String,
    csrf: String,
}

async fn login(client: &Client, base: &str, email: &str, password: &str) -> Browser {
    let response = client
        .post(format!("{base}/api/v1/auth/sessions"))
        .header(CONTENT_TYPE, "application/json")
        .header(ORIGIN, base)
        .body(serde_json::to_vec(&json!({"email":email,"password":password})).unwrap())
        .send()
        .await
        .unwrap();
    assert_eq!(response.status(), StatusCode::NO_CONTENT);
    let pairs = response
        .headers()
        .get_all(SET_COOKIE)
        .iter()
        .map(|value| {
            value
                .to_str()
                .unwrap()
                .split(';')
                .next()
                .unwrap()
                .to_owned()
        })
        .collect::<Vec<_>>();
    assert_eq!(pairs.len(), 2);
    let csrf = pairs
        .iter()
        .find_map(|pair| pair.strip_prefix("nuriteo_dev_csrf="))
        .unwrap()
        .to_owned();
    Browser {
        cookie: pairs.join("; "),
        csrf,
    }
}

async fn get_json(client: &Client, base: &str, path: &str, browser: &Browser) -> Value {
    let response = client
        .get(format!("{base}{path}"))
        .header(COOKIE, &browser.cookie)
        .send()
        .await
        .unwrap();
    assert_eq!(response.status(), StatusCode::OK);
    response_json(response).await
}

async fn workspaces(client: &Client, base: &str, browser: &Browser) -> Value {
    get_json(client, base, "/api/v1/me/workspaces", browser).await
}

fn assert_personal_only(workspaces: &Value, user_id: &str) {
    let workspaces = workspaces["workspaces"].as_array().unwrap();
    assert_eq!(workspaces.len(), 1);
    assert_eq!(workspaces[0]["ownerType"], "user");
    assert_eq!(workspaces[0]["ownerId"], user_id);
}

async fn public_json(client: &Client, base: &str, path: &str, body: Value) -> Response {
    client
        .post(format!("{base}{path}"))
        .header(CONTENT_TYPE, "application/json")
        .header(ORIGIN, base)
        .body(serde_json::to_vec(&body).unwrap())
        .send()
        .await
        .unwrap()
}

async fn browser_json(
    client: &Client,
    base: &str,
    method: Method,
    path: &str,
    browser: &Browser,
    body: Option<Value>,
    etag: Option<&str>,
) -> Response {
    let mut request = client
        .request(method, format!("{base}{path}"))
        .header(ORIGIN, base)
        .header(COOKIE, &browser.cookie)
        .header("x-csrf-token", &browser.csrf);
    if let Some(etag) = etag {
        request = request.header(IF_MATCH, etag);
    }
    if let Some(body) = body {
        request = request
            .header(CONTENT_TYPE, "application/json")
            .body(serde_json::to_vec(&body).unwrap());
    }
    request.send().await.unwrap()
}

async fn response_json(response: Response) -> Value {
    let bytes = response.bytes().await.unwrap();
    assert!(bytes.len() <= 1024 * 1024);
    serde_json::from_slice(&bytes).unwrap()
}

async fn assert_status(response: Response, expected: StatusCode) {
    assert_eq!(response.status(), expected);
    let bytes = response.bytes().await.unwrap();
    assert!(bytes.len() <= 1024 * 1024);
}

async fn assert_safe_problem(response: Response, expected: StatusCode) {
    assert_eq!(response.status(), expected);
    assert_eq!(
        response.headers()[CONTENT_TYPE]
            .to_str()
            .unwrap()
            .split(';')
            .next()
            .unwrap(),
        "application/problem+json"
    );
    let rendered = response_json(response).await.to_string();
    for forbidden in [
        BOOTSTRAP_PASSWORD,
        INVITEE_PASSWORD,
        "nrt_inv_",
        "nrt_org_inv_",
        "nuriteo_dev_session",
        "nuriteo_dev_csrf",
        "postgres://",
        SECRET_KEY,
    ] {
        assert!(!rendered.contains(forbidden), "problem leaked {forbidden}");
    }
}

fn query_token(url: &str) -> String {
    Url::parse(url)
        .unwrap()
        .query_pairs()
        .find_map(|(key, value)| (key == "token").then(|| value.into_owned()))
        .unwrap()
}

fn bootstrap_admin(
    database_url: &str,
    database_ca: &str,
    password_file: &str,
    external_url: &str,
) -> Output {
    Command::new(env!("CARGO_BIN_EXE_nuriteo-server"))
        .arg("bootstrap-admin")
        .env_clear()
        .env("NURITEO_EXTERNAL_URL", external_url)
        .env("NURITEO_DATABASE_URL", database_url)
        .env("NURITEO_DATABASE_CA_FILE", database_ca)
        .env("NURITEO_DATABASE_TLS_MODE", "verify-full")
        .env("NURITEO_DATABASE_MAX_CONNECTIONS", "2")
        .env("NURITEO_BOOTSTRAP_ADMIN_EMAIL", "admin@example.test")
        .env("NURITEO_BOOTSTRAP_ADMIN_NAME", "Gate Administrator")
        .env("NURITEO_BOOTSTRAP_ADMIN_PASSWORD_FILE", password_file)
        .stdout(Stdio::piped())
        .stderr(Stdio::piped())
        .output()
        .unwrap()
}

fn assert_safe_bootstrap(output: &Output, expected: &[u8]) {
    assert!(
        output.status.success(),
        "bootstrap-admin failed with {}: {}",
        output.status,
        String::from_utf8_lossy(&output.stderr)
    );
    assert_eq!(output.stdout, expected);
    assert!(output.stderr.is_empty());
    assert_process_output_secret_free(output, &[BOOTSTRAP_PASSWORD, "postgres://", SECRET_KEY]);
}

fn spawn_server(
    address: SocketAddr,
    database_url: &str,
    database_ca: &str,
    s3_endpoint: &str,
    s3_ca: &str,
    save_secret_file: &str,
) -> ChildGuard {
    spawn_server_with_external_url(
        address,
        &format!("http://{address}"),
        database_url,
        database_ca,
        s3_endpoint,
        s3_ca,
        save_secret_file,
    )
}

fn spawn_server_with_external_url(
    address: SocketAddr,
    external_url: &str,
    database_url: &str,
    database_ca: &str,
    s3_endpoint: &str,
    s3_ca: &str,
    save_secret_file: &str,
) -> ChildGuard {
    let save_secret = fs::read_to_string(save_secret_file).unwrap();
    let child = Command::new(env!("CARGO_BIN_EXE_nuriteo-server"))
        .arg("serve")
        .env_clear()
        .env("NURITEO_EXTERNAL_URL", external_url)
        .env("NURITEO_HTTP_LISTEN_ADDR", address.to_string())
        .env("NURITEO_SHUTDOWN_DRAIN_TIMEOUT_MS", "2000")
        .env("NURITEO_DATABASE_URL", database_url)
        .env("NURITEO_DATABASE_CA_FILE", database_ca)
        .env("NURITEO_DATABASE_TLS_MODE", "verify-full")
        .env("NURITEO_DATABASE_MIN_CONNECTIONS", "1")
        .env("NURITEO_DATABASE_MAX_CONNECTIONS", "8")
        .env("NURITEO_DATABASE_CONNECT_TIMEOUT_MS", "3000")
        .env("NURITEO_DATABASE_ACQUIRE_TIMEOUT_MS", "1000")
        .env("NURITEO_DATABASE_CLOSE_TIMEOUT_MS", "2000")
        .env("NURITEO_SAVE_IDEMPOTENCY_SECRET_FILE", save_secret_file)
        .env("NURITEO_SAVE_DEFAULT_QUOTA_BYTES", "10737418240")
        .env("NURITEO_SAVE_UPLOAD_TRANSPORT", "relay")
        .env("NURITEO_S3_ENDPOINT", s3_endpoint)
        .env("NURITEO_S3_REGION", "us-east-1")
        .env("NURITEO_S3_BUCKET", BUCKET)
        .env("NURITEO_S3_ADDRESSING_STYLE", "path")
        .env("NURITEO_S3_CREDENTIAL_PROVIDER", "static")
        .env("NURITEO_S3_ACCESS_KEY_ID", ACCESS_KEY)
        .env("NURITEO_S3_SECRET_ACCESS_KEY", SECRET_KEY)
        .env("NURITEO_S3_CA_FILE", s3_ca)
        .stdout(Stdio::piped())
        .stderr(Stdio::piped())
        .spawn()
        .unwrap();
    ChildGuard::new(
        child,
        &[
            BOOTSTRAP_PASSWORD,
            INVITEE_PASSWORD,
            "nrt_inv_",
            "nrt_org_inv_",
            SECRET_KEY,
            database_url,
            &save_secret,
        ],
    )
}

struct CapturedProcessOutput {
    status: ExitStatus,
    stderr: Vec<u8>,
    stdout: Vec<u8>,
    secret_detected: bool,
}

struct CapturedStream {
    diagnostic: Vec<u8>,
    secret_detected: bool,
}

struct ChildGuard {
    child: Child,
    reaped: bool,
    stderr: Option<JoinHandle<std::io::Result<CapturedStream>>>,
    stdout: Option<JoinHandle<std::io::Result<CapturedStream>>>,
}

impl ChildGuard {
    fn new(mut child: Child, forbidden: &[&str]) -> Self {
        let forbidden = forbidden
            .iter()
            .map(|value| value.as_bytes().to_vec())
            .collect::<Vec<_>>();
        let stdout = spawn_output_reader(child.stdout.take().unwrap(), forbidden.clone());
        let stderr = spawn_output_reader(child.stderr.take().unwrap(), forbidden);
        Self {
            child,
            reaped: false,
            stderr: Some(stderr),
            stdout: Some(stdout),
        }
    }

    async fn terminate(mut self, timeout: Duration) -> CapturedProcessOutput {
        let status = Command::new("kill")
            .args(["-TERM", &self.child.id().to_string()])
            .status()
            .unwrap();
        assert!(status.success());
        self.wait_for_exit(timeout).await
    }

    async fn wait_for_exit(&mut self, timeout: Duration) -> CapturedProcessOutput {
        let deadline = Instant::now() + timeout;
        let status = loop {
            if let Some(status) = self.child.try_wait().unwrap() {
                self.reaped = true;
                break status;
            }
            assert!(Instant::now() < deadline, "server shutdown timed out");
            tokio::time::sleep(Duration::from_millis(20)).await;
        };
        read_output(
            status,
            self.stdout.take().unwrap(),
            self.stderr.take().unwrap(),
        )
    }
}

impl Drop for ChildGuard {
    fn drop(&mut self) {
        if !self.reaped {
            let _ = self.child.kill();
            let _ = self.child.wait();
        }
        drain_output_reader(self.stdout.take());
        drain_output_reader(self.stderr.take());
    }
}

fn spawn_output_reader(
    mut stream: impl Read + Send + 'static,
    forbidden: Vec<Vec<u8>>,
) -> JoinHandle<std::io::Result<CapturedStream>> {
    thread::spawn(move || {
        let mut diagnostic = Vec::new();
        let mut chunk = [0_u8; 8192];
        let maximum_secret_length = forbidden.iter().map(Vec::len).max().unwrap_or(0);
        let mut suffix = Vec::new();
        let mut secret_detected = false;
        loop {
            let read = stream.read(&mut chunk)?;
            if read == 0 {
                break;
            }
            let mut searchable = Vec::with_capacity(suffix.len() + read);
            searchable.extend_from_slice(&suffix);
            searchable.extend_from_slice(&chunk[..read]);
            secret_detected |= forbidden
                .iter()
                .any(|secret| contains_bytes(&searchable, secret));
            let suffix_length = maximum_secret_length
                .saturating_sub(1)
                .min(searchable.len());
            suffix.clear();
            suffix.extend_from_slice(&searchable[searchable.len() - suffix_length..]);

            let remaining = MAX_PROCESS_OUTPUT_BYTES.saturating_sub(diagnostic.len());
            diagnostic.extend_from_slice(&chunk[..read.min(remaining)]);
        }
        Ok(CapturedStream {
            diagnostic,
            secret_detected,
        })
    })
}

fn contains_bytes(haystack: &[u8], needle: &[u8]) -> bool {
    !needle.is_empty()
        && haystack
            .windows(needle.len())
            .any(|window| window == needle)
}

fn drain_output_reader(reader: Option<JoinHandle<std::io::Result<CapturedStream>>>) {
    if let Some(reader) = reader {
        let _ = reader.join();
    }
}

fn read_output(
    status: ExitStatus,
    stdout: JoinHandle<std::io::Result<CapturedStream>>,
    stderr: JoinHandle<std::io::Result<CapturedStream>>,
) -> CapturedProcessOutput {
    let stdout = stdout.join().unwrap().unwrap();
    let stderr = stderr.join().unwrap().unwrap();
    CapturedProcessOutput {
        status,
        secret_detected: stdout.secret_detected || stderr.secret_detected,
        stdout: stdout.diagnostic,
        stderr: stderr.diagnostic,
    }
}

#[test]
fn process_output_scanner_reads_beyond_diagnostic_cap_and_across_chunks() {
    let secret = b"nrt_inv_split-across-the-reader-boundary".to_vec();
    let mut bytes = vec![b'x'; MAX_PROCESS_OUTPUT_BYTES + 8_175];
    bytes.extend_from_slice(&secret);
    let captured = spawn_output_reader(std::io::Cursor::new(bytes), vec![secret])
        .join()
        .unwrap()
        .unwrap();

    assert_eq!(captured.diagnostic.len(), MAX_PROCESS_OUTPUT_BYTES);
    assert!(captured.secret_detected);
}

async fn wait_for_live(child: &mut ChildGuard, client: &Client, base: &str) {
    let deadline = Instant::now() + Duration::from_secs(10);
    loop {
        assert!(
            child.child.try_wait().unwrap().is_none(),
            "actual Core exited before liveness"
        );
        if let Ok(response) = client.get(format!("{base}/health/live")).send().await
            && response.status() == StatusCode::OK
        {
            return;
        }
        assert!(Instant::now() < deadline, "actual Core startup timed out");
        tokio::time::sleep(Duration::from_millis(50)).await;
    }
}

fn available_address() -> SocketAddr {
    let listener = TcpListener::bind("127.0.0.1:0").unwrap();
    listener.local_addr().unwrap()
}

async fn database_pool(database_url: &str, ca_path: &str) -> DatabasePool {
    let tls = DatabaseTlsConfig::verify_full(None, Some(fs::read(ca_path).unwrap()), None).unwrap();
    DatabasePool::connect(
        DatabasePoolConfig::new(
            database_url.to_owned(),
            0,
            12,
            Duration::from_secs(5),
            Duration::from_secs(2),
            tls,
        )
        .unwrap(),
    )
    .await
    .unwrap()
}

async fn reset_schema(pool: &DatabasePool) {
    sqlx::raw_sql("DROP SCHEMA public CASCADE; CREATE SCHEMA public;")
        .execute(&mut *pool.acquire().await.unwrap())
        .await
        .unwrap();
}

async fn active_administrator_count(pool: &DatabasePool) -> i64 {
    sqlx::query_scalar("SELECT COUNT(*) FROM users WHERE is_instance_admin AND status = 'active'")
        .fetch_one(&mut *pool.acquire().await.unwrap())
        .await
        .unwrap()
}

async fn activation_status(pool: &DatabasePool, id: &str) -> String {
    sqlx::query_scalar("SELECT status FROM activation_invitations WHERE id = $1::uuid")
        .bind(id)
        .fetch_one(&mut *pool.acquire().await.unwrap())
        .await
        .unwrap()
}

async fn expire_activation(pool: &DatabasePool, id: &str) {
    let mut connection = pool.acquire().await.unwrap();
    sqlx::query(
        "ALTER TABLE activation_invitations DISABLE TRIGGER activation_invitations_forward_only_update",
    )
    .execute(&mut *connection)
    .await
    .unwrap();
    sqlx::query(
        "UPDATE activation_invitations SET created_at = transaction_timestamp() - INTERVAL '2 hours', \
         expires_at = transaction_timestamp() - INTERVAL '1 hour' WHERE id = $1::uuid",
    )
    .bind(id)
    .execute(&mut *connection)
    .await
    .unwrap();
    sqlx::query(
        "ALTER TABLE activation_invitations ENABLE TRIGGER activation_invitations_forward_only_update",
    )
    .execute(&mut *connection)
    .await
    .unwrap();
}

async fn assert_required_audits(pool: &DatabasePool) {
    for action in [
        "instance_admin.bootstrap_created",
        "auth.login_succeeded",
        "invitation.issue",
        "invitation.revoke",
        "invitation.accept",
        "organization.created",
        "organization.invitation_issued",
        "organization.invitation_reissued",
        "organization.invitation_accepted",
    ] {
        let count: i64 =
            sqlx::query_scalar("SELECT COUNT(*) FROM audit_events WHERE action_code = $1")
                .bind(action)
                .fetch_one(&mut *pool.acquire().await.unwrap())
                .await
                .unwrap();
        assert!(count > 0, "missing aggregate audit action {action}");
    }
}

async fn assert_durable_state_is_secret_free(pool: &DatabasePool, secrets: &[&str]) {
    let durable: String = sqlx::query_scalar(
        "SELECT COALESCE((SELECT string_agg(row_to_json(a)::text, '') FROM audit_events a), '') || \
         COALESCE((SELECT string_agg(row_to_json(i)::text, '') FROM activation_invitations i), '') || \
         COALESCE((SELECT string_agg(row_to_json(i)::text, '') FROM organization_invitations i), '')",
    )
    .fetch_one(&mut *pool.acquire().await.unwrap())
    .await
    .unwrap();
    for secret in secrets {
        assert!(
            !durable.contains(*secret),
            "durable state leaked a credential"
        );
    }
}

fn assert_process_output_secret_free(output: &Output, secrets: &[&str]) {
    for stream in [&output.stdout, &output.stderr] {
        let stream = String::from_utf8_lossy(stream);
        for secret in secrets {
            assert!(
                !stream.contains(*secret),
                "process output leaked a credential"
            );
        }
    }
}

struct StorageEnvironment(Vec<(OsString, OsString)>);

impl Environment for StorageEnvironment {
    fn entries(&self) -> Vec<(OsString, OsString)> {
        self.0.clone()
    }
}

async fn object_store(endpoint: &str, ca_path: &str) -> S3ObjectStore {
    let entries = [
        ("NURITEO_S3_ENDPOINT", endpoint),
        ("NURITEO_S3_REGION", "us-east-1"),
        ("NURITEO_S3_BUCKET", BUCKET),
        ("NURITEO_S3_ADDRESSING_STYLE", "path"),
        ("NURITEO_S3_CREDENTIAL_PROVIDER", "static"),
        ("NURITEO_S3_ACCESS_KEY_ID", ACCESS_KEY),
        ("NURITEO_S3_SECRET_ACCESS_KEY", SECRET_KEY),
        ("NURITEO_S3_CA_FILE", ca_path),
    ]
    .into_iter()
    .map(|(name, value)| (name.into(), value.into()))
    .collect();
    let config =
        ObjectStorageConfig::load(&StorageEnvironment(entries), &SystemFileReader).unwrap();
    S3ObjectStore::new(&config, OperationLimits::default())
        .await
        .unwrap()
}

fn fixture_s3_client(endpoint: &str, ca_pem: &[u8]) -> aws_sdk_s3::Client {
    let mut trust_store = TrustStore::default();
    trust_store.add_pem_certificate(ca_pem.to_vec());
    let context = TlsContext::builder()
        .with_trust_store(trust_store)
        .build()
        .unwrap();
    let pool = ConnectionPool::builder()
        .max_connections_per_host(4)
        .tls_provider(tls::Provider::Rustls(CryptoMode::Ring))
        .tls_context(context)
        .build_https()
        .unwrap();
    let http_client = PoolClient::new(&pool).unwrap();
    let credentials = Credentials::new(ACCESS_KEY, SECRET_KEY, None, None, "gate-002");
    let config = aws_sdk_s3::Config::builder()
        .behavior_version(BehaviorVersion::latest())
        .endpoint_url(endpoint)
        .region(Region::new("us-east-1"))
        .force_path_style(true)
        .credentials_provider(credentials)
        .http_client(http_client)
        .build();
    aws_sdk_s3::Client::from_conf(config)
}

async fn create_bucket(client: &aws_sdk_s3::Client) {
    client.create_bucket().bucket(BUCKET).send().await.unwrap();
}

fn required_env(name: &str) -> String {
    env::var(name).unwrap_or_else(|_| panic!("{name} must be set by the GATE-002 fixture"))
}

fn assert_current_embedded_migrations(report: MigrationReport) {
    let expected_latest = i64::try_from(report.known_migrations)
        .expect("embedded migration count must fit in a PostgreSQL migration version");
    assert!(
        expected_latest > 0,
        "the embedded migration set must not be empty"
    );
    assert_eq!(
        report.latest_version,
        Some(expected_latest),
        "the gate requires the complete, contiguous embedded migration set"
    );
}
