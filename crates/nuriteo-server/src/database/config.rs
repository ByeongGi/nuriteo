use std::collections::BTreeMap;
use std::ffi::OsString;
use std::fmt;
use std::io;
use std::path::Path;
use std::time::Duration;

use crate::config::{ConfigError, Environment, FileReader, load_secret};

use super::{
    ClientIdentity, DatabaseConfigError, DatabasePoolConfig, DatabaseTlsConfig, MigrationError,
    MigrationOptions, TlsConfigError,
};

const DATABASE_URL: &str = "NURITEO_DATABASE_URL";
const DATABASE_URL_FILE: &str = "NURITEO_DATABASE_URL_FILE";
const MIN_CONNECTIONS: &str = "NURITEO_DATABASE_MIN_CONNECTIONS";
const MAX_CONNECTIONS: &str = "NURITEO_DATABASE_MAX_CONNECTIONS";
const CONNECT_TIMEOUT_MS: &str = "NURITEO_DATABASE_CONNECT_TIMEOUT_MS";
const ACQUIRE_TIMEOUT_MS: &str = "NURITEO_DATABASE_ACQUIRE_TIMEOUT_MS";
const CLOSE_TIMEOUT_MS: &str = "NURITEO_DATABASE_CLOSE_TIMEOUT_MS";
const MIGRATION_LOCK_TIMEOUT_MS: &str = "NURITEO_DATABASE_MIGRATION_LOCK_TIMEOUT_MS";
const MIGRATION_TIMEOUT_MS: &str = "NURITEO_DATABASE_MIGRATION_TIMEOUT_MS";
const TLS_MODE: &str = "NURITEO_DATABASE_TLS_MODE";
const INSTANCE_CA_FILE: &str = "NURITEO_INSTANCE_CA_FILE";
const DATABASE_CA_FILE: &str = "NURITEO_DATABASE_CA_FILE";
const CLIENT_CERT_FILE: &str = "NURITEO_DATABASE_CLIENT_CERT_FILE";
const CLIENT_KEY_FILE: &str = "NURITEO_DATABASE_CLIENT_KEY_FILE";

const MAX_TLS_FILE_BYTES: usize = 256 * 1024;

/// Fully validated inputs for the explicit database operational commands.
#[derive(Clone)]
pub struct DatabaseRuntimeConfig {
    pool: DatabasePoolConfig,
    migration: MigrationOptions,
    close_timeout: Duration,
}

impl DatabaseRuntimeConfig {
    pub fn load(
        environment: &impl Environment,
        files: &impl FileReader,
    ) -> Result<Self, DatabaseRuntimeConfigError> {
        let values = Values::new(environment.entries())?;
        validate_tls_mode(values.optional(TLS_MODE).unwrap_or("verify-full"))?;

        let database_url = load_secret(environment, files, DATABASE_URL, DATABASE_URL_FILE)?
            .ok_or(DatabaseRuntimeConfigError::MissingDatabaseUrl)?;
        let min_connections = values.parse_or(MIN_CONNECTIONS, 0_u32)?;
        let max_connections = values.parse_or(MAX_CONNECTIONS, 10_u32)?;
        let connect_timeout = values.duration_or(CONNECT_TIMEOUT_MS, 5_000)?;
        let acquire_timeout = values.duration_or(ACQUIRE_TIMEOUT_MS, 2_000)?;
        let close_timeout = values.duration_or(CLOSE_TIMEOUT_MS, 5_000)?;
        let migration = MigrationOptions::new(
            values.duration_or(MIGRATION_LOCK_TIMEOUT_MS, 30_000)?,
            values.duration_or(MIGRATION_TIMEOUT_MS, 300_000)?,
        )?;

        let instance_ca =
            read_optional(files, values.optional(INSTANCE_CA_FILE), INSTANCE_CA_FILE)?;
        let database_ca =
            read_optional(files, values.optional(DATABASE_CA_FILE), DATABASE_CA_FILE)?;
        let client_identity = match (
            values.optional(CLIENT_CERT_FILE),
            values.optional(CLIENT_KEY_FILE),
        ) {
            (Some(certificate), Some(key)) => Some(ClientIdentity::new(
                read_required(files, certificate, CLIENT_CERT_FILE)?,
                read_required(files, key, CLIENT_KEY_FILE)?,
            )?),
            (None, None) => None,
            _ => return Err(DatabaseRuntimeConfigError::IncompleteClientIdentity),
        };
        let tls = DatabaseTlsConfig::verify_full(instance_ca, database_ca, client_identity)?;
        let pool = DatabasePoolConfig::new(
            database_url.expose_secret().to_owned(),
            min_connections,
            max_connections,
            connect_timeout,
            acquire_timeout,
            tls,
        )?;

        Ok(Self {
            pool,
            migration,
            close_timeout,
        })
    }

    #[must_use]
    pub fn pool_config(&self) -> DatabasePoolConfig {
        self.pool.clone()
    }

    #[must_use]
    pub const fn migration_options(&self) -> MigrationOptions {
        self.migration
    }

    #[must_use]
    pub const fn close_timeout(&self) -> Duration {
        self.close_timeout
    }
}

impl fmt::Debug for DatabaseRuntimeConfig {
    fn fmt(&self, formatter: &mut fmt::Formatter<'_>) -> fmt::Result {
        formatter
            .debug_struct("DatabaseRuntimeConfig")
            .field("pool", &self.pool)
            .field("migration", &self.migration)
            .field("close_timeout", &self.close_timeout)
            .finish()
    }
}

#[derive(Debug)]
pub enum DatabaseRuntimeConfigError {
    Config(ConfigError),
    Source(ConfigSourceError),
    MissingDatabaseUrl,
    InvalidNumber { name: &'static str },
    InvalidTlsMode,
    IncompleteClientIdentity,
    Database(DatabaseConfigError),
    Migration(MigrationError),
    Tls(TlsConfigError),
}

impl fmt::Display for DatabaseRuntimeConfigError {
    fn fmt(&self, formatter: &mut fmt::Formatter<'_>) -> fmt::Result {
        match self {
            Self::Config(error) => error.fmt(formatter),
            Self::Source(error) => error.fmt(formatter),
            Self::MissingDatabaseUrl => formatter.write_str("database URL is required"),
            Self::InvalidNumber { name } => write!(formatter, "configuration {name} is invalid"),
            Self::InvalidTlsMode => formatter.write_str("database TLS mode must be verify-full"),
            Self::IncompleteClientIdentity => formatter.write_str(
                "database client certificate and private key must be configured together",
            ),
            Self::Database(error) => error.fmt(formatter),
            Self::Migration(error) => error.fmt(formatter),
            Self::Tls(error) => error.fmt(formatter),
        }
    }
}

impl std::error::Error for DatabaseRuntimeConfigError {}

impl From<ConfigError> for DatabaseRuntimeConfigError {
    fn from(value: ConfigError) -> Self {
        Self::Config(value)
    }
}

impl From<ConfigSourceError> for DatabaseRuntimeConfigError {
    fn from(value: ConfigSourceError) -> Self {
        Self::Source(value)
    }
}

impl From<DatabaseConfigError> for DatabaseRuntimeConfigError {
    fn from(value: DatabaseConfigError) -> Self {
        Self::Database(value)
    }
}

impl From<MigrationError> for DatabaseRuntimeConfigError {
    fn from(value: MigrationError) -> Self {
        Self::Migration(value)
    }
}

impl From<TlsConfigError> for DatabaseRuntimeConfigError {
    fn from(value: TlsConfigError) -> Self {
        Self::Tls(value)
    }
}

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum ConfigSourceError {
    Duplicate {
        name: &'static str,
    },
    NonUnicode,
    EmptyPath {
        name: &'static str,
    },
    ReadFile {
        name: &'static str,
        kind: io::ErrorKind,
    },
    FileTooLarge {
        name: &'static str,
    },
}

impl fmt::Display for ConfigSourceError {
    fn fmt(&self, formatter: &mut fmt::Formatter<'_>) -> fmt::Result {
        match self {
            Self::Duplicate { name } => write!(formatter, "configuration {name} is duplicated"),
            Self::NonUnicode => formatter.write_str("database configuration is not valid Unicode"),
            Self::EmptyPath { name } => write!(formatter, "configuration {name} must not be empty"),
            Self::ReadFile { name, kind } => {
                write!(
                    formatter,
                    "could not read file referenced by {name}: {kind}"
                )
            }
            Self::FileTooLarge { name } => write!(
                formatter,
                "file referenced by {name} exceeds {MAX_TLS_FILE_BYTES} bytes"
            ),
        }
    }
}

impl std::error::Error for ConfigSourceError {}

struct Values(BTreeMap<String, String>);

impl Values {
    fn new(entries: Vec<(OsString, OsString)>) -> Result<Self, ConfigSourceError> {
        let mut values = BTreeMap::new();
        for (raw_name, raw_value) in entries {
            let Some(name) = raw_name.to_str() else {
                continue;
            };
            if !name.starts_with("NURITEO_DATABASE_") && name != INSTANCE_CA_FILE {
                continue;
            }
            let value = raw_value
                .into_string()
                .map_err(|_| ConfigSourceError::NonUnicode)?;
            if values.insert(name.to_owned(), value).is_some() {
                return Err(ConfigSourceError::Duplicate {
                    name: known_name(name),
                });
            }
        }
        Ok(Self(values))
    }

    fn optional(&self, name: &str) -> Option<&str> {
        self.0.get(name).map(String::as_str)
    }

    fn parse_or<T>(&self, name: &'static str, default: T) -> Result<T, DatabaseRuntimeConfigError>
    where
        T: std::str::FromStr,
    {
        self.optional(name).map_or(Ok(default), |value| {
            value
                .parse()
                .map_err(|_| DatabaseRuntimeConfigError::InvalidNumber { name })
        })
    }

    fn duration_or(
        &self,
        name: &'static str,
        default_millis: u64,
    ) -> Result<Duration, DatabaseRuntimeConfigError> {
        self.parse_or(name, default_millis)
            .map(Duration::from_millis)
    }
}

fn validate_tls_mode(value: &str) -> Result<(), DatabaseRuntimeConfigError> {
    if value == "verify-full" {
        Ok(())
    } else {
        Err(DatabaseRuntimeConfigError::InvalidTlsMode)
    }
}

fn read_optional(
    files: &impl FileReader,
    path: Option<&str>,
    name: &'static str,
) -> Result<Option<Vec<u8>>, ConfigSourceError> {
    path.map(|path| read_required(files, path, name))
        .transpose()
}

fn read_required(
    files: &impl FileReader,
    path: &str,
    name: &'static str,
) -> Result<Vec<u8>, ConfigSourceError> {
    if path.trim().is_empty() {
        return Err(ConfigSourceError::EmptyPath { name });
    }
    let bytes = files
        .read(Path::new(path), MAX_TLS_FILE_BYTES)
        .map_err(|source| ConfigSourceError::ReadFile {
            name,
            kind: source.kind(),
        })?;
    if bytes.len() > MAX_TLS_FILE_BYTES {
        return Err(ConfigSourceError::FileTooLarge { name });
    }
    Ok(bytes)
}

fn known_name(name: &str) -> &'static str {
    [
        DATABASE_URL,
        DATABASE_URL_FILE,
        MIN_CONNECTIONS,
        MAX_CONNECTIONS,
        CONNECT_TIMEOUT_MS,
        ACQUIRE_TIMEOUT_MS,
        CLOSE_TIMEOUT_MS,
        MIGRATION_LOCK_TIMEOUT_MS,
        MIGRATION_TIMEOUT_MS,
        TLS_MODE,
        INSTANCE_CA_FILE,
        DATABASE_CA_FILE,
        CLIENT_CERT_FILE,
        CLIENT_KEY_FILE,
    ]
    .into_iter()
    .find(|candidate| *candidate == name)
    .unwrap_or("NURITEO_DATABASE_CONFIGURATION")
}

#[cfg(test)]
mod tests;
