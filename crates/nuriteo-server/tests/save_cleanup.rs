#![expect(
    unused_imports,
    reason = "imports are repeated for the split test modules"
)]
use std::env;

use std::ffi::OsString;

use std::fs;

use std::str::FromStr;

use std::time::Duration;

use aws_sdk_s3::config::{BehaviorVersion, Credentials, Region};

use aws_smithy_http_client::pool::{Client as PoolClient, ConnectionPool};

use aws_smithy_http_client::tls::rustls_provider::CryptoMode;

use aws_smithy_http_client::tls::{self, TlsContext, TrustStore};

use bytes::Bytes;

use nuriteo_server::config::{Environment, InstanceSettingBootstrap, SystemFileReader};

use nuriteo_server::database::{
    DatabasePool, DatabasePoolConfig, DatabaseTlsConfig, MigrationOptions, run_embedded_migrations,
};

use nuriteo_server::identity::UserId;

use nuriteo_server::instance_settings::InstanceSettingsRepository;

use nuriteo_server::object_storage::{
    MIN_MULTIPART_PART_BYTES, MultipartLimits, MultipartPartRequest, ObjectKey,
    ObjectStorageConfig, OperationLimits, PresignExpiry, PresignedPutRequest, S3ObjectStore,
    Sha256Checksum,
};

use nuriteo_server::policy::PolicyMaintenanceWorker;

use nuriteo_server::project::ProjectId;

use nuriteo_server::quota::SaveSessionId;

use nuriteo_server::save::{
    AbortSaveSession, AbortSaveSessionResult, CleanupOperationsPolicy, CleanupOperationsService,
    CleanupOperatorState, CleanupService, CleanupWorkerPolicy, WorkerShutdown,
};

use nuriteo_server::workspace::StorageScopeId;

use sha2::{Digest, Sha256};

use sqlx::{Acquire, Executor};

const DATABASE_URL_ENV: &str = "NURITEO_TEST_DATABASE_URL";

const DATABASE_CA_ENV: &str = "NURITEO_TEST_DATABASE_CA";

const S3_ENDPOINT_ENV: &str = "NURITEO_TEST_S3_ENDPOINT";

const S3_CA_ENV: &str = "NURITEO_TEST_S3_CA_FILE";

const BUCKET: &str = "nuriteo-save-009";

const ACCESS_KEY: &str = "save009-access";

const SECRET_KEY: &str = "save009-secret-0123456789";

const USER: &str = "0199ee6c-c777-7000-8000-000000009001";

const OUTSIDER: &str = "0199ee6c-c777-7000-8000-000000009002";

const SCOPE: &str = "0199ee6c-c777-7000-8000-000000009010";

const ABORT_PROJECT: &str = "0199ee6c-c777-7000-8000-000000009020";

const MULTIPART_PROJECT: &str = "0199ee6c-c777-7000-8000-000000009021";

const RACE_PROJECT: &str = "0199ee6c-c777-7000-8000-000000009022";

const BACKFILL_PROJECT: &str = "0199ee6c-c777-7000-8000-000000009023";

const ATTACHED_PROJECT: &str = "0199ee6c-c777-7000-8000-000000009024";

const RACED_PROJECT: &str = "0199ee6c-c777-7000-8000-000000009025";

const KNOWN_PROJECT: &str = "0199ee6c-c777-7000-8000-000000009026";

const COMPLETE_PROJECT: &str = "0199ee6c-c777-7000-8000-000000009027";

const COMPLETE_MISSING_PROJECT: &str = "0199ee6c-c777-7000-8000-000000009028";

const NORMAL_COMPLETE_PROJECT: &str = "0199ee6c-c777-7000-8000-000000009029";

struct FixtureEnvironment {
    endpoint: String,
    ca_file: String,
}

#[path = "save_cleanup/s3_env.rs"]
mod s3_env;
pub(crate) use s3_env::*;
#[path = "save_cleanup/bounds.rs"]
mod bounds;
pub(crate) use bounds::*;
#[path = "save_cleanup/materialization.rs"]
mod materialization;
pub(crate) use materialization::*;
#[path = "save_cleanup/aws.rs"]
mod aws;
pub(crate) use aws::*;
