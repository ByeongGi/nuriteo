use std::fmt;
use std::sync::Arc;

use sqlx::{Postgres, Transaction};
use time::OffsetDateTime;
use time::format_description::well_known::Rfc3339;
use url::Url;

use crate::database::DatabasePool;
use crate::identity::{
    BrowserCookieBoundary, BrowserCookieError, BrowserRequestHeaders, SessionId, SessionPolicy,
    SessionService, SessionServiceError, UserId,
};

const DEFAULT_PAGE_SIZE: u16 = 25;
const MAX_PAGE_SIZE: u16 = 100;

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum NotificationHttpServiceError {
    AuthenticationFailed,
    Forbidden,
    ReauthenticationRequired,
    InvalidInput,
    NotFound,
    Conflict,
    PreconditionFailed,
    CommitOutcomeUnknown,
    Unavailable,
    Internal,
}

impl fmt::Display for NotificationHttpServiceError {
    fn fmt(&self, formatter: &mut fmt::Formatter<'_>) -> fmt::Result {
        formatter.write_str(match self {
            Self::AuthenticationFailed => "notification authentication failed",
            Self::Forbidden => "notification request was forbidden",
            Self::ReauthenticationRequired => "recent reauthentication is required",
            Self::InvalidInput => "notification request is invalid",
            Self::NotFound => "notification resource was not found",
            Self::Conflict => "notification operation conflicts with current state",
            Self::PreconditionFailed => "notification version is stale",
            Self::CommitOutcomeUnknown => "notification commit outcome is unknown",
            Self::Unavailable => "notification service is unavailable",
            Self::Internal => "notification operation failed",
        })
    }
}

impl std::error::Error for NotificationHttpServiceError {}

mod deliveries;
mod inbox;
mod preferences;

pub use deliveries::{EmailDeliveryCollectionView, EmailDeliveryView};
pub use inbox::{NotificationInboxItemView, NotificationInboxView};
pub use preferences::NotificationPreferencesView;

#[derive(Clone)]
pub struct NotificationHttpService {
    runtime: Option<Arc<NotificationRuntime>>,
}

struct NotificationRuntime {
    pool: DatabasePool,
    sessions: SessionService,
    cookies: BrowserCookieBoundary,
}

#[derive(Clone, Copy)]
struct AuthenticatedIdentity {
    user_id: UserId,
    session_id: SessionId,
}

impl fmt::Debug for NotificationHttpService {
    fn fmt(&self, formatter: &mut fmt::Formatter<'_>) -> fmt::Result {
        formatter
            .debug_struct("NotificationHttpService")
            .field("configured", &self.runtime.is_some())
            .finish()
    }
}

impl NotificationHttpService {
    #[must_use]
    pub const fn unconfigured() -> Self {
        Self { runtime: None }
    }

    pub fn production(
        pool: DatabasePool,
        external_url: &Url,
        session_policy: SessionPolicy,
    ) -> Result<Self, NotificationHttpServiceError> {
        let cookies = BrowserCookieBoundary::new(external_url)
            .map_err(|_| NotificationHttpServiceError::Internal)?;
        Ok(Self {
            runtime: Some(Arc::new(NotificationRuntime {
                sessions: SessionService::new(pool.clone(), session_policy),
                pool,
                cookies,
            })),
        })
    }

    fn runtime(&self) -> Result<&NotificationRuntime, NotificationHttpServiceError> {
        self.runtime
            .as_deref()
            .ok_or(NotificationHttpServiceError::Unavailable)
    }
}

impl NotificationRuntime {
    async fn authenticate(
        &self,
        request: BrowserRequestHeaders<'_>,
    ) -> Result<AuthenticatedIdentity, NotificationHttpServiceError> {
        let token = self
            .cookies
            .validate(request)
            .map_err(map_browser_error)?
            .into_session_token();
        let session = self
            .sessions
            .authenticate(&token)
            .await
            .map_err(map_session_error)?;
        Ok(AuthenticatedIdentity {
            user_id: session.user_id(),
            session_id: session.id(),
        })
    }
}

async fn smtp_configured(
    tx: &mut Transaction<'_, Postgres>,
) -> Result<bool, NotificationHttpServiceError> {
    sqlx::query_scalar("SELECT COALESCE((SELECT value #>> '{}'='true' FROM instance_settings WHERE key='smtp.enabled'),FALSE)")
        .fetch_one(&mut **tx)
        .await.map_err(|_| NotificationHttpServiceError::Unavailable)
}

async fn configure_transaction(
    tx: &mut Transaction<'_, Postgres>,
) -> Result<(), NotificationHttpServiceError> {
    sqlx::query(
        "SELECT set_config('lock_timeout','1000ms',TRUE),\
         set_config('statement_timeout','4000ms',TRUE)",
    )
    .execute(&mut **tx)
    .await
    .map_err(|_| NotificationHttpServiceError::Unavailable)?;
    Ok(())
}

fn format_time(value: OffsetDateTime) -> Result<String, NotificationHttpServiceError> {
    value
        .format(&Rfc3339)
        .map_err(|_| NotificationHttpServiceError::Internal)
}
fn map_browser_error(error: BrowserCookieError) -> NotificationHttpServiceError {
    match error {
        BrowserCookieError::MissingSessionCookie | BrowserCookieError::InvalidSessionCookie => {
            NotificationHttpServiceError::AuthenticationFailed
        }
        _ => NotificationHttpServiceError::Forbidden,
    }
}
fn map_session_error(error: SessionServiceError) -> NotificationHttpServiceError {
    match error {
        SessionServiceError::InvalidToken | SessionServiceError::UserUnavailable => {
            NotificationHttpServiceError::AuthenticationFailed
        }
        _ => NotificationHttpServiceError::Unavailable,
    }
}
