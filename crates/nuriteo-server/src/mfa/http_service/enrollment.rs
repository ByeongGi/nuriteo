#![allow(unused_imports)]
use super::policy::*;
use super::*;
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

use super::super::{
    EnrollmentComplete, EnrollmentStart, MfaChallengePolicy, MfaIdempotencyKey, MfaService,
    MfaServiceError, RecoveryCode, TotpCode,
};
use super::{
    ENROLLMENT_ISSUER, MAX_POLICY_TARGETS, MfaEnrollmentCompleteView, MfaEnrollmentStartView,
    MfaHttpRuntime, MfaHttpService, MfaHttpServiceError, MfaPolicyImpactView, MfaPolicyView,
    MfaResetTargetCollectionView, MfaResetTargetView, MfaStatusView, POLICY_POPULATION_DOMAIN,
    RotatedMfaResponse, SecretText,
};

impl fmt::Display for super::MfaHttpServiceError {
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

impl fmt::Debug for MfaEnrollmentCompleteView {
    fn fmt(&self, formatter: &mut fmt::Formatter<'_>) -> fmt::Result {
        formatter.write_str("MfaEnrollmentCompleteView { recovery_codes: [REDACTED] }")
    }
}

impl SecretText {
    pub(crate) fn new(value: String) -> Self {
        Self(Zeroizing::new(value))
    }

    pub(crate) fn from_zeroizing(value: Zeroizing<String>) -> Self {
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

    pub(crate) fn runtime(&self) -> Result<&MfaHttpRuntime, MfaHttpServiceError> {
        self.runtime
            .as_deref()
            .ok_or(MfaHttpServiceError::Unavailable)
    }
}

impl MfaHttpRuntime {
    pub(crate) fn validate_browser(
        &self,
        request: BrowserRequestHeaders<'_>,
    ) -> Result<SessionToken, MfaHttpServiceError> {
        Ok(self
            .cookies
            .validate(request)
            .map_err(|_| MfaHttpServiceError::Forbidden)?
            .into_session_token())
    }

    pub(crate) async fn authenticate(
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

    pub(crate) fn complete_response(
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

    pub(crate) fn rotated_response<T>(
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

pub(crate) fn enrollment_view(
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

pub(crate) fn base32(bytes: &[u8]) -> Zeroizing<String> {
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

pub(crate) async fn require_admin(
    pool: &DatabasePool,
    user_id: UserId,
) -> Result<(), MfaHttpServiceError> {
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

pub(crate) async fn ensure_user_requirement(
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

pub(crate) async fn authorize_recent_admin(
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
