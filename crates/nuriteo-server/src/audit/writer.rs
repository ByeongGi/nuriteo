use std::fmt;

use sqlx::{Postgres, Transaction};

use super::AuditEvent;

#[derive(Debug, Default, Clone, Copy)]
pub struct AuditWriter;

impl AuditWriter {
    pub async fn append(
        transaction: &mut Transaction<'_, Postgres>,
        event: &AuditEvent,
    ) -> Result<(), AuditWriteError> {
        let fields = event.fields();
        let source_ip = fields.source_ip.map(|value| value.to_string());
        let actor_user_id = fields.actor.user_id.map(|value| value.to_string());
        let metadata = fields.metadata.value().to_string();

        sqlx::query(
            "INSERT INTO audit_events (\
             id, occurred_at, actor_type, actor_id, actor_user_id, actor_display_name, \
             action_code, target_type, target_id, scope_type, scope_id, result, reason_code, \
             correlation_id, source_ip, schema_version, changed_fields, metadata) \
             VALUES ($1::uuid, $2::timestamptz, $3, $4, $5::uuid, $6, $7, $8, $9, \
                     $10, $11, $12, $13, $14, $15::inet, $16, $17, $18::jsonb)",
        )
        .bind(fields.id.to_string())
        .bind(fields.occurred_at.to_string())
        .bind(fields.actor.kind.as_str())
        .bind(&fields.actor.id)
        .bind(actor_user_id)
        .bind(&fields.actor.display_name)
        .bind(&fields.action_code)
        .bind(&fields.target.kind)
        .bind(&fields.target.id)
        .bind(fields.scope.kind.as_str())
        .bind(&fields.scope.id)
        .bind(fields.result.as_str())
        .bind(&fields.reason_code)
        .bind(&fields.correlation_id)
        .bind(source_ip)
        .bind(fields.schema_version)
        .bind(&fields.changed_fields)
        .bind(metadata)
        .execute(&mut **transaction)
        .await
        .map_err(AuditWriteError::from_database)?;
        Ok(())
    }
}

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum AuditWriteErrorCategory {
    Constraint,
    Unavailable,
    Internal,
}

impl AuditWriteErrorCategory {
    const fn as_str(self) -> &'static str {
        match self {
            Self::Constraint => "constraint",
            Self::Unavailable => "unavailable",
            Self::Internal => "internal",
        }
    }
}

#[derive(Clone, Copy, PartialEq, Eq)]
pub struct AuditWriteError {
    category: AuditWriteErrorCategory,
}

impl AuditWriteError {
    #[must_use]
    pub const fn category(self) -> AuditWriteErrorCategory {
        self.category
    }

    fn from_database(error: sqlx::Error) -> Self {
        let category = match &error {
            sqlx::Error::Database(database)
                if database.is_unique_violation()
                    || database.is_foreign_key_violation()
                    || database.is_check_violation() =>
            {
                AuditWriteErrorCategory::Constraint
            }
            sqlx::Error::Io(_)
            | sqlx::Error::Tls(_)
            | sqlx::Error::PoolTimedOut
            | sqlx::Error::PoolClosed
            | sqlx::Error::WorkerCrashed => AuditWriteErrorCategory::Unavailable,
            _ => AuditWriteErrorCategory::Internal,
        };
        Self { category }
    }
}

impl fmt::Debug for AuditWriteError {
    fn fmt(&self, formatter: &mut fmt::Formatter<'_>) -> fmt::Result {
        formatter
            .debug_struct("AuditWriteError")
            .field("category", &self.category)
            .finish()
    }
}

impl fmt::Display for AuditWriteError {
    fn fmt(&self, formatter: &mut fmt::Formatter<'_>) -> fmt::Result {
        write!(formatter, "audit append failed: {}", self.category.as_str())
    }
}

impl std::error::Error for AuditWriteError {}
