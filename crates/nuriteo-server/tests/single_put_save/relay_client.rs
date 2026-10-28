#![allow(unused_imports)]
use super::admission::*;
use super::fake_store::*;
use super::history::*;
use super::postgres_bucket::*;
use super::relay_multipart::*;
use super::relay_streams::*;
use super::save_http::*;
use super::verifier::*;
use super::versions::*;
use super::working_head::*;
use super::*;
use std::env;

use std::ffi::OsString;

use std::fs;

use std::pin::Pin;

use std::str::FromStr;

use std::task::Poll;

use std::time::Duration;

use aws_sdk_s3::config::{BehaviorVersion, Credentials, Region};

use aws_smithy_http_client::pool::{Client as PoolClient, ConnectionPool};

use aws_smithy_http_client::tls::rustls_provider::CryptoMode;

use aws_smithy_http_client::tls::{self, TlsContext, TrustStore};

use axum::Router;

use axum::body::{Body, to_bytes};

use axum::http::header::{CONTENT_TYPE, COOKIE, ETAG, IF_MATCH, ORIGIN, SET_COOKIE};

use axum::http::{Method, Request, Response, StatusCode};

use base64::Engine as _;

use base64::engine::general_purpose::STANDARD as BASE64;

use bytes::Bytes;

use nuriteo_server::app::{build_router_with_project_service, build_router_with_save_service};

use nuriteo_server::audit::AuditEventId;

use nuriteo_server::auth::{AuthPolicy, AuthService};

use nuriteo_server::config::{Environment, InstanceSettingBootstrap, SystemFileReader};

use nuriteo_server::database::{
    DatabasePool, DatabasePoolConfig, DatabaseTlsConfig, MigrationOptions, run_embedded_migrations,
};

use nuriteo_server::health::HealthService;

use nuriteo_server::identity::SessionPolicy;

use nuriteo_server::identity::UserId;

use nuriteo_server::instance_settings::InstanceSettingsRepository;

use nuriteo_server::invitations::InvitationHttpService;

use nuriteo_server::object_storage::{
    BoundedPresignedRequest, MultipartUpload, ObjectKey, ObjectStorageConfig, OperationLimits,
    PresignedMultipartPartRequest, PresignedPutRequest, PutRequest, S3ObjectStore, Sha256Checksum,
    UploadedPart,
};

use nuriteo_server::organization::{OrganizationHttpService, OrganizationId};

use nuriteo_server::project::{
    ProjectAuditContext, ProjectDeleteConfirmation, ProjectHttpPolicy, ProjectHttpService,
    ProjectId, ProjectName, ProjectOwner, ProjectService, ProjectServicePolicy, ProjectSlug,
    ProjectVersion,
};

use nuriteo_server::published_example::{
    CreatePublishedExample, ForkPublishedExample, PublishedExampleDeleteConfirmation,
    PublishedExampleForkError, PublishedExampleForkKey, PublishedExampleForkPolicy,
    PublishedExampleForkService, PublishedExampleName, PublishedExampleService,
    PublishedExampleServicePolicy, PublishedExampleVisibility,
};

use nuriteo_server::quota::EffectiveQuota;

use nuriteo_server::save::{
    CleanupWorkerPolicy, ContentServicePolicy, CreateMultipartSession, CreateProjectVersion,
    CreateSinglePutSession, HistoricalReferenceKind, IdempotencyKey, IdempotencySecret,
    MultipartPartPlan, MultipartPartReceipt, MultipartService, MultipartServiceError,
    MultipartServicePolicy, MultipartSessionContext, MultipartStore, ProjectHistoryError,
    ProjectHistoryService, ProjectHistoryServicePolicy, ProjectVersionError, ProjectVersionName,
    ProjectVersionPageLimit, ProjectVersionService, ProjectVersionServicePolicy,
    PromoteHistoricalReference, PutPresigner, RecoveryCheckpoint, SaveHttpError, SaveHttpPolicy,
    SaveHttpService, SaveUploadTransport, SinglePutService, SinglePutServiceError,
    SinglePutServicePolicy, StagingVerifier, StagingVerifierPolicy, VerificationError,
    VerifiedStagingBundle, VerifyStagingBundle, WorkingHeadCommitError, WorkingHeadCommitPolicy,
    WorkingHeadCommitReconciliation, WorkingHeadCommitService, decode_git_bundle,
};

use nuriteo_server::setup::SetupStatusService;

use nuriteo_server::workspace::StorageScopeId;

use serde_json::{Value, json};

use sha2::{Digest, Sha256};

use sqlx::{Acquire, Executor};

use tower::ServiceExt as _;

use url::Url;

use super::{
    ACCESS_KEY, AbortBehavior, AttachFailureStore, BUCKET, BoundedFrameBody, CapturedLogWriter,
    DATABASE_CA_ENV, DATABASE_URL_ENV, FailingPresigner, FixtureEnvironment, GatedFrameBody,
    HangingPresigner, LostCompleteStore, NeverReadBody, ORG, ORG_MEMBER, ORG_OWNER,
    ORG_PROJECT_MEMBER, ORG_PROJECT_MULTI_ARCHIVE, ORG_PROJECT_MULTI_REVOKE, ORG_PROJECT_OUTSIDER,
    ORG_PROJECT_OWNER, ORG_PROJECT_READ, ORG_PROJECT_WRITE, ORG_READ, ORG_SCOPE, ORG_WRITE,
    OUTSIDER, ObservedFrameBody, PROJECT_A, PROJECT_B, PROJECT_FAIL, PROJECT_HISTORY_LEFT,
    PROJECT_HISTORY_RIGHT, PROJECT_LEASE_ABORT, PROJECT_LEASE_CLOCK, PROJECT_LEASE_COMPLETE,
    PROJECT_LEASE_EXPIRE, PROJECT_MULTI_EXPIRY, PROJECT_TIMEOUT, PersistedRelaySecretRow,
    RelayMultipartFixture, S3_CA_ENV, S3_ENDPOINT_ENV, SCOPE, SECRET_KEY, TEST_PASSWORD,
    TEST_PASSWORD_HASH, USER, VersionBrowser, WEB_ORIGIN,
};
use uuid::Uuid;

pub(crate) async fn version_login(router: &Router, email: &str) -> VersionBrowser {
    let response = router
        .clone()
        .oneshot(
            Request::builder()
                .method(Method::POST)
                .uri("/api/v1/auth/sessions")
                .header(CONTENT_TYPE, "application/json")
                .header(ORIGIN, WEB_ORIGIN)
                .body(Body::from(
                    serde_json::to_vec(&json!({
                        "email": email,
                        "password": TEST_PASSWORD,
                    }))
                    .unwrap(),
                ))
                .unwrap(),
        )
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
    let csrf = pairs
        .iter()
        .find_map(|pair| pair.strip_prefix("nuriteo_dev_csrf="))
        .unwrap()
        .to_owned();
    VersionBrowser {
        cookie: pairs.join("; "),
        csrf,
    }
}

pub(crate) async fn version_json_request(
    router: &Router,
    browser: &VersionBrowser,
    method: Method,
    uri: &str,
    etag: Option<&str>,
    idempotency_key: Option<&str>,
    body: Value,
) -> Response<Body> {
    let mut builder = Request::builder()
        .method(method)
        .uri(uri)
        .header(CONTENT_TYPE, "application/json")
        .header(ORIGIN, WEB_ORIGIN)
        .header(COOKIE, &browser.cookie)
        .header("x-csrf-token", &browser.csrf);
    if let Some(etag) = etag {
        builder = builder.header(IF_MATCH, etag);
    }
    if let Some(idempotency_key) = idempotency_key {
        builder = builder.header("idempotency-key", idempotency_key);
    }
    router
        .clone()
        .oneshot(
            builder
                .body(Body::from(serde_json::to_vec(&body).unwrap()))
                .unwrap(),
        )
        .await
        .unwrap()
}

pub(crate) async fn version_empty_request(
    router: &Router,
    browser: &VersionBrowser,
    uri: &str,
) -> Response<Body> {
    router
        .clone()
        .oneshot(
            Request::builder()
                .method(Method::GET)
                .uri(uri)
                .header(ORIGIN, WEB_ORIGIN)
                .header(COOKIE, &browser.cookie)
                .header("x-csrf-token", &browser.csrf)
                .body(Body::empty())
                .unwrap(),
        )
        .await
        .unwrap()
}

pub(crate) async fn version_empty_mutation(
    router: &Router,
    browser: &VersionBrowser,
    method: Method,
    uri: &str,
) -> Response<Body> {
    router
        .clone()
        .oneshot(
            Request::builder()
                .method(method)
                .uri(uri)
                .header(ORIGIN, WEB_ORIGIN)
                .header(COOKIE, &browser.cookie)
                .header("x-csrf-token", &browser.csrf)
                .body(Body::empty())
                .unwrap(),
        )
        .await
        .unwrap()
}

pub(crate) async fn create_relay_single_session(
    router: &Router,
    browser: &VersionBrowser,
    project_id: &str,
    idempotency_key: &str,
    file_name: &str,
) -> (Value, Vec<u8>, String) {
    let content = format!("relay lease {project_id}\n").into_bytes();
    let bundle = canonical_test_bundle(project_id, SCOPE, file_name, &content);
    let collection = format!("/api/v1/workspaces/users/{USER}/projects/{project_id}/save-sessions");
    let response = version_json_request(
        router,
        browser,
        Method::POST,
        &collection,
        Some("\"project-v1\""),
        Some(idempotency_key),
        json!({
            "physicalBytes": bundle.len(),
            "logicalBytes": content.len(),
            "fileCount": 1,
            "sha256": BASE64.encode(Sha256::digest(&bundle)),
            "parts": []
        }),
    )
    .await;
    assert_eq!(response.status(), StatusCode::CREATED);
    (version_response_json(response).await, bundle, collection)
}

pub(crate) async fn create_organization_relay_session(
    router: &Router,
    browser: &VersionBrowser,
    project_id: &str,
    idempotency_key: &str,
) -> Value {
    let content = format!("organization relay {project_id}\n").into_bytes();
    let bundle = canonical_test_bundle(project_id, ORG_SCOPE, "race.txt", &content);
    let collection =
        format!("/api/v1/workspaces/organizations/{ORG}/projects/{project_id}/save-sessions");
    let response = version_json_request(
        router,
        browser,
        Method::POST,
        &collection,
        Some("\"project-v1\""),
        Some(idempotency_key),
        json!({
            "physicalBytes": bundle.len(),
            "logicalBytes": content.len(),
            "fileCount": 1,
            "sha256": BASE64.encode(Sha256::digest(&bundle)),
            "parts": []
        }),
    )
    .await;
    assert_eq!(response.status(), StatusCode::CREATED);
    version_response_json(response).await
}

pub(crate) async fn create_relay_multipart_session(
    router: &Router,
    browser: &VersionBrowser,
    owner_type: &str,
    owner_id: &str,
    project_id: &str,
    idempotency_key: &str,
) -> RelayMultipartFixture {
    let part_sizes = [
        16 * 1024 * 1024,
        16 * 1024 * 1024,
        16 * 1024 * 1024,
        16 * 1024 * 1024,
        1024 * 1024,
    ];
    let bodies = part_sizes
        .into_iter()
        .enumerate()
        .map(|(index, size)| Bytes::from(vec![0x61_u8.saturating_add(index as u8); size]))
        .collect::<Vec<_>>();
    let parts = bodies
        .iter()
        .enumerate()
        .map(|(index, body)| {
            json!({
                "partNumber": index + 1,
                "expectedBytes": body.len(),
                "sha256": BASE64.encode(Sha256::digest(body))
            })
        })
        .collect::<Vec<_>>();
    let mut digest = Sha256::new();
    for body in &bodies {
        digest.update(body);
    }
    let collection =
        format!("/api/v1/workspaces/{owner_type}/{owner_id}/projects/{project_id}/save-sessions");
    let created = version_json_request(
        router,
        browser,
        Method::POST,
        &collection,
        Some("\"project-v1\""),
        Some(idempotency_key),
        json!({
            "physicalBytes": bodies.iter().map(Bytes::len).sum::<usize>(),
            "logicalBytes": 65 * 1024 * 1024,
            "fileCount": 5,
            "sha256": BASE64.encode(digest.finalize()),
            "parts": parts
        }),
    )
    .await;
    assert_eq!(created.status(), StatusCode::CREATED);
    let created = version_response_json(created).await;
    let session_id = created["sessionId"].as_str().unwrap().to_owned();
    let issued = version_json_request(
        router,
        browser,
        Method::POST,
        &format!("{collection}/{session_id}/parts"),
        None,
        None,
        json!({"parts": parts}),
    )
    .await;
    assert_eq!(issued.status(), StatusCode::OK);
    let capabilities = version_response_json(issued)
        .await
        .as_array()
        .unwrap()
        .clone();
    assert_eq!(capabilities.len(), bodies.len());
    RelayMultipartFixture {
        session_id,
        capabilities,
        bodies,
    }
}

pub(crate) async fn version_response_json(response: Response<Body>) -> Value {
    serde_json::from_slice(&to_bytes(response.into_body(), 256 * 1024).await.unwrap()).unwrap()
}

pub(crate) fn relay_put_request(
    capability: &Value,
    browser: &VersionBrowser,
    body: Body,
    length_override: Option<u64>,
    checksum_override: Option<String>,
) -> Request<Body> {
    let mut builder = Request::builder()
        .method(Method::PUT)
        .uri(capability["path"].as_str().unwrap())
        .header(ORIGIN, WEB_ORIGIN)
        .header(COOKIE, &browser.cookie)
        .header("x-csrf-token", &browser.csrf)
        .header(
            "content-length",
            length_override.unwrap_or_else(|| capability["expectedBytes"].as_u64().unwrap()),
        );
    for header in capability["headers"].as_array().unwrap() {
        let name = header["name"].as_str().unwrap();
        let value = if name.eq_ignore_ascii_case("x-nuriteo-content-sha256") {
            checksum_override
                .as_deref()
                .unwrap_or_else(|| header["value"].as_str().unwrap())
        } else {
            header["value"].as_str().unwrap()
        };
        builder = builder.header(name, value);
    }
    builder.body(body).unwrap()
}

pub(crate) async fn relay_put_over_http(
    address: std::net::SocketAddr,
    capability: &Value,
    browser: &VersionBrowser,
    body: &[u8],
) -> StatusCode {
    let client = reqwest::Client::builder()
        .timeout(Duration::from_secs(30))
        .build()
        .unwrap();
    let mut request = client
        .put(format!(
            "http://{address}{}",
            capability["path"].as_str().unwrap()
        ))
        .header(ORIGIN.as_str(), WEB_ORIGIN)
        .header(COOKIE.as_str(), &browser.cookie)
        .header("x-csrf-token", &browser.csrf)
        .header("content-length", body.len());
    for header in capability["headers"].as_array().unwrap() {
        request = request.header(
            header["name"].as_str().unwrap(),
            header["value"].as_str().unwrap(),
        );
    }
    let response = request.body(body.to_vec()).send().await.unwrap();
    StatusCode::from_u16(response.status().as_u16()).unwrap()
}

pub(crate) async fn download_current_content(
    router: &Router,
    browser: &VersionBrowser,
    project_id: &str,
    maximum: usize,
) -> Vec<u8> {
    let descriptor_response = version_empty_request(
        router,
        browser,
        &format!("/api/v1/workspaces/users/{USER}/projects/{project_id}/content"),
    )
    .await;
    assert_eq!(descriptor_response.status(), StatusCode::OK);
    let descriptor = version_response_json(descriptor_response).await;
    let response = router
        .clone()
        .oneshot(
            Request::builder()
                .method(Method::GET)
                .uri(descriptor["downloadUrl"].as_str().unwrap())
                .header(COOKIE, &browser.cookie)
                .header(IF_MATCH, descriptor["etag"].as_str().unwrap())
                .body(Body::empty())
                .unwrap(),
        )
        .await
        .unwrap();
    assert_eq!(response.status(), StatusCode::OK);
    to_bytes(response.into_body(), maximum + 1)
        .await
        .unwrap()
        .to_vec()
}

pub(crate) fn assert_relay_projection_is_private(value: &Value, prohibited: &[&str]) {
    let serialized = value.to_string();
    for prohibited in prohibited {
        assert!(
            !serialized.contains(prohibited),
            "relay projection leaked prohibited material"
        );
    }
}

pub(crate) async fn capture_private_problem(
    response: Response<Body>,
    expected_status: StatusCode,
    captured: &mut Vec<String>,
) {
    assert_eq!(response.status(), expected_status);
    assert_eq!(
        response.headers().get(CONTENT_TYPE).unwrap(),
        "application/problem+json"
    );
    captured.push(
        String::from_utf8(
            to_bytes(response.into_body(), 64 * 1024)
                .await
                .unwrap()
                .to_vec(),
        )
        .unwrap(),
    );
}

impl std::io::Write for CapturedLogWriter {
    fn write(&mut self, buffer: &[u8]) -> std::io::Result<usize> {
        self.0.lock().unwrap().extend_from_slice(buffer);
        Ok(buffer.len())
    }

    fn flush(&mut self) -> std::io::Result<()> {
        Ok(())
    }
}

impl<'writer> tracing_subscriber::fmt::MakeWriter<'writer> for CapturedLogWriter {
    type Writer = Self;

    fn make_writer(&'writer self) -> Self::Writer {
        self.clone()
    }
}

pub(crate) fn normalized_for_leak_scan(value: &str) -> String {
    value
        .chars()
        .filter(|character| character.is_ascii_alphanumeric())
        .flat_map(char::to_lowercase)
        .collect()
}

pub(crate) fn assert_no_normalized_sensitive_leak(rendered: &str, sensitive: &[String]) {
    let normalized = normalized_for_leak_scan(rendered);
    for secret in sensitive {
        let candidate = normalized_for_leak_scan(secret);
        assert!(candidate.len() >= 12);
        assert!(
            !normalized.contains(&candidate),
            "response or structured log leaked normalized sensitive material"
        );
    }
}

pub(crate) fn append_digest_renderings(sensitive: &mut Vec<String>, digest: &[u8]) {
    sensitive.push(
        digest
            .iter()
            .map(|byte| format!("{byte:02x}"))
            .collect::<String>(),
    );
    sensitive.push(BASE64.encode(digest));
    sensitive.push(format!("{digest:?}"));
}

pub(crate) fn append_capability_checksums(checksums: &mut Vec<String>, capability: &Value) {
    for header in capability["headers"].as_array().unwrap() {
        if header["name"]
            .as_str()
            .is_some_and(|name| name.eq_ignore_ascii_case("x-nuriteo-content-sha256"))
        {
            checksums.push(header["value"].as_str().unwrap().to_owned());
        }
    }
}

impl http_body::Body for NeverReadBody {
    type Data = Bytes;
    type Error = std::convert::Infallible;

    fn poll_frame(
        self: Pin<&mut Self>,
        _cx: &mut std::task::Context<'_>,
    ) -> Poll<Option<Result<http_body::Frame<Self::Data>, Self::Error>>> {
        panic!("relay request body was polled before validation completed")
    }
}

pub(crate) fn gated_frame_body(expected_bytes: usize) -> (tokio::sync::mpsc::Sender<Bytes>, Body) {
    let (sender, receiver) = tokio::sync::mpsc::channel(1);
    (
        sender,
        Body::new(GatedFrameBody {
            receiver,
            remaining: expected_bytes as u64,
        }),
    )
}

impl http_body::Body for GatedFrameBody {
    type Data = Bytes;
    type Error = std::convert::Infallible;

    fn poll_frame(
        mut self: Pin<&mut Self>,
        cx: &mut std::task::Context<'_>,
    ) -> Poll<Option<Result<http_body::Frame<Self::Data>, Self::Error>>> {
        match self.receiver.poll_recv(cx) {
            Poll::Ready(Some(frame)) => {
                self.remaining = self.remaining.saturating_sub(frame.len() as u64);
                Poll::Ready(Some(Ok(http_body::Frame::data(frame))))
            }
            Poll::Ready(None) => Poll::Ready(None),
            Poll::Pending => Poll::Pending,
        }
    }

    fn size_hint(&self) -> http_body::SizeHint {
        http_body::SizeHint::with_exact(self.remaining)
    }
}

pub(crate) async fn send_bounded_frames(sender: tokio::sync::mpsc::Sender<Bytes>, content: &[u8]) {
    for frame in content.chunks(64 * 1024) {
        sender.send(Bytes::copy_from_slice(frame)).await.unwrap();
    }
}

pub(crate) async fn wait_for_active_relay_lease(
    pool: &DatabasePool,
    session_id: &str,
    part_number: i16,
) {
    tokio::time::timeout(Duration::from_secs(2), async {
        loop {
            let active: bool = sqlx::query_scalar(
                "SELECT EXISTS(SELECT 1 FROM save_upload_leases \
                 WHERE save_session_id=$1::uuid AND part_number=$2 \
                   AND released_at IS NULL AND lease_expires_at>clock_timestamp())",
            )
            .bind(session_id)
            .bind(part_number)
            .fetch_one(&mut *pool.acquire().await.unwrap())
            .await
            .unwrap();
            if active {
                return;
            }
            tokio::time::sleep(Duration::from_millis(10)).await;
        }
    })
    .await
    .unwrap();
}

pub(crate) async fn assert_released_relay_generation(
    pool: &DatabasePool,
    session_id: &str,
    part_number: i16,
    expected_generation: i64,
) {
    let persisted: (i64, bool) = sqlx::query_as(
        "SELECT generation,released_at IS NOT NULL FROM save_upload_leases \
         WHERE save_session_id=$1::uuid AND part_number=$2",
    )
    .bind(session_id)
    .bind(part_number)
    .fetch_one(&mut *pool.acquire().await.unwrap())
    .await
    .unwrap();
    assert_eq!(persisted, (expected_generation, true));
}

pub(crate) async fn wait_for_relay_scope_lock_wait(pool: &DatabasePool) {
    tokio::time::timeout(Duration::from_secs(2), async {
        loop {
            let waiting: bool = sqlx::query_scalar(
                "SELECT EXISTS(SELECT 1 FROM pg_stat_activity \
                 WHERE wait_event_type='Lock' \
                   AND query LIKE 'SELECT id::text FROM storage_scopes WHERE id = $1::uuid FOR UPDATE%')",
            )
            .fetch_one(&mut *pool.acquire().await.unwrap())
            .await
            .unwrap();
            if waiting {
                return;
            }
            tokio::time::sleep(Duration::from_millis(10)).await;
        }
    })
    .await
    .unwrap();
}

impl BoundedFrameBody {
    pub(crate) fn new(content: &[u8]) -> Self {
        Self {
            content: Bytes::copy_from_slice(content),
            offset: 0,
        }
    }
}

impl ObservedFrameBody {
    pub(crate) fn new(
        content: &[u8],
        polled: std::sync::Arc<std::sync::atomic::AtomicBool>,
    ) -> Self {
        Self {
            body: BoundedFrameBody::new(content),
            polled,
        }
    }
}

impl http_body::Body for ObservedFrameBody {
    type Data = Bytes;
    type Error = std::convert::Infallible;

    fn poll_frame(
        mut self: Pin<&mut Self>,
        cx: &mut std::task::Context<'_>,
    ) -> Poll<Option<Result<http_body::Frame<Self::Data>, Self::Error>>> {
        self.polled.store(true, std::sync::atomic::Ordering::SeqCst);
        Pin::new(&mut self.body).poll_frame(cx)
    }

    fn size_hint(&self) -> http_body::SizeHint {
        self.body.size_hint()
    }
}

impl http_body::Body for BoundedFrameBody {
    type Data = Bytes;
    type Error = std::convert::Infallible;

    fn poll_frame(
        mut self: Pin<&mut Self>,
        _cx: &mut std::task::Context<'_>,
    ) -> Poll<Option<Result<http_body::Frame<Self::Data>, Self::Error>>> {
        if self.offset == self.content.len() {
            return Poll::Ready(None);
        }
        let end = self
            .offset
            .saturating_add(64 * 1024)
            .min(self.content.len());
        let frame = self.content.slice(self.offset..end);
        self.offset = end;
        Poll::Ready(Some(Ok(http_body::Frame::data(frame))))
    }

    fn size_hint(&self) -> http_body::SizeHint {
        let remaining = self.content.len().saturating_sub(self.offset) as u64;
        http_body::SizeHint::with_exact(remaining)
    }
}

pub(crate) async fn reset_and_seed(pool: &DatabasePool) {
    let mut connection = pool.acquire().await.unwrap();
    connection
        .execute("DROP SCHEMA public CASCADE")
        .await
        .unwrap();
    connection.execute("CREATE SCHEMA public").await.unwrap();
    run_embedded_migrations(
        pool,
        MigrationOptions::new(Duration::from_secs(5), Duration::from_secs(30)).unwrap(),
    )
    .await
    .unwrap();
    connection.execute("INSERT INTO users (id,email,normalized_email,display_name) VALUES \
        ('0199ee6c-c777-7000-8000-000000008001','save@example.test','save@example.test','Save Owner'),\
        ('0199ee6c-c777-7000-8000-000000008002','outside@example.test','outside@example.test','Outside'),\
        ('0199ee6c-c777-7000-8000-000000008003','org-owner@example.test','org-owner@example.test','Org Owner'),\
        ('0199ee6c-c777-7000-8000-000000008004','org-read@example.test','org-read@example.test','Org Read'),\
        ('0199ee6c-c777-7000-8000-000000008005','org-write@example.test','org-write@example.test','Org Write'),\
        ('0199ee6c-c777-7000-8000-000000008006','org-member@example.test','org-member@example.test','Org Member')").await.unwrap();
    connection
        .execute(
            "INSERT INTO organizations (id,slug,display_name) VALUES \
        ('0199ee6c-c777-7000-8000-000000008030','save-org','Save Org')",
        )
        .await
        .unwrap();
    connection
        .execute(
            "INSERT INTO organization_memberships (organization_id,user_id,role) VALUES \
        ('0199ee6c-c777-7000-8000-000000008030','0199ee6c-c777-7000-8000-000000008003','owner'),\
        ('0199ee6c-c777-7000-8000-000000008030','0199ee6c-c777-7000-8000-000000008004','member'),\
        ('0199ee6c-c777-7000-8000-000000008030','0199ee6c-c777-7000-8000-000000008005','member'),\
        ('0199ee6c-c777-7000-8000-000000008030','0199ee6c-c777-7000-8000-000000008006','member')",
        )
        .await
        .unwrap();
    connection
        .execute(
            "INSERT INTO storage_scopes (id,owner_user_id) VALUES \
        ('0199ee6c-c777-7000-8000-000000008010','0199ee6c-c777-7000-8000-000000008001')",
        )
        .await
        .unwrap();
    connection
        .execute(
            "INSERT INTO storage_scopes (id,owner_organization_id) VALUES \
        ('0199ee6c-c777-7000-8000-000000008031','0199ee6c-c777-7000-8000-000000008030')",
        )
        .await
        .unwrap();
    connection.execute("INSERT INTO projects (id,owner_user_id,storage_scope_id,slug,name) VALUES \
        ('0199ee6c-c777-7000-8000-000000008020','0199ee6c-c777-7000-8000-000000008001','0199ee6c-c777-7000-8000-000000008010','save-a','Save A'),\
        ('0199ee6c-c777-7000-8000-000000008021','0199ee6c-c777-7000-8000-000000008001','0199ee6c-c777-7000-8000-000000008010','save-b','Save B'),\
        ('0199ee6c-c777-7000-8000-000000008022','0199ee6c-c777-7000-8000-000000008001','0199ee6c-c777-7000-8000-000000008010','save-fail','Save Fail'),\
        ('0199ee6c-c777-7000-8000-000000008023','0199ee6c-c777-7000-8000-000000008001','0199ee6c-c777-7000-8000-000000008010','save-timeout','Save Timeout'),\
        ('0199ee6c-c777-7000-8000-000000008026','0199ee6c-c777-7000-8000-000000008001','0199ee6c-c777-7000-8000-000000008010','lease-abort','Lease Abort'),\
        ('0199ee6c-c777-7000-8000-000000008027','0199ee6c-c777-7000-8000-000000008001','0199ee6c-c777-7000-8000-000000008010','lease-expire','Lease Expire'),\
        ('0199ee6c-c777-7000-8000-000000008028','0199ee6c-c777-7000-8000-000000008001','0199ee6c-c777-7000-8000-000000008010','lease-complete','Lease Complete'),\
        ('0199ee6c-c777-7000-8000-000000008029','0199ee6c-c777-7000-8000-000000008001','0199ee6c-c777-7000-8000-000000008010','multi-expiry','Multi Expiry'),\
        ('0199ee6c-c777-7000-8000-00000000802a','0199ee6c-c777-7000-8000-000000008001','0199ee6c-c777-7000-8000-000000008010','lease-clock','Lease Clock')").await.unwrap();
    connection.execute("INSERT INTO projects (id,owner_organization_id,storage_scope_id,slug,name) VALUES \
        ('0199ee6c-c777-7000-8000-000000008040','0199ee6c-c777-7000-8000-000000008030','0199ee6c-c777-7000-8000-000000008031','org-owner-save','Owner Save'),\
        ('0199ee6c-c777-7000-8000-000000008041','0199ee6c-c777-7000-8000-000000008030','0199ee6c-c777-7000-8000-000000008031','org-read-save','Read Save'),\
        ('0199ee6c-c777-7000-8000-000000008042','0199ee6c-c777-7000-8000-000000008030','0199ee6c-c777-7000-8000-000000008031','org-write-save','Write Save'),\
        ('0199ee6c-c777-7000-8000-000000008043','0199ee6c-c777-7000-8000-000000008030','0199ee6c-c777-7000-8000-000000008031','org-member-save','Member Save'),\
        ('0199ee6c-c777-7000-8000-000000008044','0199ee6c-c777-7000-8000-000000008030','0199ee6c-c777-7000-8000-000000008031','org-outsider-save','Outsider Save'),\
        ('0199ee6c-c777-7000-8000-000000008045','0199ee6c-c777-7000-8000-000000008030','0199ee6c-c777-7000-8000-000000008031','multi-revoke','Multi Revoke'),\
        ('0199ee6c-c777-7000-8000-000000008046','0199ee6c-c777-7000-8000-000000008030','0199ee6c-c777-7000-8000-000000008031','multi-archive','Multi Archive')").await.unwrap();
    connection.execute("INSERT INTO project_user_roles (project_id,organization_id,user_id,role) VALUES \
        ('0199ee6c-c777-7000-8000-000000008041','0199ee6c-c777-7000-8000-000000008030','0199ee6c-c777-7000-8000-000000008004','read'),\
        ('0199ee6c-c777-7000-8000-000000008042','0199ee6c-c777-7000-8000-000000008030','0199ee6c-c777-7000-8000-000000008005','write'),\
        ('0199ee6c-c777-7000-8000-000000008045','0199ee6c-c777-7000-8000-000000008030','0199ee6c-c777-7000-8000-000000008005','write')").await.unwrap();
}

pub(crate) async fn reservation_count(pool: &DatabasePool, session: String) -> i64 {
    sqlx::query_scalar("SELECT COUNT(*) FROM storage_reservations WHERE save_session_id=$1::uuid")
        .bind(session)
        .fetch_one(&mut *pool.acquire().await.unwrap())
        .await
        .unwrap()
}

pub(crate) async fn terminal_cleanup_state(
    pool: &DatabasePool,
    session: String,
) -> (String, i64, i64) {
    sqlx::query_as(
        "SELECT state,(SELECT COUNT(*) FROM storage_reservations WHERE save_session_id=save.id),\
         (SELECT COUNT(*) FROM save_cleanup_jobs WHERE save_session_id=save.id) \
         FROM save_sessions save WHERE id=$1::uuid",
    )
    .bind(session)
    .fetch_one(&mut *pool.acquire().await.unwrap())
    .await
    .unwrap()
}

pub(crate) async fn force_session_expiry(
    pool: &DatabasePool,
    session: &str,
    expression: &'static str,
) {
    let mut connection = pool.acquire().await.unwrap();
    connection
        .execute("ALTER TABLE save_sessions DISABLE TRIGGER save_sessions_update_invariants")
        .await
        .unwrap();
    sqlx::query(sqlx::AssertSqlSafe(format!(
        "UPDATE save_sessions SET expires_at={expression} WHERE id=$1::uuid"
    )))
    .bind(session)
    .execute(&mut *connection)
    .await
    .unwrap();
    connection
        .execute("ALTER TABLE save_sessions ENABLE TRIGGER save_sessions_update_invariants")
        .await
        .unwrap();
}
