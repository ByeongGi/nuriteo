mod load;
mod redaction;
mod schema;
mod validation;

use std::fmt;
use std::io;
use std::net::SocketAddr;

pub use load::{Environment, FileReader, SystemEnvironment, SystemFileReader};
pub use redaction::SecretString;
pub use schema::{CONFIG_FIELDS, ConfigField};
use url::Url;

#[derive(Debug, Clone, PartialEq, Eq)]
pub struct Config {
    pub server: ServerConfig,
    pub public: PublicConfig,
    pub database: DatabaseConfig,
    pub object_storage: ObjectStorageConfig,
    pub crypto: CryptoConfig,
}

impl Config {
    /// Loads, validates, and returns the complete startup configuration.
    ///
    /// Loading is side-effect free when callers provide injected sources. Use
    /// [`SystemEnvironment`] and [`SystemFileReader`] at the binary boundary.
    pub fn load(
        environment: &impl Environment,
        files: &impl FileReader,
    ) -> Result<Self, ConfigError> {
        load::from_sources(environment, files)
    }
}

#[derive(Debug, Clone, PartialEq, Eq)]
pub struct ServerConfig {
    pub listen_addr: SocketAddr,
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
    pub preview_base_domain: String,
}

#[derive(Debug, Clone, PartialEq, Eq)]
pub struct DatabaseConfig {
    pub url: SecretString,
}

#[derive(Debug, Clone, PartialEq, Eq)]
pub struct ObjectStorageConfig {
    pub endpoint: Url,
    pub region: String,
    pub bucket: String,
    pub path_style: bool,
    pub access_key_id: SecretString,
    pub secret_access_key: SecretString,
}

#[derive(Debug, Clone, PartialEq, Eq)]
pub struct CryptoConfig {
    pub master_key: SecretString,
    pub session_key: SecretString,
}

#[derive(Debug, PartialEq, Eq)]
pub enum ConfigError {
    Missing {
        name: &'static str,
    },
    Empty {
        name: &'static str,
    },
    EmptySecretFile {
        name: &'static str,
    },
    ConflictingSources {
        name: &'static str,
        file_name: &'static str,
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
    ReadSecret {
        name: &'static str,
        kind: io::ErrorKind,
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
            Self::EmptySecretFile { name } => {
                write!(
                    formatter,
                    "secret file referenced by {name} must not be empty"
                )
            }
            Self::ConflictingSources { name, file_name } => write!(
                formatter,
                "configuration {name} and {file_name} cannot both be set"
            ),
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
            Self::ReadSecret { name, kind } => {
                write!(
                    formatter,
                    "could not read secret file referenced by {name}: {kind}"
                )
            }
        }
    }
}

impl std::error::Error for ConfigError {}

#[cfg(test)]
mod tests;
