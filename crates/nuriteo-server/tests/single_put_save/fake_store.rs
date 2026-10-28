#![allow(unused_imports)]
use super::*;
use super::verifier::*;
use super::working_head::*;
use super::save_http::*;
use super::relay_multipart::*;
use super::relay_streams::*;
use super::versions::*;
use super::history::*;
use super::admission::*;
use super::relay_client::*;
use super::postgres_bucket::*;
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

use uuid::Uuid;
use super::{DATABASE_URL_ENV, DATABASE_CA_ENV, S3_ENDPOINT_ENV, S3_CA_ENV, BUCKET, ACCESS_KEY, SECRET_KEY, WEB_ORIGIN, TEST_PASSWORD, TEST_PASSWORD_HASH, USER, SCOPE, PROJECT_A, PROJECT_B, PROJECT_FAIL, PROJECT_TIMEOUT, PROJECT_LEASE_ABORT, PROJECT_LEASE_EXPIRE, PROJECT_LEASE_COMPLETE, PROJECT_MULTI_EXPIRY, PROJECT_LEASE_CLOCK, PROJECT_HISTORY_LEFT, PROJECT_HISTORY_RIGHT, OUTSIDER, ORG_OWNER, ORG_READ, ORG_WRITE, ORG_MEMBER, ORG_SCOPE, ORG, ORG_PROJECT_OWNER, ORG_PROJECT_READ, ORG_PROJECT_WRITE, ORG_PROJECT_MEMBER, ORG_PROJECT_OUTSIDER, ORG_PROJECT_MULTI_REVOKE, ORG_PROJECT_MULTI_ARCHIVE, PersistedRelaySecretRow, FixtureEnvironment, AbortBehavior, AttachFailureStore, LostCompleteStore, FailingPresigner, HangingPresigner, VersionBrowser, RelayMultipartFixture, CapturedLogWriter, NeverReadBody, BoundedFrameBody, ObservedFrameBody, GatedFrameBody};



impl MultipartStore for super::AttachFailureStore {
    type Error = ();

    async fn create(&self, key: ObjectKey) -> Result<MultipartUpload, Self::Error> {
        let upload = self.inner.create_multipart(key).await.map_err(|_| ())?;
        sqlx::query(
            "UPDATE projects SET state='archived',archived_at=transaction_timestamp(), \
             updated_at=transaction_timestamp(),lock_version=lock_version+1 WHERE id=$1::uuid",
        )
        .bind(self.project_id.to_string())
        .execute(&mut *self.pool.acquire().await.map_err(|_| ())?)
        .await
        .map_err(|_| ())?;
        Ok(upload)
    }

    async fn presign_part(
        &self,
        request: PresignedMultipartPartRequest,
    ) -> Result<BoundedPresignedRequest, Self::Error> {
        self.inner
            .presign_multipart_part(request)
            .await
            .map_err(|_| ())
    }

    async fn complete(
        &self,
        upload: &MultipartUpload,
        parts: Vec<UploadedPart>,
    ) -> Result<(), Self::Error> {
        self.inner
            .complete_multipart(upload, parts)
            .await
            .map_err(|_| ())
    }

    async fn abort(&self, upload: &MultipartUpload) -> Result<(), Self::Error> {
        match self.abort_behavior {
            AbortBehavior::Confirmed => self.inner.abort_multipart(upload).await.map_err(|_| ()),
            AbortBehavior::Failed => Err(()),
            AbortBehavior::Hanging => std::future::pending().await,
        }
    }
}


impl MultipartStore for LostCompleteStore {
    type Error = ();

    async fn create(&self, key: ObjectKey) -> Result<MultipartUpload, Self::Error> {
        self.0.create_multipart(key).await.map_err(|_| ())
    }

    async fn presign_part(
        &self,
        request: PresignedMultipartPartRequest,
    ) -> Result<BoundedPresignedRequest, Self::Error> {
        self.0.presign_multipart_part(request).await.map_err(|_| ())
    }

    async fn complete(
        &self,
        upload: &MultipartUpload,
        parts: Vec<UploadedPart>,
    ) -> Result<(), Self::Error> {
        self.0
            .complete_multipart(upload, parts)
            .await
            .map_err(|_| ())?;
        Err(())
    }

    async fn abort(&self, upload: &MultipartUpload) -> Result<(), Self::Error> {
        self.0.abort_multipart(upload).await.map_err(|_| ())
    }
}


pub(crate) async fn verify_attach_failure_compensation(pool: &DatabasePool, config: &ObjectStorageConfig) {    for (project, scope, actor, key, behavior, timeout) in [
        (
            PROJECT_FAIL,
            SCOPE,
            USER,
            "multipart-attach-abort-ok",
            AbortBehavior::Confirmed,
            Duration::from_secs(5),
        ),
        (
            PROJECT_TIMEOUT,
            SCOPE,
            USER,
            "multipart-attach-abort-fail",
            AbortBehavior::Failed,
            Duration::from_secs(5),
        ),
        (
            ORG_PROJECT_OWNER,
            ORG_SCOPE,
            ORG_OWNER,
            "multipart-attach-abort-hang",
            AbortBehavior::Hanging,
            Duration::from_millis(500),
        ),
    ] {
        let inner = S3ObjectStore::new(config, OperationLimits::default())
            .await
            .unwrap();
        let service = MultipartService::new(
            pool.clone(),
            AttachFailureStore {
                inner,
                pool: pool.clone(),
                project_id: ProjectId::from_str(project).unwrap(),
                abort_behavior: behavior,
            },
            MultipartServicePolicy::new(timeout, 5, 8 * 1024 * 1024, 8 * 1024 * 1024, 4).unwrap(),
            IdempotencySecret::new([0x5a; 32]).unwrap(),
        )
        .unwrap();
        assert_eq!(
            service
                .create(multipart_request_for(scope, project, actor, key))
                .await
                .unwrap_err(),
            MultipartServiceError::CreateReconciliationRequired
        );
        let (session_id, state, create_status, reservations): (String, String, String, i64) =
            sqlx::query_as(
                "SELECT session.id::text,session.state,lifecycle.create_status, \
                 (SELECT COUNT(*) FROM storage_reservations reservation \
                  WHERE reservation.save_session_id=session.id) \
                 FROM save_sessions session JOIN multipart_lifecycles lifecycle \
                   ON lifecycle.save_session_id=session.id WHERE session.project_id=$1::uuid \
                   AND session.upload_mode='multipart'",
            )
            .bind(project)
            .fetch_one(&mut *pool.acquire().await.unwrap())
            .await
            .unwrap();
        match behavior {
            AbortBehavior::Confirmed => assert_eq!(
                (state.as_str(), create_status.as_str(), reservations),
                ("failed", "cleaned", 0)
            ),
            AbortBehavior::Failed | AbortBehavior::Hanging => {
                let expected_marker = match behavior {
                    AbortBehavior::Failed => "unknown",
                    AbortBehavior::Hanging => "creating",
                    AbortBehavior::Confirmed => unreachable!(),
                };
                assert_eq!(
                    (state.as_str(), create_status.as_str(), reservations),
                    ("created", expected_marker, 1)
                );
                assert!(
                    sqlx::query(
                        "UPDATE save_sessions SET state='failed',terminal_at=transaction_timestamp(), \
                         updated_at=transaction_timestamp() WHERE id=$1::uuid",
                    )
                    .bind(session_id)
                    .execute(&mut *pool.acquire().await.unwrap())
                    .await
                    .is_err()
                );
            }
        }
    }
}


pub(crate) async fn verify_complete_response_loss(    pool: &DatabasePool,
    config: &ObjectStorageConfig,
    ca_file: &str,
) {
    let store = S3ObjectStore::new(config, OperationLimits::default())
        .await
        .unwrap();
    let service = MultipartService::new(
        pool.clone(),
        LostCompleteStore(store),
        MultipartServicePolicy::new(
            Duration::from_secs(10),
            5,
            8 * 1024 * 1024,
            8 * 1024 * 1024,
            4,
        )
        .unwrap(),
        IdempotencySecret::new([0x5a; 32]).unwrap(),
    )
    .unwrap();
    let first = Bytes::from(vec![0x61; 8 * 1024 * 1024]);
    let second = Bytes::from_static(b"response-loss-tail");
    let request = multipart_request_for_bodies(
        ORG_SCOPE,
        ORG_PROJECT_WRITE,
        ORG_WRITE,
        "multipart-complete-loss",
        &[first.clone(), second.clone()],
    );
    let plans = request.parts.clone();
    let session = service.create(request).await.unwrap();
    let context = MultipartSessionContext {
        storage_scope_id: StorageScopeId::from_str(ORG_SCOPE).unwrap(),
        project_id: ProjectId::from_str(ORG_PROJECT_WRITE).unwrap(),
        actor_user_id: UserId::from_str(ORG_WRITE).unwrap(),
        session_id: session.session_id(),
    };
    let capabilities = service.issue_parts(context, plans.clone()).await.unwrap();
    let client = fixture_http_client(ca_file);
    let first_etag = send_multipart_part(&client, capabilities[0].request(), &first)
        .await
        .unwrap();
    let second_etag = send_multipart_part(&client, capabilities[1].request(), &second)
        .await
        .unwrap();
    service
        .record_receipts(
            context,
            vec![
                MultipartPartReceipt::new(
                    1,
                    plans[0].expected_bytes(),
                    plans[0].expected_sha256().clone(),
                    first_etag,
                )
                .unwrap(),
                MultipartPartReceipt::new(
                    2,
                    plans[1].expected_bytes(),
                    plans[1].expected_sha256().clone(),
                    second_etag,
                )
                .unwrap(),
            ],
        )
        .await
        .unwrap();
    assert_eq!(
        service.complete(context).await.unwrap_err(),
        MultipartServiceError::CompleteReconciliationRequired
    );
    let (state, complete_status, reservations): (String, String, i64) = sqlx::query_as(
        "SELECT session.state,lifecycle.complete_status, \
         (SELECT COUNT(*) FROM storage_reservations reservation \
          WHERE reservation.save_session_id=session.id) \
         FROM save_sessions session JOIN multipart_lifecycles lifecycle \
           ON lifecycle.save_session_id=session.id WHERE session.id=$1::uuid",
    )
    .bind(session.session_id().to_string())
    .fetch_one(&mut *pool.acquire().await.unwrap())
    .await
    .unwrap();
    assert_eq!(
        (state.as_str(), complete_status.as_str(), reservations),
        ("uploading", "unknown", 1)
    );
    assert!(
        sqlx::query(
            "UPDATE save_sessions SET state='failed',terminal_at=transaction_timestamp(), \
         updated_at=transaction_timestamp() WHERE id=$1::uuid",
        )
        .bind(session.session_id().to_string())
        .execute(&mut *pool.acquire().await.unwrap())
        .await
        .is_err()
    );
}


impl PutPresigner for FailingPresigner {
    type Error = ();

    async fn presign(
        &self,
        _request: PresignedPutRequest,
    ) -> Result<BoundedPresignedRequest, Self::Error> {
        Err(())
    }
}


impl PutPresigner for HangingPresigner {
    type Error = ();

    async fn presign(
        &self,
        _request: PresignedPutRequest,
    ) -> Result<BoundedPresignedRequest, Self::Error> {
        std::future::pending().await
    }
}


pub(crate) fn request(project: &str, idempotency: &str, body: &[u8]) -> CreateSinglePutSession {    request_for(SCOPE, project, USER, idempotency, body)
}


pub(crate) fn verification_context(    project: &str,
    session_id: nuriteo_server::quota::SaveSessionId,
) -> VerifyStagingBundle {
    VerifyStagingBundle {
        storage_scope_id: StorageScopeId::from_str(SCOPE).unwrap(),
        project_id: ProjectId::from_str(project).unwrap(),
        actor_user_id: UserId::from_str(USER).unwrap(),
        session_id,
    }
}


pub(crate) fn canonical_test_bundle(project: &str, scope: &str, path: &str, content: &[u8]) -> Vec<u8> {    let content_sha = hex_digest(content);
    let manifest = format!(
        "{{\"format\":\"project-bundle-v1\",\"schemaVersion\":1,\"project\":{{\"id\":\"{project}\",\"storageScopeId\":\"{scope}\"}},\"fileCount\":1,\"logicalBytes\":{},\"files\":[{{\"path\":\"{path}\",\"kind\":\"text\",\"mode\":\"0644\",\"sizeBytes\":{},\"sha256\":\"{content_sha}\"}}]}}\n",
        content.len(),
        content.len()
    );
    let mut archive = test_tar_entry("manifest.json", b'0', 0o644, manifest.as_bytes());
    let pax = test_pax_record(&format!("files/{path}"));
    archive.extend(test_tar_entry(
        "PaxHeaders/00000000",
        b'x',
        0o644,
        pax.as_bytes(),
    ));
    archive.extend(test_tar_entry("files/00000000", b'0', 0o644, content));
    archive.extend([0_u8; 1024]);
    archive
}


pub(crate) fn canonical_multi_file_bundle(project: &str, scope: &str, files: &[(String, Vec<u8>)]) -> Vec<u8> {    let logical_bytes = files
        .iter()
        .map(|(_, content)| content.len())
        .sum::<usize>();
    let manifest_files = files
        .iter()
        .map(|(path, content)| {
            format!(
                "{{\"path\":\"{path}\",\"kind\":\"binary\",\"mode\":\"0644\",\"sizeBytes\":{},\"sha256\":\"{}\"}}",
                content.len(),
                hex_digest(content)
            )
        })
        .collect::<Vec<_>>()
        .join(",");
    let manifest = format!(
        "{{\"format\":\"project-bundle-v1\",\"schemaVersion\":1,\"project\":{{\"id\":\"{project}\",\"storageScopeId\":\"{scope}\"}},\"fileCount\":{},\"logicalBytes\":{logical_bytes},\"files\":[{manifest_files}]}}\n",
        files.len()
    );
    let mut archive = test_tar_entry("manifest.json", b'0', 0o644, manifest.as_bytes());
    for (index, (path, content)) in files.iter().enumerate() {
        let sequence = format!("{index:08}");
        let pax = test_pax_record(&format!("files/{path}"));
        archive.extend(test_tar_entry(
            &format!("PaxHeaders/{sequence}"),
            b'x',
            0o644,
            pax.as_bytes(),
        ));
        archive.extend(test_tar_entry(
            &format!("files/{sequence}"),
            b'0',
            0o644,
            content,
        ));
    }
    archive.extend([0_u8; 1024]);
    archive
}


pub(crate) fn test_tar_entry(name: &str, kind: u8, mode: u64, content: &[u8]) -> Vec<u8> {    let mut header = [0_u8; 512];
    header[..name.len()].copy_from_slice(name.as_bytes());
    test_octal(&mut header[100..108], mode);
    test_octal(&mut header[108..116], 0);
    test_octal(&mut header[116..124], 0);
    test_octal(&mut header[124..136], content.len() as u64);
    test_octal(&mut header[136..148], 0);
    header[148..156].fill(b' ');
    header[156] = kind;
    header[257..263].copy_from_slice(b"ustar\0");
    header[263..265].copy_from_slice(b"00");
    let checksum: u64 = header.iter().map(|byte| u64::from(*byte)).sum();
    let checksum = format!("{checksum:06o}");
    header[148..154].copy_from_slice(checksum.as_bytes());
    header[154] = 0;
    header[155] = b' ';
    let mut entry = header.to_vec();
    entry.extend(content);
    entry.resize(entry.len() + ((512 - content.len() % 512) % 512), 0);
    entry
}


pub(crate) fn test_octal(target: &mut [u8], value: u64) {    let digits = format!("{:0width$o}", value, width = target.len() - 1);
    let count = target.len() - 1;
    target[..count].copy_from_slice(digits.as_bytes());
    target[count] = 0;
}


pub(crate) fn test_pax_record(path: &str) -> String {    let body = format!("path={path}\n");
    let mut length = body.len() + 2;
    loop {
        let record = format!("{length} {body}");
        if record.len() == length {
            return record;
        }
        length = record.len();
    }
}


pub(crate) fn hex_digest(bytes: &[u8]) -> String {    use std::fmt::Write as _;
    let mut value = String::with_capacity(64);
    for byte in Sha256::digest(bytes) {
        let _ = write!(value, "{byte:02x}");
    }
    value
}


pub(crate) fn find_bytes(haystack: &[u8], needle: &[u8]) -> Option<usize> {    haystack
        .windows(needle.len())
        .position(|window| window == needle)
}


pub(crate) fn multipart_request(project: &str, idempotency: &str, bodies: &[Bytes]) -> CreateMultipartSession {    multipart_request_for_bodies(SCOPE, project, USER, idempotency, bodies)
}


pub(crate) fn multipart_request_for_bodies(    scope: &str,
    project: &str,
    actor: &str,
    idempotency: &str,
    bodies: &[Bytes],
) -> CreateMultipartSession {
    let parts = bodies
        .iter()
        .enumerate()
        .map(|(index, body)| {
            MultipartPartPlan::new(
                u16::try_from(index + 1).unwrap(),
                body.len() as u64,
                Sha256Checksum::calculate(body),
            )
        })
        .collect::<Vec<_>>();
    let total = parts.iter().map(MultipartPartPlan::expected_bytes).sum();
    CreateMultipartSession {
        storage_scope_id: StorageScopeId::from_str(scope).unwrap(),
        project_id: ProjectId::from_str(project).unwrap(),
        actor_user_id: UserId::from_str(actor).unwrap(),
        expected_project_version: ProjectVersion::new(1).unwrap(),
        expected_physical_bytes: total,
        expected_logical_bytes: 0,
        expected_file_count: 0,
        expected_sha256: Sha256Checksum::from_bytes([0x73; 32]),
        effective_quota: EffectiveQuota::unlimited(),
        idempotency_key: IdempotencyKey::new(idempotency.to_owned()).unwrap(),
        parts,
    }
}


pub(crate) fn multipart_request_for(    scope: &str,
    project: &str,
    actor: &str,
    idempotency: &str,
) -> CreateMultipartSession {
    let first = Bytes::from(vec![0x51; 8 * 1024 * 1024]);
    let second = Bytes::from_static(b"attach-failure-tail");
    let mut request = multipart_request(project, idempotency, &[first, second]);
    request.storage_scope_id = StorageScopeId::from_str(scope).unwrap();
    request.actor_user_id = UserId::from_str(actor).unwrap();
    request
}


pub(crate) fn multipart_boundary_request(project: &str, idempotency: &str) -> CreateMultipartSession {    let part_size = 16 * 1024 * 1024_u64;
    let parts = (1..=128)
        .map(|number| {
            MultipartPartPlan::new(
                number,
                part_size,
                Sha256Checksum::from_bytes([u8::try_from(number).unwrap(); 32]),
            )
        })
        .collect();
    CreateMultipartSession {
        storage_scope_id: StorageScopeId::from_str(SCOPE).unwrap(),
        project_id: ProjectId::from_str(project).unwrap(),
        actor_user_id: UserId::from_str(USER).unwrap(),
        expected_project_version: ProjectVersion::new(1).unwrap(),
        expected_physical_bytes: 2 * 1024 * 1024 * 1024,
        expected_logical_bytes: 0,
        expected_file_count: 0,
        expected_sha256: Sha256Checksum::from_bytes([0x74; 32]),
        effective_quota: EffectiveQuota::unlimited(),
        idempotency_key: IdempotencyKey::new(idempotency.to_owned()).unwrap(),
        parts,
    }
}


pub(crate) fn request_for(    storage_scope: &str,
    project: &str,
    actor: &str,
    idempotency: &str,
    body: &[u8],
) -> CreateSinglePutSession {
    CreateSinglePutSession {
        storage_scope_id: StorageScopeId::from_str(storage_scope).unwrap(),
        project_id: ProjectId::from_str(project).unwrap(),
        actor_user_id: UserId::from_str(actor).unwrap(),
        expected_project_version: ProjectVersion::new(1).unwrap(),
        expected_physical_bytes: body.len() as u64,
        expected_logical_bytes: 0,
        expected_file_count: 0,
        expected_sha256: Sha256Checksum::calculate(body),
        effective_quota: EffectiveQuota::limited(1_000_000).unwrap(),
        idempotency_key: IdempotencyKey::new(idempotency.to_owned()).unwrap(),
    }
}


pub(crate) async fn verify_authorization(service: &SinglePutService, body: &[u8]) {    assert_eq!(
        service
            .create(request_for(
                SCOPE,
                PROJECT_B,
                OUTSIDER,
                "personal-outsider-01",
                body,
            ))
            .await
            .unwrap_err(),
        SinglePutServiceError::ProjectNotFound
    );
    service
        .create(request_for(
            ORG_SCOPE,
            ORG_PROJECT_OWNER,
            ORG_OWNER,
            "org-owner-save-0001",
            body,
        ))
        .await
        .unwrap();
    service
        .create(request_for(
            ORG_SCOPE,
            ORG_PROJECT_WRITE,
            ORG_WRITE,
            "org-write-save-0001",
            body,
        ))
        .await
        .unwrap();
    for (project, actor, key) in [
        (ORG_PROJECT_READ, ORG_READ, "org-read-denied-001"),
        (ORG_PROJECT_MEMBER, ORG_MEMBER, "org-member-denied1"),
        (ORG_PROJECT_OUTSIDER, OUTSIDER, "org-outsider-deny1"),
    ] {
        assert_eq!(
            service
                .create(request_for(ORG_SCOPE, project, actor, key, body))
                .await
                .unwrap_err(),
            SinglePutServiceError::ProjectNotFound
        );
    }
}


pub(crate) async fn send_with_mutation(    client: &reqwest::Client,
    capability: &BoundedPresignedRequest,
    body: &[u8],
    header_override: Option<(&str, &str)>,
    url_replacement: Option<(&str, &str)>,
) -> bool {
    let url = if let Some((from, to)) = url_replacement {
        let changed = capability.expose_bearer_url().replace(from, to);
        assert_ne!(changed, capability.expose_bearer_url());
        changed
    } else {
        capability.expose_bearer_url().to_owned()
    };
    let mut request = client.put(url);
    for (name, value) in capability.signed_headers() {
        if header_override.is_none_or(|(override_name, _)| override_name != name) {
            request = request.header(name, value);
        }
    }
    if let Some((name, value)) = header_override {
        request = request.header(name, value);
    }
    request
        .body(body.to_vec())
        .send()
        .await
        .map(|response| response.status().is_success())
        .unwrap_or(false)
}


pub(crate) async fn send_multipart_part(    client: &reqwest::Client,
    capability: &BoundedPresignedRequest,
    body: &[u8],
) -> Option<String> {
    let mut request = client.put(capability.expose_bearer_url());
    for (name, value) in capability.signed_headers() {
        request = request.header(name, value);
    }
    let response = request.body(body.to_vec()).send().await.ok()?;
    if !response.status().is_success() {
        return None;
    }
    response
        .headers()
        .get(reqwest::header::ETAG)
        .and_then(|value| value.to_str().ok())
        .map(str::to_owned)
}


pub(crate) fn fixture_http_client(ca_file: &str) -> reqwest::Client {    let certificate = reqwest::Certificate::from_pem(&fs::read(ca_file).unwrap()).unwrap();
    reqwest::Client::builder()
        .add_root_certificate(certificate)
        .timeout(Duration::from_secs(2))
        .build()
        .unwrap()
}


pub(crate) fn version_http_router(pool: DatabasePool) -> Router {    let external_url = Url::parse(WEB_ORIGIN).unwrap();
    let auth = AuthService::production(
        pool.clone(),
        &external_url,
        AuthPolicy::default(),
        SessionPolicy::default(),
    )
    .unwrap();
    let projects = ProjectHttpService::production(
        pool,
        &external_url,
        ProjectHttpPolicy::default(),
        SessionPolicy::default(),
    )
    .unwrap();
    build_router_with_project_service(
        HealthService::unconfigured(),
        auth,
        InvitationHttpService::unconfigured(),
        OrganizationHttpService::unconfigured(),
        projects,
        SetupStatusService::unconfigured(),
    )
}


pub(crate) async fn save_http_service(    pool: DatabasePool,
    store: S3ObjectStore,
    secret: IdempotencySecret,
) -> Result<(ProjectHttpService, SaveHttpService), SaveHttpError> {
    save_http_service_with_transport(pool, store, secret, SaveUploadTransport::Direct).await
}


pub(crate) async fn save_http_service_with_transport(    pool: DatabasePool,
    store: S3ObjectStore,
    secret: IdempotencySecret,
    transport: SaveUploadTransport,
) -> Result<(ProjectHttpService, SaveHttpService), SaveHttpError> {
    let external_url = Url::parse(WEB_ORIGIN).unwrap();
    let projects = ProjectHttpService::production_with_content(
        pool.clone(),
        &external_url,
        ProjectHttpPolicy::default(),
        SessionPolicy::default(),
        store.clone(),
        ContentServicePolicy::default(),
    )
    .unwrap();
    let save = SaveHttpService::production(
        pool,
        projects.clone(),
        store,
        secret,
        EffectiveQuota::limited(10 * 1024 * 1024 * 1024).unwrap(),
        transport,
        SaveHttpPolicy::default(),
        CleanupWorkerPolicy::default(),
    )
    .await?;
    Ok((projects, save))
}


pub(crate) async fn save_http_router_with_transport(    pool: DatabasePool,
    store: S3ObjectStore,
    secret: IdempotencySecret,
    transport: SaveUploadTransport,
) -> Result<Router, SaveHttpError> {
    let external_url = Url::parse(WEB_ORIGIN).unwrap();
    let auth = AuthService::production(
        pool.clone(),
        &external_url,
        AuthPolicy::default(),
        SessionPolicy::default(),
    )
    .unwrap();
    let (projects, save) = save_http_service_with_transport(pool, store, secret, transport).await?;
    Ok(build_router_with_save_service(
        HealthService::unconfigured(),
        auth,
        InvitationHttpService::unconfigured(),
        OrganizationHttpService::unconfigured(),
        projects,
        save,
        SetupStatusService::unconfigured(),
    ))
}


pub(crate) async fn save_http_router(    pool: DatabasePool,
    store: S3ObjectStore,
    secret: IdempotencySecret,
) -> Result<Router, SaveHttpError> {
    let external_url = Url::parse(WEB_ORIGIN).unwrap();
    let auth = AuthService::production(
        pool.clone(),
        &external_url,
        AuthPolicy::default(),
        SessionPolicy::default(),
    )
    .unwrap();
    let (projects, save) = save_http_service(pool, store, secret).await?;
    Ok(build_router_with_save_service(
        HealthService::unconfigured(),
        auth,
        InvitationHttpService::unconfigured(),
        OrganizationHttpService::unconfigured(),
        projects,
        save,
        SetupStatusService::unconfigured(),
    ))
}
