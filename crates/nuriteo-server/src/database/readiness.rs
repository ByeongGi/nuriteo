use std::fmt;

use sqlx::Row;

use super::migrations::embedded_migrator;
use super::{DatabaseError, DatabaseErrorCategory, DatabasePool, classify_error};

/// Compatibility state between the running binary and PostgreSQL history.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum SchemaReadiness {
    Ready { version: i64 },
    Pending { current: Option<i64>, target: i64 },
    Dirty { version: i64 },
    ChecksumMismatch { version: i64 },
    Unsupported { version: i64 },
}

impl SchemaReadiness {
    #[must_use]
    pub const fn allows_migration(self) -> bool {
        matches!(self, Self::Ready { .. } | Self::Pending { .. })
    }

    #[must_use]
    pub fn summary(self) -> String {
        match self {
            Self::Ready { version } => format!("schema=ready version={version}"),
            Self::Pending { current, target } => match current {
                Some(current) => {
                    format!("schema=pending current={current} target={target}")
                }
                None => format!("schema=pending current=none target={target}"),
            },
            Self::Dirty { version } => format!("schema=dirty version={version}"),
            Self::ChecksumMismatch { version } => {
                format!("schema=checksum-mismatch version={version}")
            }
            Self::Unsupported { version } => format!("schema=unsupported version={version}"),
        }
    }
}

/// Reads SQLx migration history without exposing driver causes or SQL text.
pub async fn check_schema_readiness(
    pool: &DatabasePool,
) -> Result<SchemaReadiness, SchemaReadinessError> {
    let migrator = embedded_migrator();
    let expected: Vec<_> = migrator.iter().collect();
    let target = expected.last().map_or(0, |migration| migration.version);
    let mut connection = pool
        .acquire()
        .await
        .map_err(SchemaReadinessError::Database)?;

    let history_exists = sqlx::query("SELECT to_regclass('_sqlx_migrations') IS NOT NULL")
        .fetch_one(&mut *connection)
        .await
        .map_err(query_error)?
        .try_get::<bool, _>(0)
        .map_err(query_error)?;
    if !history_exists {
        return Ok(SchemaReadiness::Pending {
            current: None,
            target,
        });
    }

    let rows =
        sqlx::query("SELECT version, success, checksum FROM _sqlx_migrations ORDER BY version")
            .fetch_all(&mut *connection)
            .await
            .map_err(query_error)?;

    for (index, row) in rows.iter().enumerate() {
        let version = row.try_get::<i64, _>(0).map_err(query_error)?;
        let success = row.try_get::<bool, _>(1).map_err(query_error)?;
        let checksum = row.try_get::<Vec<u8>, _>(2).map_err(query_error)?;
        if !success {
            return Ok(SchemaReadiness::Dirty { version });
        }
        let Some(migration) = expected.get(index) else {
            return Ok(SchemaReadiness::Unsupported { version });
        };
        if migration.version != version {
            return Ok(SchemaReadiness::Unsupported { version });
        }
        if migration.checksum.as_ref() != checksum {
            return Ok(SchemaReadiness::ChecksumMismatch { version });
        }
    }

    let current = rows.last().and_then(|row| row.try_get::<i64, _>(0).ok());
    if rows.len() < expected.len() {
        Ok(SchemaReadiness::Pending { current, target })
    } else {
        Ok(SchemaReadiness::Ready { version: target })
    }
}

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum SchemaReadinessError {
    Database(DatabaseError),
    Query(DatabaseErrorCategory),
}

impl fmt::Display for SchemaReadinessError {
    fn fmt(&self, formatter: &mut fmt::Formatter<'_>) -> fmt::Result {
        match self {
            Self::Database(error) => write!(
                formatter,
                "schema readiness database access failed: {error}"
            ),
            Self::Query(category) => {
                write!(formatter, "schema readiness query failed ({category})")
            }
        }
    }
}

impl std::error::Error for SchemaReadinessError {}

fn query_error(error: sqlx::Error) -> SchemaReadinessError {
    SchemaReadinessError::Query(classify_error(&error))
}

#[cfg(test)]
mod tests;
