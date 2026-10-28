#![expect(
    unused_imports,
    reason = "imports are repeated for the split test modules"
)]
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

const DATABASE_URL_ENV: &str = "NURITEO_TEST_DATABASE_URL";

const DATABASE_CA_ENV: &str = "NURITEO_TEST_DATABASE_CA";

const S3_ENDPOINT_ENV: &str = "NURITEO_TEST_S3_ENDPOINT";

const S3_CA_ENV: &str = "NURITEO_TEST_S3_CA_FILE";

const BUCKET: &str = "nuriteo-save-003";

const ACCESS_KEY: &str = "save003-access";

const SECRET_KEY: &str = "save003-secret-0123456789";

const WEB_ORIGIN: &str = "http://localhost:3000";

const TEST_PASSWORD: &str = "correct horse battery staple";

const TEST_PASSWORD_HASH: &str = "$argon2id$v=19$m=19456,t=2,p=1$a25vd24tc2FsdC12YWx1ZQ$yERZcGD1B/gLkNTYDHwutSjFbbs93oG/oqH/OErHrm0";

const USER: &str = "0199ee6c-c777-7000-8000-000000008001";

const SCOPE: &str = "0199ee6c-c777-7000-8000-000000008010";

const PROJECT_A: &str = "0199ee6c-c777-7000-8000-000000008020";

const PROJECT_B: &str = "0199ee6c-c777-7000-8000-000000008021";

const PROJECT_FAIL: &str = "0199ee6c-c777-7000-8000-000000008022";

const PROJECT_TIMEOUT: &str = "0199ee6c-c777-7000-8000-000000008023";

const PROJECT_LEASE_ABORT: &str = "0199ee6c-c777-7000-8000-000000008026";

const PROJECT_LEASE_EXPIRE: &str = "0199ee6c-c777-7000-8000-000000008027";

const PROJECT_LEASE_COMPLETE: &str = "0199ee6c-c777-7000-8000-000000008028";

const PROJECT_MULTI_EXPIRY: &str = "0199ee6c-c777-7000-8000-000000008029";

const PROJECT_LEASE_CLOCK: &str = "0199ee6c-c777-7000-8000-00000000802a";

const PROJECT_HISTORY_LEFT: &str = "0199ee6c-c777-7000-8000-000000008024";

const PROJECT_HISTORY_RIGHT: &str = "0199ee6c-c777-7000-8000-000000008025";

const OUTSIDER: &str = "0199ee6c-c777-7000-8000-000000008002";

const ORG_OWNER: &str = "0199ee6c-c777-7000-8000-000000008003";

const ORG_READ: &str = "0199ee6c-c777-7000-8000-000000008004";

const ORG_WRITE: &str = "0199ee6c-c777-7000-8000-000000008005";

const ORG_MEMBER: &str = "0199ee6c-c777-7000-8000-000000008006";

const ORG_SCOPE: &str = "0199ee6c-c777-7000-8000-000000008031";

const ORG: &str = "0199ee6c-c777-7000-8000-000000008030";

const ORG_PROJECT_OWNER: &str = "0199ee6c-c777-7000-8000-000000008040";

const ORG_PROJECT_READ: &str = "0199ee6c-c777-7000-8000-000000008041";

const ORG_PROJECT_WRITE: &str = "0199ee6c-c777-7000-8000-000000008042";

const ORG_PROJECT_MEMBER: &str = "0199ee6c-c777-7000-8000-000000008043";

const ORG_PROJECT_OUTSIDER: &str = "0199ee6c-c777-7000-8000-000000008044";

const ORG_PROJECT_MULTI_REVOKE: &str = "0199ee6c-c777-7000-8000-000000008045";

const ORG_PROJECT_MULTI_ARCHIVE: &str = "0199ee6c-c777-7000-8000-000000008046";

type PersistedRelaySecretRow = (String, Vec<u8>, Vec<u8>, Option<String>);

struct FixtureEnvironment {
    endpoint: String,
    ca_file: String,
}

#[derive(Clone, Copy)]
enum AbortBehavior {
    Confirmed,
    Failed,
    Hanging,
}

#[derive(Clone)]
struct AttachFailureStore {
    inner: S3ObjectStore,
    pool: DatabasePool,
    project_id: ProjectId,
    abort_behavior: AbortBehavior,
}

#[derive(Clone)]
struct LostCompleteStore(S3ObjectStore);

#[derive(Clone)]
struct FailingPresigner;

#[derive(Clone)]
struct HangingPresigner;

#[derive(Clone)]
struct VersionBrowser {
    cookie: String,
    csrf: String,
}

struct RelayMultipartFixture {
    session_id: String,
    capabilities: Vec<Value>,
    bodies: Vec<Bytes>,
}

#[derive(Clone)]
struct CapturedLogWriter(std::sync::Arc<std::sync::Mutex<Vec<u8>>>);

struct NeverReadBody;

struct BoundedFrameBody {
    content: Bytes,
    offset: usize,
}

struct ObservedFrameBody {
    body: BoundedFrameBody,
    polled: std::sync::Arc<std::sync::atomic::AtomicBool>,
}

struct GatedFrameBody {
    receiver: tokio::sync::mpsc::Receiver<Bytes>,
    remaining: u64,
}

#[path = "single_put_save/verifier.rs"]
mod verifier;
pub(crate) use verifier::*;
#[path = "single_put_save/working_head.rs"]
mod working_head;
pub(crate) use working_head::*;
#[path = "single_put_save/save_http.rs"]
mod save_http;
pub(crate) use save_http::*;
#[path = "single_put_save/relay_multipart.rs"]
mod relay_multipart;
pub(crate) use relay_multipart::*;
#[path = "single_put_save/relay_streams.rs"]
mod relay_streams;
pub(crate) use relay_streams::*;
#[path = "single_put_save/versions.rs"]
mod versions;
pub(crate) use versions::*;
#[path = "single_put_save/history.rs"]
mod history;
pub(crate) use history::*;
#[path = "single_put_save/admission.rs"]
mod admission;
pub(crate) use admission::*;
#[path = "single_put_save/fake_store.rs"]
mod fake_store;
pub(crate) use fake_store::*;
#[path = "single_put_save/relay_client.rs"]
mod relay_client;
pub(crate) use relay_client::*;
#[path = "single_put_save/postgres_bucket.rs"]
mod postgres_bucket;
pub(crate) use postgres_bucket::*;
