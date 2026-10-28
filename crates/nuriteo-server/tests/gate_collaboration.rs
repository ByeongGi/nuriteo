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


#[derive(Clone)]
struct Browser {
    cookie: String,
    csrf: String,
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


struct StorageEnvironment(Vec<(OsString, OsString)>);

#[path = "gate_collaboration/journey.rs"]
mod journey;
pub(crate) use journey::*;
#[path = "gate_collaboration/stack.rs"]
mod stack;
pub(crate) use stack::*;
