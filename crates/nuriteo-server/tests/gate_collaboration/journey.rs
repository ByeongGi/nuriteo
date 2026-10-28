#![allow(unused_imports)]
use super::*;
use super::stack::*;

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
use super::{DATABASE_URL_ENV, DATABASE_CA_ENV, S3_ENDPOINT_ENV, S3_CA_ENV, BOOTSTRAP_PASSWORD_FILE_ENV, SAVE_IDEMPOTENCY_SECRET_FILE_ENV, GATE_PROJECT_RUNTIME_BROWSER_ENV, NODE_EXECUTABLE_ENV, BOOTSTRAP_PASSWORD, INVITEE_PASSWORD, ACCESS_KEY, SECRET_KEY, BUCKET, MAX_PROCESS_OUTPUT_BYTES, Browser, CapturedProcessOutput, CapturedStream, ChildGuard, StorageEnvironment};



#[tokio::test]
#[ignore = "requires the GATE-002 custom-CA PostgreSQL and HTTPS RustFS fixture"]
pub(crate) async fn collaboration_gate_runs_actual_core_postgres_and_rustfs_journey() {    let database_url = required_env(DATABASE_URL_ENV);
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
pub(crate) async fn project_runtime_gate_runs_actual_core_and_browser_journey() {    let database_url = required_env(DATABASE_URL_ENV);
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


pub(crate) async fn login(client: &Client, base: &str, email: &str, password: &str) -> Browser {    let response = client
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


pub(crate) async fn get_json(client: &Client, base: &str, path: &str, browser: &Browser) -> Value {    let response = client
        .get(format!("{base}{path}"))
        .header(COOKIE, &browser.cookie)
        .send()
        .await
        .unwrap();
    assert_eq!(response.status(), StatusCode::OK);
    response_json(response).await
}


pub(crate) async fn workspaces(client: &Client, base: &str, browser: &Browser) -> Value {    get_json(client, base, "/api/v1/me/workspaces", browser).await
}


pub(crate) fn assert_personal_only(workspaces: &Value, user_id: &str) {    let workspaces = workspaces["workspaces"].as_array().unwrap();
    assert_eq!(workspaces.len(), 1);
    assert_eq!(workspaces[0]["ownerType"], "user");
    assert_eq!(workspaces[0]["ownerId"], user_id);
}


pub(crate) async fn public_json(client: &Client, base: &str, path: &str, body: Value) -> Response {    client
        .post(format!("{base}{path}"))
        .header(CONTENT_TYPE, "application/json")
        .header(ORIGIN, base)
        .body(serde_json::to_vec(&body).unwrap())
        .send()
        .await
        .unwrap()
}


pub(crate) async fn browser_json(    client: &Client,
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


pub(crate) async fn response_json(response: Response) -> Value {    let bytes = response.bytes().await.unwrap();
    assert!(bytes.len() <= 1024 * 1024);
    serde_json::from_slice(&bytes).unwrap()
}


pub(crate) async fn assert_status(response: Response, expected: StatusCode) {    assert_eq!(response.status(), expected);
    let bytes = response.bytes().await.unwrap();
    assert!(bytes.len() <= 1024 * 1024);
}


pub(crate) async fn assert_safe_problem(response: Response, expected: StatusCode) {    assert_eq!(response.status(), expected);
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


pub(crate) fn query_token(url: &str) -> String {    Url::parse(url)
        .unwrap()
        .query_pairs()
        .find_map(|(key, value)| (key == "token").then(|| value.into_owned()))
        .unwrap()
}


pub(crate) fn bootstrap_admin(    database_url: &str,
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


pub(crate) fn assert_safe_bootstrap(output: &Output, expected: &[u8]) {    assert!(
        output.status.success(),
        "bootstrap-admin failed with {}: {}",
        output.status,
        String::from_utf8_lossy(&output.stderr)
    );
    assert_eq!(output.stdout, expected);
    assert!(output.stderr.is_empty());
    assert_process_output_secret_free(output, &[BOOTSTRAP_PASSWORD, "postgres://", SECRET_KEY]);
}


pub(crate) fn spawn_server(    address: SocketAddr,
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


pub(crate) fn spawn_server_with_external_url(    address: SocketAddr,
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
