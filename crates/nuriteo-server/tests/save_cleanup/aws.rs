#![allow(unused_imports)]
use super::bounds::*;
use super::materialization::*;
use super::s3_env::*;
use super::*;
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

use super::{
    ABORT_PROJECT, ACCESS_KEY, ATTACHED_PROJECT, BACKFILL_PROJECT, BUCKET,
    COMPLETE_MISSING_PROJECT, COMPLETE_PROJECT, DATABASE_CA_ENV, DATABASE_URL_ENV,
    FixtureEnvironment, KNOWN_PROJECT, MULTIPART_PROJECT, NORMAL_COMPLETE_PROJECT, OUTSIDER,
    RACE_PROJECT, RACED_PROJECT, S3_CA_ENV, S3_ENDPOINT_ENV, SCOPE, SECRET_KEY, USER,
};
use sqlx::{Acquire, Executor};

pub(crate) fn aws_client(endpoint: &str, ca_file: &str) -> aws_sdk_s3::Client {
    let context = TlsContext::builder()
        .with_trust_store(TrustStore::default().with_pem_certificate(fs::read(ca_file).unwrap()))
        .build()
        .unwrap();
    let pool = ConnectionPool::builder()
        .tls_provider(tls::Provider::Rustls(CryptoMode::Ring))
        .tls_context(context)
        .build_https()
        .unwrap();
    aws_sdk_s3::Client::from_conf(
        aws_sdk_s3::Config::builder()
            .behavior_version(BehaviorVersion::latest())
            .endpoint_url(endpoint)
            .region(Region::new("us-east-1"))
            .force_path_style(true)
            .credentials_provider(Credentials::new(
                ACCESS_KEY,
                SECRET_KEY,
                None,
                None,
                "save009-fixture",
            ))
            .http_client(PoolClient::new(&pool).unwrap())
            .build(),
    )
}
