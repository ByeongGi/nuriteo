#![allow(unused_imports)]
use super::*;
use super::bounds::*;
use super::materialization::*;
use super::aws::*;
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
use super::{DATABASE_URL_ENV, DATABASE_CA_ENV, S3_ENDPOINT_ENV, S3_CA_ENV, BUCKET, ACCESS_KEY, SECRET_KEY, USER, OUTSIDER, SCOPE, ABORT_PROJECT, MULTIPART_PROJECT, RACE_PROJECT, BACKFILL_PROJECT, ATTACHED_PROJECT, RACED_PROJECT, KNOWN_PROJECT, COMPLETE_PROJECT, COMPLETE_MISSING_PROJECT, NORMAL_COMPLETE_PROJECT, FixtureEnvironment};



impl Environment for super::FixtureEnvironment { fn entries(&self) -> Vec<(OsString, OsString)> {
        [
            ("NURITEO_S3_ENDPOINT", self.endpoint.as_str()),
            ("NURITEO_S3_REGION", "us-east-1"),
            ("NURITEO_S3_BUCKET", BUCKET),
            ("NURITEO_S3_ADDRESSING_STYLE", "path"),
            ("NURITEO_S3_CREDENTIAL_PROVIDER", "static"),
            ("NURITEO_S3_ACCESS_KEY_ID", ACCESS_KEY),
            ("NURITEO_S3_SECRET_ACCESS_KEY", SECRET_KEY),
            ("NURITEO_S3_CA_FILE", self.ca_file.as_str()),
        ]
        .into_iter()
        .map(|(name, value)| (OsString::from(name), OsString::from(value)))
        .collect()
    }
}
