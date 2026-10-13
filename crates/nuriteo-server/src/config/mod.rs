mod instance_settings;
mod load;
mod redaction;
mod schema;
mod validation;

use std::fmt;
use std::io;
use std::net::SocketAddr;
use std::time::Duration;

use crate::save::CleanupWorkerPolicy;
pub use instance_settings::{
    BootstrapSettingOrigin, INSTANCE_SETTING_DEFINITIONS, INSTANCE_SETTING_REGISTRY_VERSION,
    InstanceSettingBootstrap, InstanceSettingBootstrapError, InstanceSettingDefinition,
    InstanceSettingValidationError, SettingApplyMode, SettingConstraint, SettingSensitivity,
    instance_setting_definition,
};
pub use load::{Environment, FileReader, SystemEnvironment, SystemFileReader, load_secret};
pub use redaction::SecretString;
pub use schema::{CONFIG_FIELDS, ConfigField};
use url::Url;

#[derive(Debug, Clone, PartialEq, Eq)]
pub struct Config {
    pub server: ServerConfig,
    pub public: PublicConfig,
    pub cleanup: CleanupConfig,
}

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub struct CleanupConfig {
    pub worker_policy: CleanupWorkerPolicy,
    pub stale_threshold: Duration,
    pub failed_threshold: u64,
    pub status_timeout: Duration,
}

impl Config {
    /// Loads and validates startup configuration from TOML and environment sources.
    ///
    /// Environment values override TOML values. Callers receive unknown-variable
    /// warnings when strict environment checking is disabled.
    pub fn load(
        environment: &impl Environment,
        files: &impl FileReader,
    ) -> Result<LoadReport, ConfigError> {
        load::from_sources(environment, files)
    }
}

#[derive(Debug, Clone, PartialEq, Eq)]
pub struct LoadReport {
    pub config: Config,
    pub instance_settings: InstanceSettingBootstrap,
    pub warnings: Vec<ConfigWarning>,
}

#[derive(Debug, Clone, PartialEq, Eq)]
pub enum ConfigWarning {
    UnknownEnvironmentVariable { name: String },
}

#[derive(Debug, Clone, PartialEq, Eq)]
pub struct ServerConfig {
    pub listen_addr: SocketAddr,
    pub management_listen_addr: SocketAddr,
    pub shutdown_drain_timeout: Duration,
    pub log_format: LogFormat,
    pub log_level: LogLevel,
}

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum LogFormat {
    Text,
    Json,
}

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum LogLevel {
    Error,
    Warn,
    Info,
    Debug,
}

#[derive(Debug, Clone, PartialEq, Eq)]
pub struct PublicConfig {
    pub external_url: Url,
    pub preview_base_domain: Option<String>,
}

#[derive(Debug, PartialEq, Eq)]
pub enum ConfigError {
    Missing {
        name: &'static str,
    },
    Empty {
        name: &'static str,
    },
    Duplicate {
        name: String,
    },
    Unknown {
        names: Vec<String>,
    },
    NonUnicodeName,
    NonUnicodeValue {
        name: String,
    },
    Invalid {
        name: &'static str,
        reason: &'static str,
    },
    ReadFile {
        name: &'static str,
        kind: io::ErrorKind,
    },
    FileTooLarge {
        name: &'static str,
        limit: usize,
    },
    InvalidUtf8 {
        name: &'static str,
    },
    InvalidToml,
    InstanceSetting(InstanceSettingBootstrapError),
    ConflictingSecretSources {
        name: &'static str,
        file_name: &'static str,
    },
    EmptySecretFile {
        name: &'static str,
    },
    InvalidSecretFile {
        name: &'static str,
    },
}

impl ConfigError {
    pub(super) const fn invalid(name: &'static str, reason: &'static str) -> Self {
        Self::Invalid { name, reason }
    }
}

impl fmt::Display for ConfigError {
    fn fmt(&self, formatter: &mut fmt::Formatter<'_>) -> fmt::Result {
        match self {
            Self::Missing { name } => write!(formatter, "required configuration {name} is missing"),
            Self::Empty { name } => write!(formatter, "configuration {name} must not be empty"),
            Self::Duplicate { name } => {
                write!(formatter, "configuration {name} is set more than once")
            }
            Self::Unknown { names } => write!(
                formatter,
                "unknown NURITEO configuration variable(s): {}",
                names.join(", ")
            ),
            Self::NonUnicodeName => {
                formatter.write_str("a NURITEO configuration name is not valid Unicode")
            }
            Self::NonUnicodeValue { name } => {
                write!(formatter, "configuration {name} is not valid Unicode")
            }
            Self::Invalid { name, reason } => write!(formatter, "configuration {name} {reason}"),
            Self::ReadFile { name, kind } => {
                write!(
                    formatter,
                    "could not read file referenced by {name}: {kind}"
                )
            }
            Self::FileTooLarge { name, limit } => {
                write!(formatter, "file referenced by {name} exceeds {limit} bytes")
            }
            Self::InvalidUtf8 { name } => {
                write!(formatter, "file referenced by {name} is not valid UTF-8")
            }
            Self::InvalidToml => formatter.write_str("NURITEO configuration file is invalid"),
            Self::InstanceSetting(error) => error.fmt(formatter),
            Self::ConflictingSecretSources { name, file_name } => write!(
                formatter,
                "configuration {name} and {file_name} cannot both be set"
            ),
            Self::EmptySecretFile { name } => {
                write!(
                    formatter,
                    "secret file referenced by {name} must not be empty"
                )
            }
            Self::InvalidSecretFile { name } => write!(
                formatter,
                "secret file referenced by {name} contains an invalid value"
            ),
        }
    }
}

impl std::error::Error for ConfigError {}

#[cfg(test)]
mod tests;
