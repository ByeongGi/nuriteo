use serde::Serialize;
use sqlx::{Acquire, Postgres, Row, Transaction};
use utoipa::ToSchema;

use crate::identity::{BrowserRequestHeaders, UserId};

use super::{
    NotificationHttpService, NotificationHttpServiceError, configure_transaction, smtp_configured,
};

#[derive(Debug, Clone, Serialize, ToSchema)]
#[serde(rename_all = "camelCase")]
pub struct NotificationPreferencesView {
    pub critical_security: bool,
    pub account_access: bool,
    pub collaboration: bool,
    pub operations: bool,
    pub smtp_configured: bool,
    pub version: u64,
}

impl NotificationHttpService {
    pub(crate) async fn preferences(
        &self,
        request: BrowserRequestHeaders<'_>,
    ) -> Result<NotificationPreferencesView, NotificationHttpServiceError> {
        let runtime = self.runtime()?;
        let identity = runtime.authenticate(request).await?;
        let mut connection = runtime
            .pool
            .acquire()
            .await
            .map_err(|_| NotificationHttpServiceError::Unavailable)?;
        let mut tx = connection
            .begin()
            .await
            .map_err(|_| NotificationHttpServiceError::Unavailable)?;
        sqlx::query("SET TRANSACTION ISOLATION LEVEL REPEATABLE READ READ ONLY")
            .execute(&mut *tx)
            .await
            .map_err(|_| NotificationHttpServiceError::Unavailable)?;
        configure_transaction(&mut tx).await?;
        let view = load_preferences(&mut tx, identity.user_id).await?;
        tx.commit()
            .await
            .map_err(|_| NotificationHttpServiceError::Unavailable)?;
        Ok(view)
    }

    pub(crate) async fn update_preferences(
        &self,
        request: BrowserRequestHeaders<'_>,
        account_access: bool,
        collaboration: bool,
        operations: bool,
        expected_version: u64,
    ) -> Result<NotificationPreferencesView, NotificationHttpServiceError> {
        let runtime = self.runtime()?;
        let identity = runtime.authenticate(request).await?;
        let expected = i64::try_from(expected_version)
            .map_err(|_| NotificationHttpServiceError::PreconditionFailed)?;
        let mut connection = runtime
            .pool
            .acquire()
            .await
            .map_err(|_| NotificationHttpServiceError::Unavailable)?;
        let mut tx = connection
            .begin()
            .await
            .map_err(|_| NotificationHttpServiceError::Unavailable)?;
        configure_transaction(&mut tx).await?;
        let changed = if expected == 1 {
            sqlx::query(
                "INSERT INTO notification_email_preferences(user_id,account_access,collaboration,operations,lock_version) \
                 VALUES($1::uuid,$2,$3,$4,2) ON CONFLICT(user_id) DO UPDATE SET \
                 account_access=EXCLUDED.account_access,collaboration=EXCLUDED.collaboration,\
                 operations=EXCLUDED.operations,updated_at=transaction_timestamp(),\
                 lock_version=notification_email_preferences.lock_version+1 \
                 WHERE notification_email_preferences.lock_version=1 RETURNING lock_version",
            )
            .bind(identity.user_id.to_string())
            .bind(account_access)
            .bind(collaboration)
            .bind(operations)
            .fetch_optional(&mut *tx)
            .await
        } else {
            sqlx::query(
                "UPDATE notification_email_preferences SET account_access=$2,collaboration=$3,operations=$4,\
                 updated_at=transaction_timestamp(),lock_version=lock_version+1 \
                 WHERE user_id=$1::uuid AND lock_version=$5 RETURNING lock_version",
            )
            .bind(identity.user_id.to_string())
            .bind(account_access)
            .bind(collaboration)
            .bind(operations)
            .bind(expected)
            .fetch_optional(&mut *tx)
            .await
        }
        .map_err(|_| NotificationHttpServiceError::Unavailable)?;
        if changed.is_none() {
            return Err(NotificationHttpServiceError::PreconditionFailed);
        }
        let view = load_preferences(&mut tx, identity.user_id).await?;
        tx.commit()
            .await
            .map_err(|_| NotificationHttpServiceError::CommitOutcomeUnknown)?;
        Ok(view)
    }
}

async fn load_preferences(
    tx: &mut Transaction<'_, Postgres>,
    user_id: UserId,
) -> Result<NotificationPreferencesView, NotificationHttpServiceError> {
    let row = sqlx::query("SELECT account_access,collaboration,operations,lock_version FROM notification_email_preferences WHERE user_id=$1::uuid")
        .bind(user_id.to_string()).fetch_optional(&mut **tx).await.map_err(|_| NotificationHttpServiceError::Unavailable)?;
    let (account_access, collaboration, operations, version) =
        row.map_or((true, false, false, 1), |row| {
            (
                row.get("account_access"),
                row.get("collaboration"),
                row.get("operations"),
                row.get::<i64, _>("lock_version"),
            )
        });
    Ok(NotificationPreferencesView {
        critical_security: true,
        account_access,
        collaboration,
        operations,
        smtp_configured: smtp_configured(tx).await?,
        version: u64::try_from(version).map_err(|_| NotificationHttpServiceError::Internal)?,
    })
}
