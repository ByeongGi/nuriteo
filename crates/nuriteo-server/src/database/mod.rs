//! PostgreSQL operational boundary.
//!
//! This module owns bounded pool/TLS configuration, explicit migrations and
//! schema readiness. Domain entities and repositories deliberately live outside
//! this boundary, and application startup never runs migrations implicitly.

mod config;
mod migrations;
mod readiness;
mod tls;

use std::fmt;
use std::time::Duration;

use percent_encoding::percent_decode_str;
use sea_orm::{DatabaseConnection, SqlxPostgresConnector};
use sqlx::pool::PoolConnection;
use sqlx::postgres::{PgConnectOptions, PgPoolOptions, PgSslMode};
use sqlx::{PgPool, Postgres};
use tokio::time;
use url::Url;

pub use config::{DatabaseRuntimeConfig, DatabaseRuntimeConfigError};
pub use migrations::{MigrationError, MigrationOptions, MigrationReport, run_embedded_migrations};
pub use readiness::{SchemaReadiness, SchemaReadinessError, check_schema_readiness};
pub use tls::{ClientIdentity, DatabaseTlsConfig, TlsConfigError};

pub const MIN_CONNECTION_LIMIT: u32 = 0;
pub const MAX_CONNECTION_LIMIT: u32 = 64;
pub const MIN_TIMEOUT: Duration = Duration::from_millis(100);
pub const MAX_TIMEOUT: Duration = Duration::from_secs(60);
const DRIVER_TIMEOUT: Duration = MAX_TIMEOUT;

/// Validated PostgreSQL pool inputs.
#[derive(Clone)]
pub struct DatabasePoolConfig {
    database_url: String,
    min_connections: u32,
    max_connections: u32,
    connect_timeout: Duration,
    acquire_timeout: Duration,
    tls: DatabaseTlsConfig,
}

impl DatabasePoolConfig {
    pub fn new(
        database_url: String,
        min_connections: u32,
        max_connections: u32,
        connect_timeout: Duration,
        acquire_timeout: Duration,
        tls: DatabaseTlsConfig,
    ) -> Result<Self, DatabaseConfigError> {
        validate_url(&database_url)?;
        if max_connections == 0
            || max_connections > MAX_CONNECTION_LIMIT
            || min_connections > max_connections
        {
            return Err(DatabaseConfigError::InvalidConnectionBounds);
        }
        validate_timeout(connect_timeout, DatabaseConfigError::InvalidConnectTimeout)?;
        validate_timeout(acquire_timeout, DatabaseConfigError::InvalidAcquireTimeout)?;

        Ok(Self {
            database_url,
            min_connections,
            max_connections,
            connect_timeout,
            acquire_timeout,
            tls,
        })
    }
}

impl fmt::Debug for DatabasePoolConfig {
    fn fmt(&self, formatter: &mut fmt::Formatter<'_>) -> fmt::Result {
        formatter
            .debug_struct("DatabasePoolConfig")
            .field("database_url", &"[REDACTED]")
            .field("min_connections", &self.min_connections)
            .field("max_connections", &self.max_connections)
            .field("connect_timeout", &self.connect_timeout)
            .field("acquire_timeout", &self.acquire_timeout)
            .field("tls", &self.tls)
            .finish()
    }
}

/// A cloneable handle to the application PostgreSQL pool.
#[derive(Clone)]
pub struct DatabasePool {
    pool: PgPool,
    acquire_timeout: Duration,
}

impl DatabasePool {
    /// Creates the bounded pool and establishes its configured minimum number of
    /// connections before returning.
    pub async fn connect(config: DatabasePoolConfig) -> Result<Self, DatabaseError> {
        let options = connect_options(&config)?;
        let pool_future = PgPoolOptions::new()
            .min_connections(config.min_connections)
            .max_connections(config.max_connections)
            // Public operations apply the shorter, caller-visible deadline. This
            // driver guard prevents an abandoned internal acquire from lingering.
            .acquire_timeout(DRIVER_TIMEOUT)
            .connect_with(options);

        let pool = time::timeout(config.connect_timeout, pool_future)
            .await
            .map_err(|_| DatabaseError::ConnectTimeout)?
            .map_err(|error| DatabaseError::ConnectFailed(classify_error(&error)))?;

        Ok(Self {
            pool,
            acquire_timeout: config.acquire_timeout,
        })
    }

    /// Returns a SeaORM connection backed by the same SQLx pool.
    #[must_use]
    pub fn sea_orm_connection(&self) -> DatabaseConnection {
        SqlxPostgresConnector::from_sqlx_postgres_pool(self.pool.clone())
    }

    /// Acquires one connection within the configured deadline.
    pub async fn acquire(&self) -> Result<PoolConnection<Postgres>, DatabaseError> {
        time::timeout(self.acquire_timeout, self.pool.acquire())
            .await
            .map_err(|_| DatabaseError::AcquireTimeout)?
            .map_err(|error| DatabaseError::AcquireFailed(classify_error(&error)))
    }

    /// Checks that the pool can execute a PostgreSQL round trip.
    pub async fn ping(&self) -> Result<(), DatabaseError> {
        let mut connection = self.acquire().await?;
        sqlx::query("SELECT 1")
            .execute(&mut *connection)
            .await
            .map_err(|error| DatabaseError::QueryFailed(classify_error(&error)))?;
        Ok(())
    }

    /// Gracefully closes the pool within a caller-selected deadline.
    pub async fn close(self, timeout: Duration) -> Result<(), DatabaseError> {
        validate_timeout(timeout, DatabaseConfigError::InvalidCloseTimeout)?;
        time::timeout(timeout, self.pool.close())
            .await
            .map_err(|_| DatabaseError::CloseTimeout)
    }
}

impl fmt::Debug for DatabasePool {
    fn fmt(&self, formatter: &mut fmt::Formatter<'_>) -> fmt::Result {
        formatter
            .debug_struct("DatabasePool")
            .field("size", &self.pool.size())
            .field("idle", &self.pool.num_idle())
            .field("acquire_timeout", &self.acquire_timeout)
            .finish_non_exhaustive()
    }
}

fn connect_options(config: &DatabasePoolConfig) -> Result<PgConnectOptions, DatabaseError> {
    connect_options_with_environment(config, |name| std::env::var_os(name))
}

fn connect_options_with_environment(
    config: &DatabasePoolConfig,
    environment: impl Fn(&str) -> Option<std::ffi::OsString>,
) -> Result<PgConnectOptions, DatabaseError> {
    reject_ambient_driver_configuration(environment)?;
    let parsed =
        Url::parse(&config.database_url).map_err(|_| DatabaseConfigError::InvalidDatabaseUrl)?;
    let host = parsed
        .host_str()
        .ok_or(DatabaseConfigError::InvalidDatabaseUrl)?;
    let username = decode_url_component(parsed.username())?;
    let database = decode_url_component(parsed.path().trim_start_matches('/'))?;
    let mut options = PgConnectOptions::new_without_pgpass()
        .host(host)
        .port(parsed.port().unwrap_or(5432))
        .username(&username)
        .database(&database)
        .ssl_mode(PgSslMode::VerifyFull)
        .ssl_root_cert_from_pem(config.tls.combined_ca_bundle().unwrap_or_default())
        .application_name("nuriteo-server");
    if let Some(password) = parsed.password() {
        options = options.password(&decode_url_component(password)?);
    }

    if let Some(identity) = config.tls.client_identity() {
        options = options
            .ssl_client_cert_from_pem(identity.certificate_pem())
            .ssl_client_key_from_pem(identity.private_key_pem());
    }
    Ok(options)
}

fn reject_ambient_driver_configuration(
    environment: impl Fn(&str) -> Option<std::ffi::OsString>,
) -> Result<(), DatabaseConfigError> {
    // SQLx initializes these libpq-compatible options from process variables.
    // They are outside NURITEO's declared precedence and must not silently
    // replace explicit trust or session policy.
    if [
        "PGPASSWORD",
        "PGPASSFILE",
        "PGSSLMODE",
        "PGSSLROOTCERT",
        "PGSSLCERT",
        "PGSSLKEY",
        "PGHOST",
        "PGHOSTADDR",
        "PGPORT",
        "PGUSER",
        "PGDATABASE",
        "PGAPPNAME",
        "PGOPTIONS",
        "PGSERVICE",
        "PGSERVICEFILE",
    ]
    .into_iter()
    .any(|name| environment(name).is_some())
    {
        return Err(DatabaseConfigError::ConflictingDriverEnvironment);
    }
    Ok(())
}

fn validate_url(value: &str) -> Result<(), DatabaseConfigError> {
    let parsed = Url::parse(value).map_err(|_| DatabaseConfigError::InvalidDatabaseUrl)?;
    if !matches!(parsed.scheme(), "postgres" | "postgresql")
        || parsed.host_str().is_none()
        || parsed.username().is_empty()
        || parsed.path().trim_matches('/').is_empty()
        || parsed.query().is_some()
        || parsed.fragment().is_some()
    {
        return Err(DatabaseConfigError::InvalidDatabaseUrl);
    }
    Ok(())
}

fn decode_url_component(value: &str) -> Result<String, DatabaseConfigError> {
    percent_decode_str(value)
        .decode_utf8()
        .map(String::from)
        .map_err(|_| DatabaseConfigError::InvalidDatabaseUrl)
}

fn validate_timeout(
    value: Duration,
    error: DatabaseConfigError,
) -> Result<(), DatabaseConfigError> {
    if !(MIN_TIMEOUT..=MAX_TIMEOUT).contains(&value) {
        return Err(error);
    }
    Ok(())
}

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum DatabaseConfigError {
    InvalidDatabaseUrl,
    InvalidConnectionBounds,
    InvalidConnectTimeout,
    InvalidAcquireTimeout,
    InvalidCloseTimeout,
    ConflictingDriverEnvironment,
    InvalidTls(TlsConfigError),
}

impl fmt::Display for DatabaseConfigError {
    fn fmt(&self, formatter: &mut fmt::Formatter<'_>) -> fmt::Result {
        match self {
            Self::InvalidDatabaseUrl => formatter.write_str("database URL is invalid"),
            Self::InvalidConnectionBounds => {
                formatter.write_str("database connection bounds are invalid")
            }
            Self::InvalidConnectTimeout => {
                formatter.write_str("database connect timeout is invalid")
            }
            Self::InvalidAcquireTimeout => {
                formatter.write_str("database acquire timeout is invalid")
            }
            Self::InvalidCloseTimeout => formatter.write_str("database close timeout is invalid"),
            Self::ConflictingDriverEnvironment => formatter
                .write_str("undeclared PostgreSQL driver environment configuration is present"),
            Self::InvalidTls(error) => {
                write!(formatter, "database TLS configuration is invalid: {error}")
            }
        }
    }
}

impl std::error::Error for DatabaseConfigError {}

impl From<TlsConfigError> for DatabaseConfigError {
    fn from(value: TlsConfigError) -> Self {
        Self::InvalidTls(value)
    }
}

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum DatabaseErrorCategory {
    Authentication,
    Trust,
    Transport,
    Configuration,
    PoolClosed,
    Internal,
}

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum DatabaseError {
    InvalidConfiguration(DatabaseConfigError),
    ConnectTimeout,
    ConnectFailed(DatabaseErrorCategory),
    AcquireTimeout,
    AcquireFailed(DatabaseErrorCategory),
    QueryFailed(DatabaseErrorCategory),
    CloseTimeout,
}

impl fmt::Display for DatabaseError {
    fn fmt(&self, formatter: &mut fmt::Formatter<'_>) -> fmt::Result {
        match self {
            Self::InvalidConfiguration(error) => error.fmt(formatter),
            Self::ConnectTimeout => formatter.write_str("database connection timed out"),
            Self::ConnectFailed(category) => {
                write!(formatter, "database connection failed ({category})")
            }
            Self::AcquireTimeout => formatter.write_str("database pool acquisition timed out"),
            Self::AcquireFailed(category) => {
                write!(formatter, "database pool acquisition failed ({category})")
            }
            Self::QueryFailed(category) => write!(formatter, "database query failed ({category})"),
            Self::CloseTimeout => formatter.write_str("database pool close timed out"),
        }
    }
}

impl std::error::Error for DatabaseError {}

impl From<DatabaseConfigError> for DatabaseError {
    fn from(value: DatabaseConfigError) -> Self {
        Self::InvalidConfiguration(value)
    }
}

impl fmt::Display for DatabaseErrorCategory {
    fn fmt(&self, formatter: &mut fmt::Formatter<'_>) -> fmt::Result {
        let value = match self {
            Self::Authentication => "authentication",
            Self::Trust => "trust",
            Self::Transport => "transport",
            Self::Configuration => "configuration",
            Self::PoolClosed => "pool-closed",
            Self::Internal => "internal",
        };
        formatter.write_str(value)
    }
}

fn classify_error(error: &sqlx::Error) -> DatabaseErrorCategory {
    match error {
        sqlx::Error::Database(database) if database.code().as_deref() == Some("28P01") => {
            DatabaseErrorCategory::Authentication
        }
        sqlx::Error::Tls(_) => DatabaseErrorCategory::Trust,
        sqlx::Error::Io(error) if error.kind() == std::io::ErrorKind::InvalidData => {
            DatabaseErrorCategory::Trust
        }
        sqlx::Error::Io(_) => DatabaseErrorCategory::Transport,
        sqlx::Error::Configuration(_) | sqlx::Error::InvalidArgument(_) => {
            DatabaseErrorCategory::Configuration
        }
        sqlx::Error::PoolClosed => DatabaseErrorCategory::PoolClosed,
        _ => DatabaseErrorCategory::Internal,
    }
}

#[cfg(test)]
mod tests;
