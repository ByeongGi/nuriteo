use std::fmt;

use sqlx::{Postgres, Transaction};

use super::NotificationDelivery;

#[derive(Debug, Default, Clone, Copy)]
pub struct NotificationWriter;

impl NotificationWriter {
    /// Persists the inbox item and its optional email job in the caller's
    /// transaction. The caller owns commit/rollback; no SMTP I/O occurs here.
    pub async fn enqueue(
        transaction: &mut Transaction<'_, Postgres>,
        delivery: &NotificationDelivery,
    ) -> Result<(), NotificationWriteError> {
        let fields = delivery.notification().fields();
        let rendering_data = fields.rendering_data.value().to_string();
        sqlx::query(
            "INSERT INTO notifications (\
             id, recipient_user_id, classification, event_code, template_id, locale, \
             resource_type, resource_id, rendering_data, action_state, \
             first_occurred_at, last_occurred_at) \
             VALUES ($1::uuid, $2::uuid, $3, $4, $5, $6, $7, $8, $9::jsonb, $10, \
                     $11::timestamptz, $11::timestamptz)",
        )
        .bind(fields.id.to_string())
        .bind(fields.recipient_user_id.to_string())
        .bind(fields.classification.as_str())
        .bind(&fields.event_code)
        .bind(&fields.template_id)
        .bind(&fields.locale)
        .bind(&fields.resource_type)
        .bind(&fields.resource_id)
        .bind(&rendering_data)
        .bind(if fields.requires_action {
            "pending"
        } else {
            "none"
        })
        .bind(fields.occurred_at.to_string())
        .execute(&mut **transaction)
        .await
        .map_err(NotificationWriteError::from_database)?;

        if let Some((outbox_id, recipient_email)) = delivery.email() {
            sqlx::query(
                "INSERT INTO email_outbox (\
                 id, notification_id, recipient_user_id, recipient_email, classification, \
                 template_id, locale, resource_type, resource_id, rendering_data) \
                 VALUES ($1::uuid, $2::uuid, $3::uuid, $4, $5, $6, $7, $8, $9, \
                         $10::jsonb)",
            )
            .bind(outbox_id.to_string())
            .bind(fields.id.to_string())
            .bind(fields.recipient_user_id.to_string())
            .bind(recipient_email.as_str())
            .bind(fields.classification.as_str())
            .bind(&fields.template_id)
            .bind(&fields.locale)
            .bind(&fields.resource_type)
            .bind(&fields.resource_id)
            .bind(rendering_data)
            .execute(&mut **transaction)
            .await
            .map_err(NotificationWriteError::from_database)?;
        }
        Ok(())
    }
}

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum NotificationWriteErrorCategory {
    Constraint,
    Unavailable,
    Internal,
}

#[derive(Clone, Copy, PartialEq, Eq)]
pub struct NotificationWriteError {
    category: NotificationWriteErrorCategory,
}

impl NotificationWriteError {
    #[must_use]
    pub const fn category(self) -> NotificationWriteErrorCategory {
        self.category
    }

    fn from_database(error: sqlx::Error) -> Self {
        let category = match &error {
            sqlx::Error::Database(database)
                if database.is_unique_violation()
                    || database.is_foreign_key_violation()
                    || database.is_check_violation() =>
            {
                NotificationWriteErrorCategory::Constraint
            }
            sqlx::Error::Io(_)
            | sqlx::Error::Tls(_)
            | sqlx::Error::PoolTimedOut
            | sqlx::Error::PoolClosed
            | sqlx::Error::WorkerCrashed => NotificationWriteErrorCategory::Unavailable,
            _ => NotificationWriteErrorCategory::Internal,
        };
        Self { category }
    }
}

impl fmt::Debug for NotificationWriteError {
    fn fmt(&self, formatter: &mut fmt::Formatter<'_>) -> fmt::Result {
        formatter
            .debug_struct("NotificationWriteError")
            .field("category", &self.category)
            .finish()
    }
}

impl fmt::Display for NotificationWriteError {
    fn fmt(&self, formatter: &mut fmt::Formatter<'_>) -> fmt::Result {
        formatter.write_str("notification enqueue failed")
    }
}

impl std::error::Error for NotificationWriteError {}
