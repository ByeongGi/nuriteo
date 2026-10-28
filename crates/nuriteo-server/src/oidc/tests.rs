use super::*;

use std::env;

use std::ffi::OsString;

use std::fs;

use std::io;

use std::path::Path;

use base64::Engine;

use base64::engine::general_purpose::URL_SAFE_NO_PAD;

use sha2::{Digest, Sha256};

use crate::config::{Environment, FileReader, InstanceSettingBootstrap};

use crate::database::{
    DatabasePool, DatabasePoolConfig, DatabaseTlsConfig, MigrationOptions, run_embedded_migrations,
};

use crate::identity::{
    IssuedSession, SessionId, SessionPolicy, SessionRotationKind, SessionService,
    SessionServiceError, SessionToken, UserId,
};

use crate::instance_settings::InstanceSettingsRepository;

use crate::integration::{
    CaCandidatePreflight, CaEndpointBinding, CaPreflightProof, IntegrationAdminActor,
    IntegrationAdminService, IntegrationError, MasterKeyring, ValidatedCaBundle,
};

use std::future::Future;

use std::pin::Pin;

use url::Url;

struct ExactPreflight;

#[derive(Clone)]
struct TestEnvironment(Vec<(OsString, OsString)>);

struct NoFiles;

mod provider_validation;
pub(crate) use provider_validation::*;
mod authorization_code;
pub(crate) use authorization_code::*;
mod identity_linking;
pub(crate) use identity_linking::*;
