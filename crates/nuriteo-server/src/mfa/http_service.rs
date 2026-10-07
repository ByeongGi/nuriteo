use base64::{Engine as _, engine::general_purpose::URL_SAFE_NO_PAD};
use serde::{Serialize, Serializer};
use serde_json::json;
use sha2::{Digest, Sha256};
use sqlx::{Acquire, Postgres, Row, Transaction};
use std::fmt;
use std::sync::Arc;
use time::OffsetDateTime;
use time::format_description::well_known::Rfc3339;
use url::Url;
use utoipa::ToSchema;
use uuid::Uuid;
use zeroize::Zeroizing;

use crate::database::DatabasePool;
use crate::identity::{
    BrowserCookieBoundary, BrowserRequestHeaders, CookieLifetime, IssuedBrowserCookies,
    SessionPolicy, SessionService, SessionToken, Timestamp, UserId, acquire_mfa_population_lock,
    has_required_active_local_enrolled_admin,
};
use crate::integration::MasterKeyring;

use super::{
    EnrollmentComplete, EnrollmentStart, MfaChallengePolicy, MfaIdempotencyKey, MfaService,
    MfaServiceError, RecoveryCode, TotpCode,
};

const MAX_POLICY_TARGETS: usize = 10_000;
const ENROLLMENT_ISSUER: &str = "NURITEO";
const POLICY_POPULATION_DOMAIN: &[u8] = b"nuriteo.mfa-policy-population.v1";

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum MfaHttpServiceError {
    AuthenticationFailed,
    Forbidden,
    ReauthenticationRequired,
    InvalidInput,
    ChallengeFailed,
    NotActive,
    Conflict,
    PreconditionFailed,
    Unavailable,
    Internal,
}

impl fmt::Display for MfaHttpServiceError {
    fn fmt(&self, formatter: &mut fmt::Formatter<'_>) -> fmt::Result {
        formatter.write_str(match self {
            Self::AuthenticationFailed => "MFA authentication failed",
            Self::Forbidden => "MFA operation is forbidden",
            Self::ReauthenticationRequired => "recent reauthentication is required",
            Self::InvalidInput => "MFA request is invalid",
            Self::ChallengeFailed => "MFA challenge failed",
            Self::NotActive => "MFA is not active",
            Self::Conflict => "MFA state changed concurrently",
            Self::PreconditionFailed => "MFA policy precondition failed",
            Self::Unavailable => "MFA service is unavailable",
            Self::Internal => "MFA operation failed",
        })
    }
}

impl std::error::Error for MfaHttpServiceError {}

#[derive(Debug, Clone, Serialize, ToSchema)]
#[serde(rename_all = "camelCase")]
pub struct MfaStatusView {
    pub local_account: bool,
    pub enrolled: bool,
    pub pending_enrollment: bool,
    pub recovery_codes_remaining: u16,
    pub policy_mode: String,
    pub grace_period_days: u16,
    pub required: bool,
    pub deadline_at: Option<String>,
    pub restricted: bool,
    pub notification_state: String,
}

#[derive(Serialize, ToSchema)]
#[serde(rename_all = "camelCase")]
pub struct MfaEnrollmentStartView {
    pub credential_id: String,
    pub manual_secret: SecretText,
    pub provisioning_uri: SecretText,
}

impl fmt::Debug for MfaEnrollmentStartView {
    fn fmt(&self, formatter: &mut fmt::Formatter<'_>) -> fmt::Result {
        formatter
            .debug_struct("MfaEnrollmentStartView")
            .field("credential_id", &self.credential_id)
            .field("manual_secret", &"[REDACTED]")
            .field("provisioning_uri", &"[REDACTED]")
            .finish()
    }
}

#[derive(Serialize, ToSchema)]
#[serde(rename_all = "camelCase")]
pub struct MfaEnrollmentCompleteView {
    pub recovery_codes: Vec<SecretText>,
}

impl fmt::Debug for MfaEnrollmentCompleteView {
    fn fmt(&self, formatter: &mut fmt::Formatter<'_>) -> fmt::Result {
        formatter.write_str("MfaEnrollmentCompleteView { recovery_codes: [REDACTED] }")
    }
}

#[derive(Debug, Clone, Serialize, ToSchema)]
#[serde(rename_all = "camelCase")]
pub struct MfaPolicyView {
    pub mode: String,
    pub grace_period_days: u16,
    pub version: u64,
    pub affected_users: u64,
    pub immediately_restricted_users: u64,
    pub enrolled_local_administrators: u64,
}

#[derive(Debug, Clone, Serialize, ToSchema)]
#[serde(rename_all = "camelCase")]
pub struct MfaPolicyImpactView {
    pub mode: String,
    pub grace_period_days: u16,
    pub policy_version: u64,
    pub affected_users: u64,
    pub unenrolled_users: u64,
    pub immediately_restricted_users: u64,
    pub enrolled_local_administrators: u64,
    pub population_proof: String,
}

#[derive(Debug, Clone, Serialize, ToSchema)]
#[serde(rename_all = "camelCase")]
pub struct MfaResetTargetView {
    pub user_id: String,
    pub email: String,
    pub display_name: String,
    pub credential_generation: String,
}

#[derive(Debug, Clone, Serialize, ToSchema)]
#[serde(rename_all = "camelCase")]
pub struct MfaResetTargetCollectionView {
    pub items: Vec<MfaResetTargetView>,
}

pub(crate) struct RotatedMfaResponse<T> {
    pub(crate) view: T,
    pub(crate) cookies: IssuedBrowserCookies,
}

#[derive(ToSchema)]
#[schema(value_type = String)]
pub struct SecretText(Zeroizing<String>);

impl SecretText {
    fn new(value: String) -> Self {
        Self(Zeroizing::new(value))
    }

    fn from_zeroizing(value: Zeroizing<String>) -> Self {
        Self(value)
    }
}

impl Serialize for SecretText {
    fn serialize<S>(&self, serializer: S) -> Result<S::Ok, S::Error>
    where
        S: Serializer,
    {
        serializer.serialize_str(&self.0)
    }
}

impl fmt::Debug for SecretText {
    fn fmt(&self, formatter: &mut fmt::Formatter<'_>) -> fmt::Result {
        formatter.write_str("SecretText([REDACTED])")
    }
}

#[derive(Clone)]
pub struct MfaHttpService {
    runtime: Option<Arc<MfaHttpRuntime>>,
}

struct MfaHttpRuntime {
    pool: DatabasePool,
    sessions: SessionService,
    cookies: BrowserCookieBoundary,
    service: MfaService,
}

impl fmt::Debug for MfaHttpService {
    fn fmt(&self, formatter: &mut fmt::Formatter<'_>) -> fmt::Result {
        formatter
            .debug_struct("MfaHttpService")
            .field("configured", &self.runtime.is_some())
            .finish()
    }
}

impl MfaHttpService {
    #[must_use]
    pub const fn unconfigured() -> Self {
        Self { runtime: None }
    }

    pub fn production(
        pool: DatabasePool,
        external_url: &Url,
        keyring: MasterKeyring,
        session_policy: SessionPolicy,
    ) -> Result<Self, MfaHttpServiceError> {
        let cookies =
            BrowserCookieBoundary::new(external_url).map_err(|_| MfaHttpServiceError::Internal)?;
        Ok(Self {
            runtime: Some(Arc::new(MfaHttpRuntime {
                sessions: SessionService::new(pool.clone(), session_policy),
                service: MfaService::new(
                    pool.clone(),
                    keyring,
                    session_policy,
                    MfaChallengePolicy::default(),
                ),
                pool,
                cookies,
            })),
        })
    }

    pub(crate) async fn status(
        &self,
        request: BrowserRequestHeaders<'_>,
    ) -> Result<MfaStatusView, MfaHttpServiceError> {
        let runtime = self.runtime()?;
        let (_, user_id) = runtime.authenticate(request).await?;
        ensure_user_requirement(&runtime.pool, user_id).await?;
        let mut connection = runtime
            .pool
            .acquire()
            .await
            .map_err(|_| MfaHttpServiceError::Unavailable)?;
        let row = sqlx::query(
            "SELECT EXISTS(SELECT 1 FROM local_password_credentials WHERE user_id=$1::uuid) AS local_account, \
             EXISTS(SELECT 1 FROM mfa_totp_credentials WHERE user_id=$1::uuid AND state='active') AS enrolled, \
             EXISTS(SELECT 1 FROM mfa_totp_credentials WHERE user_id=$1::uuid AND state='pending') AS pending, \
             (SELECT COUNT(*) FROM mfa_recovery_codes WHERE user_id=$1::uuid) AS recovery_count, \
             mode.value #>> '{}' AS mode, (grace.value #>> '{}')::smallint AS grace_days, \
             requirement.deadline_at, transaction_timestamp() AS now \
             FROM instance_settings mode CROSS JOIN instance_settings grace \
             LEFT JOIN mfa_enrollment_requirements requirement ON requirement.user_id=$1::uuid \
             WHERE mode.key='security.mfa_enforcement' AND grace.key='security.mfa_grace_period_days'",
        )
        .bind(user_id.to_string())
        .fetch_one(&mut *connection)
        .await
        .map_err(|_| MfaHttpServiceError::Unavailable)?;
        let enrolled: bool = row.get("enrolled");
        let deadline: Option<OffsetDateTime> = row.get("deadline_at");
        let now: OffsetDateTime = row.get("now");
        let required = deadline.is_some() && !enrolled;
        let restricted = required && deadline.is_some_and(|value| value <= now);
        let notification_state = if restricted {
            "overdue"
        } else if required {
            "grace_period"
        } else {
            "none"
        };
        Ok(MfaStatusView {
            local_account: row.get("local_account"),
            enrolled,
            pending_enrollment: row.get("pending"),
            recovery_codes_remaining: u16::try_from(row.get::<i64, _>("recovery_count"))
                .map_err(|_| MfaHttpServiceError::Internal)?,
            policy_mode: row.get("mode"),
            grace_period_days: u16::try_from(row.get::<i16, _>("grace_days"))
                .map_err(|_| MfaHttpServiceError::Internal)?,
            required,
            deadline_at: deadline.map(format_time).transpose()?,
            restricted,
            notification_state: notification_state.into(),
        })
    }

    pub(crate) async fn begin_enrollment(
        &self,
        request: BrowserRequestHeaders<'_>,
        idempotency_key: &MfaIdempotencyKey,
        correlation_id: &str,
    ) -> Result<MfaEnrollmentStartView, MfaHttpServiceError> {
        let runtime = self.runtime()?;
        let token = runtime.validate_browser(request)?;
        let started = runtime
            .service
            .begin_enrollment_idempotent(&token, idempotency_key, correlation_id)
            .await
            .map_err(map_service_error)?;
        let mut connection = runtime
            .pool
            .acquire()
            .await
            .map_err(|_| MfaHttpServiceError::Unavailable)?;
        let account_email: String =
            sqlx::query_scalar("SELECT email FROM users WHERE id=$1::uuid AND status='active'")
                .bind(started.metadata.user_id.to_string())
                .fetch_one(&mut *connection)
                .await
                .map_err(|_| MfaHttpServiceError::Unavailable)?;
        enrollment_view(started, &account_email)
    }

    pub(crate) async fn confirm_enrollment(
        &self,
        request: BrowserRequestHeaders<'_>,
        credential_id: Uuid,
        code: &[u8],
        idempotency_key: &MfaIdempotencyKey,
        correlation_id: &str,
    ) -> Result<RotatedMfaResponse<MfaEnrollmentCompleteView>, MfaHttpServiceError> {
        let runtime = self.runtime()?;
        let token = runtime.validate_browser(request)?;
        let code = TotpCode::parse(code).map_err(map_service_error)?;
        let complete = runtime
            .service
            .confirm_enrollment_idempotent(
                &token,
                credential_id,
                &code,
                idempotency_key,
                correlation_id,
            )
            .await
            .map_err(map_service_error)?;
        runtime.complete_response(complete)
    }

    pub(crate) async fn challenge(
        &self,
        request: BrowserRequestHeaders<'_>,
        code: &[u8],
        idempotency_key: &MfaIdempotencyKey,
        correlation_id: &str,
    ) -> Result<RotatedMfaResponse<()>, MfaHttpServiceError> {
        let runtime = self.runtime()?;
        let token = runtime.validate_browser(request)?;
        let code = TotpCode::parse(code).map_err(map_service_error)?;
        let issued = runtime
            .service
            .verify_totp_idempotent(&token, &code, idempotency_key, correlation_id)
            .await
            .map_err(map_service_error)?;
        runtime.rotated_response((), issued)
    }

    pub(crate) async fn recover(
        &self,
        request: BrowserRequestHeaders<'_>,
        code: Vec<u8>,
        idempotency_key: &MfaIdempotencyKey,
        correlation_id: &str,
    ) -> Result<RotatedMfaResponse<()>, MfaHttpServiceError> {
        let runtime = self.runtime()?;
        let token = runtime.validate_browser(request)?;
        let code = RecoveryCode::new(code).map_err(|_| MfaHttpServiceError::InvalidInput)?;
        let issued = runtime
            .service
            .recover_idempotent(&token, code, idempotency_key, correlation_id)
            .await
            .map_err(map_service_error)?;
        runtime.rotated_response((), issued)
    }

    pub(crate) async fn disable(
        &self,
        request: BrowserRequestHeaders<'_>,
        correlation_id: &str,
    ) -> Result<RotatedMfaResponse<()>, MfaHttpServiceError> {
        let runtime = self.runtime()?;
        let (token, _) = runtime.authenticate(request).await?;
        let issued = runtime
            .service
            .disable_self(&token, correlation_id)
            .await
            .map_err(map_service_error)?;
        runtime.rotated_response((), issued)
    }

    pub(crate) async fn policy(
        &self,
        request: BrowserRequestHeaders<'_>,
    ) -> Result<MfaPolicyView, MfaHttpServiceError> {
        let runtime = self.runtime()?;
        let (_, actor) = runtime.authenticate(request).await?;
        require_admin(&runtime.pool, actor).await?;
        load_policy_view(&runtime.pool).await
    }

    pub(crate) async fn update_policy(
        &self,
        request: BrowserRequestHeaders<'_>,
        mode: &str,
        grace_days: u16,
        expected_version: u64,
        expected_population_proof: &str,
        correlation_id: &str,
    ) -> Result<MfaPolicyView, MfaHttpServiceError> {
        if !matches!(mode, "off" | "administrators" | "all_local_users")
            || grace_days > 30
            || !valid_population_proof(expected_population_proof)
        {
            return Err(MfaHttpServiceError::InvalidInput);
        }
        let runtime = self.runtime()?;
        let (token, actor) = runtime.authenticate(request).await?;
        let session = runtime
            .sessions
            .authenticate(&token)
            .await
            .map_err(map_http_session_error)?;
        let mut connection = runtime
            .pool
            .acquire()
            .await
            .map_err(|_| MfaHttpServiceError::Unavailable)?;
        let mut tx = connection
            .begin()
            .await
            .map_err(|_| MfaHttpServiceError::Unavailable)?;
        acquire_mfa_population_lock(&mut tx)
            .await
            .map_err(|_| MfaHttpServiceError::Unavailable)?;
        authorize_recent_admin(&mut tx, actor, session.id()).await?;
        let version: i64 = sqlx::query_scalar(
            "SELECT lock_version FROM mfa_policy_state WHERE singleton FOR UPDATE",
        )
        .fetch_one(&mut *tx)
        .await
        .map_err(|_| MfaHttpServiceError::Unavailable)?;
        if u64::try_from(version).ok() != Some(expected_version) {
            return Err(MfaHttpServiceError::Conflict);
        }
        let impact = load_policy_impact(&mut tx, mode, grace_days, expected_version).await?;
        if impact.population_proof != expected_population_proof {
            return Err(MfaHttpServiceError::PreconditionFailed);
        }
        if mode != "off" {
            let enrolled_admins: i64 = sqlx::query_scalar(
                "SELECT COUNT(*) FROM users u JOIN local_password_credentials local ON local.user_id=u.id \
                 JOIN mfa_totp_credentials mfa ON mfa.user_id=u.id AND mfa.state='active' \
                 WHERE u.status='active' AND u.is_instance_admin",
            )
            .fetch_one(&mut *tx)
            .await
            .map_err(|_| MfaHttpServiceError::Unavailable)?;
            if enrolled_admins < 1 {
                return Err(MfaHttpServiceError::PreconditionFailed);
            }
            if grace_days == 0 {
                let actor_ready: bool = sqlx::query_scalar(
                    "SELECT EXISTS(SELECT 1 FROM local_password_credentials local \
                     JOIN mfa_totp_credentials mfa ON mfa.user_id=local.user_id AND mfa.state='active' \
                     WHERE local.user_id=$1::uuid)",
                )
                .bind(actor.to_string())
                .fetch_one(&mut *tx)
                .await
                .map_err(|_| MfaHttpServiceError::Unavailable)?;
                let actor_local: bool = sqlx::query_scalar(
                    "SELECT EXISTS(SELECT 1 FROM local_password_credentials WHERE user_id=$1::uuid)",
                )
                .bind(actor.to_string())
                .fetch_one(&mut *tx)
                .await
                .map_err(|_| MfaHttpServiceError::Unavailable)?;
                if actor_local && !actor_ready {
                    return Err(MfaHttpServiceError::PreconditionFailed);
                }
            }
        }
        reconcile_policy(&mut tx, actor, mode, grace_days, correlation_id).await?;
        if !has_required_active_local_enrolled_admin(&mut tx)
            .await
            .map_err(|_| MfaHttpServiceError::Unavailable)?
        {
            return Err(MfaHttpServiceError::PreconditionFailed);
        }
        tx.commit()
            .await
            .map_err(|_| MfaHttpServiceError::Unavailable)?;
        load_policy_view(&runtime.pool).await
    }

    pub(crate) async fn preview_policy(
        &self,
        request: BrowserRequestHeaders<'_>,
        mode: &str,
        grace_days: u16,
        expected_version: u64,
    ) -> Result<MfaPolicyImpactView, MfaHttpServiceError> {
        if !matches!(mode, "off" | "administrators" | "all_local_users") || grace_days > 30 {
            return Err(MfaHttpServiceError::InvalidInput);
        }
        let runtime = self.runtime()?;
        let (_, actor) = runtime.authenticate(request).await?;
        require_admin(&runtime.pool, actor).await?;
        let mut connection = runtime
            .pool
            .acquire()
            .await
            .map_err(|_| MfaHttpServiceError::Unavailable)?;
        let version: i64 =
            sqlx::query_scalar("SELECT lock_version FROM mfa_policy_state WHERE singleton")
                .fetch_one(&mut *connection)
                .await
                .map_err(|_| MfaHttpServiceError::Unavailable)?;
        if u64::try_from(version).ok() != Some(expected_version) {
            return Err(MfaHttpServiceError::Conflict);
        }
        load_policy_impact(&mut connection, mode, grace_days, expected_version).await
    }

    pub(crate) async fn admin_reset(
        &self,
        request: BrowserRequestHeaders<'_>,
        target: UserId,
        credential_generation: Uuid,
        confirmation: &str,
        correlation_id: &str,
    ) -> Result<(), MfaHttpServiceError> {
        let runtime = self.runtime()?;
        let (token, _) = runtime.authenticate(request).await?;
        runtime
            .service
            .admin_reset(
                &token,
                target,
                credential_generation,
                confirmation,
                correlation_id,
            )
            .await
            .map_err(map_service_error)
    }

    pub(crate) async fn reset_targets(
        &self,
        request: BrowserRequestHeaders<'_>,
        query: &str,
    ) -> Result<MfaResetTargetCollectionView, MfaHttpServiceError> {
        let query = query.trim();
        if query.len() < 2 || query.len() > 200 || query.chars().any(char::is_control) {
            return Err(MfaHttpServiceError::InvalidInput);
        }
        let runtime = self.runtime()?;
        let (_, actor) = runtime.authenticate(request).await?;
        require_admin(&runtime.pool, actor).await?;
        let mut connection = runtime
            .pool
            .acquire()
            .await
            .map_err(|_| MfaHttpServiceError::Unavailable)?;
        let pattern = format!(
            "%{}%",
            query
                .replace('\\', "\\\\")
                .replace('%', "\\%")
                .replace('_', "\\_")
        );
        let rows = sqlx::query(
            "SELECT account.id::text,account.email,account.display_name,mfa.id::text AS credential_generation \
             FROM users account JOIN local_password_credentials local ON local.user_id=account.id \
             JOIN mfa_totp_credentials mfa ON mfa.user_id=account.id AND mfa.state='active' \
             WHERE account.status='active' AND account.id<>$1::uuid \
             AND (account.email ILIKE $2 ESCAPE '\\' OR account.display_name ILIKE $2 ESCAPE '\\') \
             ORDER BY account.email,account.id LIMIT 20",
        )
        .bind(actor.to_string())
        .bind(pattern)
        .fetch_all(&mut *connection)
        .await
        .map_err(|_| MfaHttpServiceError::Unavailable)?;
        Ok(MfaResetTargetCollectionView {
            items: rows
                .into_iter()
                .map(|row| MfaResetTargetView {
                    user_id: row.get("id"),
                    email: row.get("email"),
                    display_name: row.get("display_name"),
                    credential_generation: row.get("credential_generation"),
                })
                .collect(),
        })
    }

    fn runtime(&self) -> Result<&MfaHttpRuntime, MfaHttpServiceError> {
        self.runtime
            .as_deref()
            .ok_or(MfaHttpServiceError::Unavailable)
    }
}

impl MfaHttpRuntime {
    fn validate_browser(
        &self,
        request: BrowserRequestHeaders<'_>,
    ) -> Result<SessionToken, MfaHttpServiceError> {
        Ok(self
            .cookies
            .validate(request)
            .map_err(|_| MfaHttpServiceError::Forbidden)?
            .into_session_token())
    }

    async fn authenticate(
        &self,
        request: BrowserRequestHeaders<'_>,
    ) -> Result<(SessionToken, UserId), MfaHttpServiceError> {
        let token = self.validate_browser(request)?;
        let session = self
            .sessions
            .authenticate(&token)
            .await
            .map_err(map_http_session_error)?;
        Ok((token, session.user_id()))
    }

    fn complete_response(
        &self,
        complete: EnrollmentComplete,
    ) -> Result<RotatedMfaResponse<MfaEnrollmentCompleteView>, MfaHttpServiceError> {
        let recovery_codes = complete
            .recovery_codes
            .iter()
            .map(|code| {
                String::from_utf8(code.expose_to_http_adapter().to_vec())
                    .map(SecretText::new)
                    .map_err(|_| MfaHttpServiceError::Internal)
            })
            .collect::<Result<Vec<_>, _>>()?;
        self.rotated_response(
            MfaEnrollmentCompleteView { recovery_codes },
            complete.session,
        )
    }

    fn rotated_response<T>(
        &self,
        view: T,
        issued: crate::identity::IssuedSession,
    ) -> Result<RotatedMfaResponse<T>, MfaHttpServiceError> {
        let fields = issued.session().clone().into_fields();
        let now = Timestamp::from_datetime(OffsetDateTime::now_utc())
            .map_err(|_| MfaHttpServiceError::Internal)?;
        let lifetime = CookieLifetime::new(now, fields.absolute_expires_at)
            .map_err(|_| MfaHttpServiceError::Internal)?;
        let cookies = self
            .cookies
            .issue(issued.token(), lifetime)
            .map_err(|_| MfaHttpServiceError::Internal)?;
        Ok(RotatedMfaResponse { view, cookies })
    }
}

fn enrollment_view(
    started: EnrollmentStart,
    account_email: &str,
) -> Result<MfaEnrollmentStartView, MfaHttpServiceError> {
    let secret = base32(started.secret.expose_to_http_adapter());
    let label = format!("{ENROLLMENT_ISSUER}:{account_email}");
    let provisioning_uri = format!(
        "otpauth://totp/{}?secret={}&issuer={ENROLLMENT_ISSUER}&algorithm=SHA1&digits=6&period=30",
        percent_encoding::utf8_percent_encode(&label, percent_encoding::NON_ALPHANUMERIC),
        secret.as_str(),
    );
    Ok(MfaEnrollmentStartView {
        credential_id: started.metadata.id.to_string(),
        manual_secret: SecretText::from_zeroizing(secret),
        provisioning_uri: SecretText::new(provisioning_uri),
    })
}

fn base32(bytes: &[u8]) -> Zeroizing<String> {
    const ALPHABET: &[u8; 32] = b"ABCDEFGHIJKLMNOPQRSTUVWXYZ234567";
    let mut output = String::with_capacity((bytes.len() * 8).div_ceil(5));
    let mut buffer = 0_u32;
    let mut bits = 0_u8;
    for byte in bytes {
        buffer = (buffer << 8) | u32::from(*byte);
        bits += 8;
        while bits >= 5 {
            bits -= 5;
            output.push(char::from(ALPHABET[((buffer >> bits) & 31) as usize]));
        }
    }
    if bits > 0 {
        output.push(char::from(ALPHABET[((buffer << (5 - bits)) & 31) as usize]));
    }
    Zeroizing::new(output)
}

async fn require_admin(pool: &DatabasePool, user_id: UserId) -> Result<(), MfaHttpServiceError> {
    let mut connection = pool
        .acquire()
        .await
        .map_err(|_| MfaHttpServiceError::Unavailable)?;
    let allowed: bool = sqlx::query_scalar(
        "SELECT status='active' AND is_instance_admin FROM users WHERE id=$1::uuid",
    )
    .bind(user_id.to_string())
    .fetch_optional(&mut *connection)
    .await
    .map_err(|_| MfaHttpServiceError::Unavailable)?
    .unwrap_or(false);
    if allowed {
        Ok(())
    } else {
        Err(MfaHttpServiceError::Forbidden)
    }
}

async fn ensure_user_requirement(
    pool: &DatabasePool,
    user_id: UserId,
) -> Result<(), MfaHttpServiceError> {
    let mut connection = pool
        .acquire()
        .await
        .map_err(|_| MfaHttpServiceError::Unavailable)?;
    let mut tx = connection
        .begin()
        .await
        .map_err(|_| MfaHttpServiceError::Unavailable)?;
    let row = sqlx::query(
        "SELECT account.status='active' AND EXISTS(SELECT 1 FROM local_password_credentials local \
         WHERE local.user_id=account.id) AS local_active,account.is_instance_admin, \
         EXISTS(SELECT 1 FROM mfa_totp_credentials mfa WHERE mfa.user_id=account.id AND mfa.state='active') AS enrolled, \
         mode.value #>> '{}' AS mode,(grace.value #>> '{}')::smallint AS grace_days \
         FROM users account CROSS JOIN instance_settings mode CROSS JOIN instance_settings grace \
         WHERE account.id=$1::uuid AND mode.key='security.mfa_enforcement' \
         AND grace.key='security.mfa_grace_period_days' FOR UPDATE OF account",
    )
    .bind(user_id.to_string())
    .fetch_optional(&mut *tx)
    .await
    .map_err(|_| MfaHttpServiceError::Unavailable)?
    .ok_or(MfaHttpServiceError::AuthenticationFailed)?;
    let mode: String = row.get("mode");
    let applies = row.get::<bool, _>("local_active")
        && (mode == "all_local_users"
            || (mode == "administrators" && row.get::<bool, _>("is_instance_admin")));
    if !applies || row.get::<bool, _>("enrolled") {
        sqlx::query(
            "UPDATE notifications notification SET action_state='resolved',resolved_at=transaction_timestamp(), \
             updated_at=transaction_timestamp(),lock_version=lock_version+1 \
             FROM mfa_enrollment_requirements requirement WHERE requirement.user_id=$1::uuid \
             AND requirement.notification_id=notification.id AND notification.action_state='pending'",
        )
        .bind(user_id.to_string())
        .execute(&mut *tx)
        .await
        .map_err(|_| MfaHttpServiceError::Unavailable)?;
        sqlx::query("DELETE FROM mfa_enrollment_requirements WHERE user_id=$1::uuid")
            .bind(user_id.to_string())
            .execute(&mut *tx)
            .await
            .map_err(|_| MfaHttpServiceError::Unavailable)?;
    } else {
        let exists: bool = sqlx::query_scalar(
            "SELECT EXISTS(SELECT 1 FROM mfa_enrollment_requirements WHERE user_id=$1::uuid)",
        )
        .bind(user_id.to_string())
        .fetch_one(&mut *tx)
        .await
        .map_err(|_| MfaHttpServiceError::Unavailable)?;
        if !exists {
            let notification_id = Uuid::now_v7();
            let grace_days: i16 = row.get("grace_days");
            sqlx::query(
                "INSERT INTO notifications(id,recipient_user_id,classification,event_code,template_id,locale, \
                 resource_type,resource_id,rendering_data,action_state,first_occurred_at,last_occurred_at) \
                 VALUES($1::uuid,$2::uuid,'account_access','mfa.enrollment_required','mfa-enrollment-required-v1', \
                 'en','user',$2,jsonb_build_object('policyMode',$3,'deadlineAt', \
                 transaction_timestamp()+make_interval(days=>$4)),'pending',transaction_timestamp(),transaction_timestamp())",
            )
            .bind(notification_id.to_string())
            .bind(user_id.to_string())
            .bind(&mode)
            .bind(i32::from(grace_days))
            .execute(&mut *tx)
            .await
            .map_err(|_| MfaHttpServiceError::Unavailable)?;
            sqlx::query(
                "INSERT INTO mfa_enrollment_requirements(user_id,policy_mode,required_since,deadline_at,notification_id) \
                 VALUES($1::uuid,$2,transaction_timestamp(),transaction_timestamp()+make_interval(days=>$3),$4::uuid)",
            )
            .bind(user_id.to_string())
            .bind(mode)
            .bind(i32::from(grace_days))
            .bind(notification_id.to_string())
            .execute(&mut *tx)
            .await
            .map_err(|_| MfaHttpServiceError::Unavailable)?;
        }
    }
    tx.commit()
        .await
        .map_err(|_| MfaHttpServiceError::Unavailable)
}

async fn authorize_recent_admin(
    tx: &mut Transaction<'_, Postgres>,
    user_id: UserId,
    session_id: crate::identity::SessionId,
) -> Result<(), MfaHttpServiceError> {
    let row = sqlx::query(
        "SELECT active.last_reauthenticated_at,transaction_timestamp() AS now, \
         (policy.value #>> '{}')::integer AS minutes FROM users actor \
         JOIN sessions active ON active.user_id=actor.id \
         CROSS JOIN instance_settings policy \
         WHERE actor.id=$1::uuid AND active.id=$2::uuid AND actor.status='active' \
         AND actor.is_instance_admin AND active.revoked_at IS NULL \
         AND active.idle_expires_at>transaction_timestamp() \
         AND active.absolute_expires_at>transaction_timestamp() \
         AND policy.key='security.reauthentication_window_minutes' FOR UPDATE OF actor,active",
    )
    .bind(user_id.to_string())
    .bind(session_id.to_string())
    .fetch_optional(&mut **tx)
    .await
    .map_err(|_| MfaHttpServiceError::Unavailable)?
    .ok_or(MfaHttpServiceError::Forbidden)?;
    let last: Option<OffsetDateTime> = row.get("last_reauthenticated_at");
    let now: OffsetDateTime = row.get("now");
    let minutes: i32 = row.get("minutes");
    if !(15..=120).contains(&minutes)
        || !last.is_some_and(|value| {
            value <= now && value >= now - time::Duration::minutes(i64::from(minutes))
        })
    {
        return Err(MfaHttpServiceError::ReauthenticationRequired);
    }
    Ok(())
}

async fn reconcile_policy(
    tx: &mut Transaction<'_, Postgres>,
    actor: UserId,
    mode: &str,
    grace_days: u16,
    correlation_id: &str,
) -> Result<(), MfaHttpServiceError> {
    sqlx::query(
        "UPDATE notifications notification SET action_state='canceled',resolved_at=transaction_timestamp(), \
         updated_at=transaction_timestamp(),lock_version=lock_version+1 \
         FROM mfa_enrollment_requirements requirement \
         WHERE requirement.notification_id=notification.id AND notification.action_state='pending'",
    )
    .execute(&mut **tx)
    .await
    .map_err(|_| MfaHttpServiceError::Unavailable)?;
    sqlx::query("DELETE FROM mfa_enrollment_requirements")
        .execute(&mut **tx)
        .await
        .map_err(|_| MfaHttpServiceError::Unavailable)?;
    sqlx::query(
        "UPDATE instance_settings SET value=to_jsonb($2::text),lock_version=lock_version+1, \
         updated_at=transaction_timestamp() WHERE key=$1",
    )
    .bind("security.mfa_enforcement")
    .bind(mode)
    .execute(&mut **tx)
    .await
    .map_err(|_| MfaHttpServiceError::Unavailable)?;
    sqlx::query(
        "UPDATE instance_settings SET value=to_jsonb($2::integer),lock_version=lock_version+1, \
         updated_at=transaction_timestamp() WHERE key=$1",
    )
    .bind("security.mfa_grace_period_days")
    .bind(i32::from(grace_days))
    .execute(&mut **tx)
    .await
    .map_err(|_| MfaHttpServiceError::Unavailable)?;
    if mode != "off" {
        let rows = sqlx::query(
            "SELECT u.id::text FROM users u JOIN local_password_credentials local ON local.user_id=u.id \
             WHERE u.status='active' AND ($1='all_local_users' OR ($1='administrators' AND u.is_instance_admin)) \
             AND NOT EXISTS(SELECT 1 FROM mfa_totp_credentials mfa WHERE mfa.user_id=u.id AND mfa.state='active') \
             ORDER BY u.id LIMIT $2",
        )
        .bind(mode)
        .bind(i64::try_from(MAX_POLICY_TARGETS + 1).map_err(|_| MfaHttpServiceError::Internal)?)
        .fetch_all(&mut **tx)
        .await
        .map_err(|_| MfaHttpServiceError::Unavailable)?;
        if rows.len() > MAX_POLICY_TARGETS {
            return Err(MfaHttpServiceError::PreconditionFailed);
        }
        for row in rows {
            let user_id: String = row.get("id");
            let notification_id = Uuid::now_v7();
            sqlx::query(
                "INSERT INTO notifications(id,recipient_user_id,classification,event_code,template_id,locale, \
                 resource_type,resource_id,rendering_data,action_state,first_occurred_at,last_occurred_at) \
                 VALUES($1::uuid,$2::uuid,'account_access','mfa.enrollment_required','mfa-enrollment-required-v1', \
                 'en','user',$2,jsonb_build_object('policyMode',$3,'deadlineAt', \
                 transaction_timestamp()+make_interval(days=>$4)),'pending',transaction_timestamp(),transaction_timestamp())",
            )
            .bind(notification_id.to_string())
            .bind(&user_id)
            .bind(mode)
            .bind(i32::from(grace_days))
            .execute(&mut **tx)
            .await
            .map_err(|_| MfaHttpServiceError::Unavailable)?;
            sqlx::query(
                "INSERT INTO mfa_enrollment_requirements(user_id,policy_mode,required_since,deadline_at,notification_id) \
                 VALUES($1::uuid,$2,transaction_timestamp(),transaction_timestamp()+make_interval(days=>$3),$4::uuid)",
            )
            .bind(&user_id)
            .bind(mode)
            .bind(i32::from(grace_days))
            .bind(notification_id.to_string())
            .execute(&mut **tx)
            .await
            .map_err(|_| MfaHttpServiceError::Unavailable)?;
        }
    }
    sqlx::query(
        "UPDATE mfa_policy_state SET lock_version=lock_version+1,updated_at=transaction_timestamp() WHERE singleton",
    )
    .execute(&mut **tx)
    .await
    .map_err(|_| MfaHttpServiceError::Unavailable)?;
    sqlx::query(
        "INSERT INTO audit_events(id,actor_type,actor_id,actor_user_id,action_code,target_type,target_id, \
         scope_type,scope_id,result,correlation_id,changed_fields,metadata) \
         VALUES($1::uuid,'user',$2,$2::uuid,'mfa.policy_updated','instance_policy','mfa','instance','instance', \
         'succeeded',$3,$4,$5::jsonb)",
    )
    .bind(Uuid::now_v7().to_string())
    .bind(actor.to_string())
    .bind(correlation_id)
    .bind(vec!["security.mfa_enforcement", "security.mfa_grace_period_days"])
    .bind(json!({"source":"mfa-policy-api"}).to_string())
    .execute(&mut **tx)
    .await
    .map_err(|_| MfaHttpServiceError::Unavailable)?;
    Ok(())
}

async fn load_policy_view(pool: &DatabasePool) -> Result<MfaPolicyView, MfaHttpServiceError> {
    let mut connection = pool
        .acquire()
        .await
        .map_err(|_| MfaHttpServiceError::Unavailable)?;
    let row = sqlx::query(
        "SELECT mode.value #>> '{}' AS mode,(grace.value #>> '{}')::smallint AS grace_days, \
         state.lock_version,(SELECT COUNT(*) FROM mfa_enrollment_requirements) AS affected, \
         (SELECT COUNT(*) FROM mfa_enrollment_requirements WHERE deadline_at<=transaction_timestamp()) AS restricted, \
         (SELECT COUNT(*) FROM users u JOIN local_password_credentials local ON local.user_id=u.id \
          JOIN mfa_totp_credentials mfa ON mfa.user_id=u.id AND mfa.state='active' \
          WHERE u.status='active' AND u.is_instance_admin) AS enrolled_admins \
         FROM instance_settings mode CROSS JOIN instance_settings grace CROSS JOIN mfa_policy_state state \
         WHERE mode.key='security.mfa_enforcement' AND grace.key='security.mfa_grace_period_days' AND state.singleton",
    )
    .fetch_one(&mut *connection)
    .await
    .map_err(|_| MfaHttpServiceError::Unavailable)?;
    Ok(MfaPolicyView {
        mode: row.get("mode"),
        grace_period_days: u16::try_from(row.get::<i16, _>("grace_days"))
            .map_err(|_| MfaHttpServiceError::Internal)?,
        version: u64::try_from(row.get::<i64, _>("lock_version"))
            .map_err(|_| MfaHttpServiceError::Internal)?,
        affected_users: u64::try_from(row.get::<i64, _>("affected"))
            .map_err(|_| MfaHttpServiceError::Internal)?,
        immediately_restricted_users: u64::try_from(row.get::<i64, _>("restricted"))
            .map_err(|_| MfaHttpServiceError::Internal)?,
        enrolled_local_administrators: u64::try_from(row.get::<i64, _>("enrolled_admins"))
            .map_err(|_| MfaHttpServiceError::Internal)?,
    })
}

async fn load_policy_impact(
    connection: &mut sqlx::PgConnection,
    mode: &str,
    grace_days: u16,
    version: u64,
) -> Result<MfaPolicyImpactView, MfaHttpServiceError> {
    let rows = sqlx::query(
        "SELECT account.id::text,account.is_instance_admin,mfa.id::text AS mfa_id \
         FROM users account JOIN local_password_credentials local ON local.user_id=account.id \
         LEFT JOIN mfa_totp_credentials mfa ON mfa.user_id=account.id AND mfa.state='active' \
         WHERE account.status='active' AND (account.is_instance_admin OR $1='all_local_users') \
         ORDER BY account.id LIMIT $2",
    )
    .bind(mode)
    .bind(i64::try_from(MAX_POLICY_TARGETS + 1).map_err(|_| MfaHttpServiceError::Internal)?)
    .fetch_all(&mut *connection)
    .await
    .map_err(|_| MfaHttpServiceError::Unavailable)?;
    if rows.len() > MAX_POLICY_TARGETS {
        return Err(MfaHttpServiceError::PreconditionFailed);
    }
    let mut affected = 0_u64;
    let mut unenrolled = 0_u64;
    let mut enrolled_admins = 0_u64;
    let mut proof = Sha256::new();
    proof.update(POLICY_POPULATION_DOMAIN);
    proof.update([0]);
    proof.update(mode.as_bytes());
    proof.update([0]);
    proof.update(grace_days.to_be_bytes());
    for row in rows {
        let user_id = Uuid::parse_str(&row.get::<String, _>("id"))
            .map_err(|_| MfaHttpServiceError::Internal)?;
        let administrator: bool = row.get("is_instance_admin");
        let credential_id = row
            .get::<Option<String>, _>("mfa_id")
            .map(|value| Uuid::parse_str(&value).map_err(|_| MfaHttpServiceError::Internal))
            .transpose()?;
        let targeted = mode != "off" && (mode == "all_local_users" || administrator);
        if targeted {
            affected = affected
                .checked_add(1)
                .ok_or(MfaHttpServiceError::Internal)?;
            if credential_id.is_none() {
                unenrolled = unenrolled
                    .checked_add(1)
                    .ok_or(MfaHttpServiceError::Internal)?;
            }
        }
        if administrator && credential_id.is_some() {
            enrolled_admins = enrolled_admins
                .checked_add(1)
                .ok_or(MfaHttpServiceError::Internal)?;
        }
        proof.update(user_id.as_bytes());
        proof.update([u8::from(administrator), u8::from(credential_id.is_some())]);
        if let Some(credential_id) = credential_id {
            proof.update(credential_id.as_bytes());
        }
    }
    Ok(MfaPolicyImpactView {
        mode: mode.into(),
        grace_period_days: grace_days,
        policy_version: version,
        affected_users: affected,
        unenrolled_users: unenrolled,
        immediately_restricted_users: if grace_days == 0 { unenrolled } else { 0 },
        enrolled_local_administrators: enrolled_admins,
        population_proof: URL_SAFE_NO_PAD.encode(proof.finalize()),
    })
}

fn valid_population_proof(value: &str) -> bool {
    value.len() == 43
        && value
            .bytes()
            .all(|byte| byte.is_ascii_alphanumeric() || matches!(byte, b'_' | b'-'))
}

fn format_time(value: OffsetDateTime) -> Result<String, MfaHttpServiceError> {
    value
        .format(&Rfc3339)
        .map_err(|_| MfaHttpServiceError::Internal)
}

fn map_service_error(error: MfaServiceError) -> MfaHttpServiceError {
    match error {
        MfaServiceError::InvalidInput => MfaHttpServiceError::InvalidInput,
        MfaServiceError::AuthenticationFailed => MfaHttpServiceError::AuthenticationFailed,
        MfaServiceError::ReauthenticationRequired => MfaHttpServiceError::ReauthenticationRequired,
        MfaServiceError::ChallengeFailed => MfaHttpServiceError::ChallengeFailed,
        MfaServiceError::Unauthorized => MfaHttpServiceError::Forbidden,
        MfaServiceError::NotActive => MfaHttpServiceError::NotActive,
        MfaServiceError::Conflict => MfaHttpServiceError::Conflict,
        MfaServiceError::Unavailable => MfaHttpServiceError::Unavailable,
    }
}

fn map_http_session_error(error: crate::identity::SessionServiceError) -> MfaHttpServiceError {
    match error {
        crate::identity::SessionServiceError::InvalidToken
        | crate::identity::SessionServiceError::UserUnavailable => {
            MfaHttpServiceError::AuthenticationFailed
        }
        crate::identity::SessionServiceError::InvariantViolation => MfaHttpServiceError::Internal,
        crate::identity::SessionServiceError::SessionLimitReached
        | crate::identity::SessionServiceError::EntropyUnavailable
        | crate::identity::SessionServiceError::DatabaseUnavailable
        | crate::identity::SessionServiceError::OperationTimeout => {
            MfaHttpServiceError::Unavailable
        }
    }
}
