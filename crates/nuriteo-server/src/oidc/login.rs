//! Authorization-code + PKCE login boundary.
#![allow(dead_code, reason = "crate-private OIDC HTTP adapter handoff")]

use std::fmt;
use std::str::FromStr;
use std::time::Duration;

use ::time::OffsetDateTime;
use base64::Engine;
use base64::engine::general_purpose::URL_SAFE_NO_PAD;
use serde_json::json;
use sha2::{Digest, Sha256};
use sqlx::{Acquire, Postgres, Row, Transaction};
use subtle::ConstantTimeEq;
use tokio::time;
use uuid::Uuid;
use zeroize::Zeroizing;

use super::{OidcEndpointValidator, OidcProviderError, OidcProviderService};
use crate::audit::{
    ActorType, AuditActor, AuditEvent, AuditEventFields, AuditEventId, AuditMetadata, AuditResult,
    AuditScope, AuditTarget, AuditWriter, ScopeType,
};
use crate::identity::{
    IssuedSession, NormalizedEmail, SessionRotationKind, SessionService, SessionServiceError,
    SessionToken, Timestamp, UserId,
};
use crate::integration::IntegrationRepository;

const ATTEMPT_ENVELOPE_DOMAIN: &[u8] = b"nuriteo.oidc.pkce-verifier.v1";
const STATE_BYTES: usize = 32;
const NONCE_BYTES: usize = 32;
const VERIFIER_BYTES: usize = 32;
const DEFAULT_TIMEOUT: Duration = Duration::from_secs(15);

pub(crate) struct OidcAuthorizationRequest {
    pub(crate) url: String,
    /// One-time browser binding for an HttpOnly, Secure, SameSite=Lax cookie.
    /// The HTTP adapter must return it only as a cookie and submit it on callback.
    pub(crate) browser_binding: Zeroizing<String>,
}

impl fmt::Debug for OidcAuthorizationRequest {
    fn fmt(&self, formatter: &mut fmt::Formatter<'_>) -> fmt::Result {
        formatter
            .debug_struct("OidcAuthorizationRequest")
            .field("url", &"[REDACTED]")
            .finish()
    }
}

pub(crate) struct OidcCallbackInput<'a> {
    pub(crate) provider_id: Uuid,
    pub(crate) issuer: &'a str,
    pub(crate) state: &'a str,
    pub(crate) code: &'a str,
    pub(crate) browser_binding: &'a str,
    pub(crate) existing_session: Option<&'a SessionToken>,
    pub(crate) correlation_id: &'a str,
}

#[derive(Clone)]
pub(crate) struct OidcLoginService {
    providers: OidcProviderService,
    validator: OidcEndpointValidator,
    integrations: IntegrationRepository,
    sessions: SessionService,
    timeout: Duration,
}

impl fmt::Debug for OidcLoginService {
    fn fmt(&self, formatter: &mut fmt::Formatter<'_>) -> fmt::Result {
        formatter
            .debug_struct("OidcLoginService")
            .field("timeout", &self.timeout)
            .finish_non_exhaustive()
    }
}

impl OidcLoginService {
    pub(crate) fn new(
        providers: OidcProviderService,
        validator: OidcEndpointValidator,
        sessions: SessionService,
    ) -> Self {
        Self {
            integrations: providers.integrations.clone(),
            providers,
            validator,
            sessions,
            timeout: DEFAULT_TIMEOUT,
        }
    }

    pub(crate) async fn begin(
        &self,
        provider_id: Uuid,
    ) -> Result<OidcAuthorizationRequest, OidcProviderError> {
        time::timeout(self.timeout, self.begin_inner(provider_id))
            .await
            .map_err(|_| OidcProviderError::Unavailable)?
    }

    async fn begin_inner(
        &self,
        provider_id: Uuid,
    ) -> Result<OidcAuthorizationRequest, OidcProviderError> {
        let runtime = self
            .validator
            .active_runtime(&self.providers, provider_id)
            .await?;
        let attempt_id = Uuid::now_v7();
        let state = random_protocol_value(STATE_BYTES)?;
        let nonce = random_protocol_value(NONCE_BYTES)?;
        let verifier = random_protocol_value(VERIFIER_BYTES)?;
        let browser_binding = random_protocol_value(STATE_BYTES)?;
        let challenge = URL_SAFE_NO_PAD.encode(Sha256::digest(verifier.as_bytes()));
        let authorization = runtime.authorization_request(&state, &nonce, &challenge)?;
        if authorization.provider_id != provider_id {
            return Err(OidcProviderError::ValidationFailed);
        }
        let state_hash: [u8; 32] = Sha256::digest(state.as_bytes()).into();
        let nonce_hash: [u8; 32] = Sha256::digest(nonce.as_bytes()).into();
        let browser_binding_hash: [u8; 32] = Sha256::digest(browser_binding.as_bytes()).into();
        let fields = attempt_context(
            attempt_id,
            provider_id,
            authorization.config_version,
            authorization.secret_version,
            &authorization.redirect_uri,
        );
        let refs = fields.iter().map(Vec::as_slice).collect::<Vec<_>>();
        let envelope = self
            .integrations
            .seal_ephemeral(ATTEMPT_ENVELOPE_DOMAIN, &refs, verifier.as_bytes())
            .map_err(|_| OidcProviderError::Unavailable)?;
        let mut connection = self
            .integrations
            .pool()
            .acquire()
            .await
            .map_err(|_| OidcProviderError::Unavailable)?;
        let mut tx = connection
            .begin()
            .await
            .map_err(|_| OidcProviderError::Unavailable)?;
        let current: Option<(i64, i64)> = sqlx::query_as(
            "SELECT config_version,secret_version FROM oidc_providers
             WHERE id=$1::uuid AND status='active' FOR SHARE",
        )
        .bind(provider_id.to_string())
        .fetch_optional(&mut *tx)
        .await
        .map_err(|_| OidcProviderError::Unavailable)?;
        let current = current.and_then(|(config, secret)| {
            Some((u64::try_from(config).ok()?, u64::try_from(secret).ok()?))
        });
        if current != Some((authorization.config_version, authorization.secret_version)) {
            return Err(OidcProviderError::Conflict);
        }
        sqlx::query(
            "INSERT INTO oidc_login_attempts
             (id,provider_id,provider_config_version,state_hash,nonce_hash,
              provider_secret_version,browser_binding_hash,pkce_key_version,pkce_nonce,
              pkce_ciphertext,redirect_uri,expires_at)
             VALUES($1::uuid,$2::uuid,$3,$4,$5,$6,$7,$8,$9,$10,$11,
                    transaction_timestamp()+INTERVAL '5 minutes')",
        )
        .bind(attempt_id.to_string())
        .bind(provider_id.to_string())
        .bind(
            i64::try_from(authorization.config_version)
                .map_err(|_| OidcProviderError::Unavailable)?,
        )
        .bind(state_hash.to_vec())
        .bind(nonce_hash.to_vec())
        .bind(
            i64::try_from(authorization.secret_version)
                .map_err(|_| OidcProviderError::Unavailable)?,
        )
        .bind(browser_binding_hash.to_vec())
        .bind(i32::try_from(envelope.key_version).map_err(|_| OidcProviderError::Unavailable)?)
        .bind(envelope.nonce)
        .bind(envelope.ciphertext)
        .bind(&authorization.redirect_uri)
        .execute(&mut *tx)
        .await
        .map_err(|_| OidcProviderError::Unavailable)?;
        tx.commit()
            .await
            .map_err(|_| OidcProviderError::Unavailable)?;
        Ok(OidcAuthorizationRequest {
            url: authorization.url,
            browser_binding,
        })
    }

    pub(crate) async fn callback(
        &self,
        input: OidcCallbackInput<'_>,
    ) -> Result<IssuedSession, OidcProviderError> {
        time::timeout(self.timeout, self.callback_inner(input))
            .await
            .map_err(|_| OidcProviderError::Unavailable)?
    }

    async fn callback_inner(
        &self,
        input: OidcCallbackInput<'_>,
    ) -> Result<IssuedSession, OidcProviderError> {
        validate_callback_input(&input)?;
        let state_hash: [u8; 32] = Sha256::digest(input.state.as_bytes()).into();
        let code_hash: [u8; 32] = Sha256::digest(input.code.as_bytes()).into();
        let attempt = self
            .consume_attempt(
                input.provider_id,
                input.issuer,
                input.browser_binding,
                state_hash,
                code_hash,
            )
            .await?;
        let context = attempt_context(
            attempt.id,
            input.provider_id,
            attempt.config_version,
            attempt.secret_version,
            &attempt.redirect_uri,
        );
        let refs = context.iter().map(Vec::as_slice).collect::<Vec<_>>();
        let verifier = self
            .integrations
            .open_ephemeral(
                ATTEMPT_ENVELOPE_DOMAIN,
                &refs,
                attempt.key_version,
                &attempt.pkce_nonce,
                &attempt.pkce_ciphertext,
            )
            .map_err(|_| OidcProviderError::ValidationFailed)?;
        let runtime = self
            .validator
            .active_runtime_for_generation(
                &self.providers,
                input.provider_id,
                attempt.config_version,
                attempt.secret_version,
            )
            .await?;
        let now = self.database_time().await?;
        let token = runtime
            .exchange_and_validate(input.code, &verifier, &attempt.nonce_hash, now)
            .await?;
        if token.issuer != attempt.issuer {
            return Err(OidcProviderError::ValidationFailed);
        }
        self.commit_login(
            &input,
            &attempt,
            &token.subject,
            token.verified_email.as_deref(),
        )
        .await
    }

    async fn consume_attempt(
        &self,
        provider_id: Uuid,
        response_issuer: &str,
        browser_binding: &str,
        state_hash: [u8; 32],
        code_hash: [u8; 32],
    ) -> Result<LoginAttempt, OidcProviderError> {
        let mut connection = self
            .integrations
            .pool()
            .acquire()
            .await
            .map_err(|_| OidcProviderError::Unavailable)?;
        let mut tx = connection
            .begin()
            .await
            .map_err(|_| OidcProviderError::Unavailable)?;
        let row = sqlx::query(
            "SELECT attempt.id::text,attempt.provider_config_version,attempt.provider_secret_version,
                    attempt.nonce_hash,attempt.browser_binding_hash,
                    attempt.pkce_key_version,attempt.pkce_nonce,attempt.pkce_ciphertext,
                    attempt.redirect_uri,attempt.created_at,provider.issuer
             FROM oidc_login_attempts attempt
             JOIN oidc_providers provider ON provider.id=attempt.provider_id
             WHERE attempt.provider_id=$1::uuid AND attempt.state_hash=$2
               AND attempt.consumed_at IS NULL AND attempt.expires_at>transaction_timestamp()
               AND provider.status='active'
               AND provider.config_version=attempt.provider_config_version
               AND provider.secret_version=attempt.provider_secret_version
             FOR UPDATE OF attempt,provider",
        )
        .bind(provider_id.to_string())
        .bind(state_hash.to_vec())
        .fetch_optional(&mut *tx)
        .await
        .map_err(|_| OidcProviderError::Unavailable)?
        .ok_or(OidcProviderError::ValidationFailed)?;
        let attempt = LoginAttempt::from_row(&row)?;
        let supplied_binding: [u8; 32] = Sha256::digest(browser_binding.as_bytes()).into();
        if attempt.issuer != response_issuer
            || !bool::from(attempt.browser_binding_hash.ct_eq(&supplied_binding))
        {
            return Err(OidcProviderError::ValidationFailed);
        }
        sqlx::query(
            "UPDATE oidc_login_attempts SET consumed_at=transaction_timestamp(),
             authorization_code_hash=$2 WHERE id=$1::uuid AND consumed_at IS NULL",
        )
        .bind(attempt.id.to_string())
        .bind(code_hash.to_vec())
        .execute(&mut *tx)
        .await
        .map_err(|_| OidcProviderError::ValidationFailed)?;
        tx.commit()
            .await
            .map_err(|_| OidcProviderError::Unavailable)?;
        Ok(attempt)
    }

    async fn commit_login(
        &self,
        input: &OidcCallbackInput<'_>,
        attempt: &LoginAttempt,
        subject: &str,
        verified_email: Option<&str>,
    ) -> Result<IssuedSession, OidcProviderError> {
        let mut connection = self
            .integrations
            .pool()
            .acquire()
            .await
            .map_err(|_| OidcProviderError::Unavailable)?;
        let mut tx = connection
            .begin()
            .await
            .map_err(|_| OidcProviderError::Unavailable)?;
        let provider = sqlx::query(
            "SELECT status,config_version,secret_version FROM oidc_providers
             WHERE id=$1::uuid FOR SHARE",
        )
        .bind(input.provider_id.to_string())
        .fetch_optional(&mut *tx)
        .await
        .map_err(|_| OidcProviderError::Unavailable)?
        .ok_or(OidcProviderError::Conflict)?;
        if provider.get::<String, _>("status") != "active"
            || u64::try_from(provider.get::<i64, _>("config_version")).ok()
                != Some(attempt.config_version)
            || u64::try_from(provider.get::<i64, _>("secret_version")).ok()
                != Some(attempt.secret_version)
        {
            return Err(OidcProviderError::Conflict);
        }
        acquire_identity_lock(&mut tx, input.provider_id, subject).await?;
        let subject_hash: [u8; 32] = Sha256::digest(subject.as_bytes()).into();
        let unlinked_after_attempt: bool = sqlx::query_scalar(
            "SELECT EXISTS(
                SELECT 1 FROM oidc_identity_unlink_tombstones
                WHERE provider_id=$1::uuid AND subject_hash=$2
                  AND last_unlinked_at >= $3
             )",
        )
        .bind(input.provider_id.to_string())
        .bind(subject_hash.to_vec())
        .bind(attempt.created_at)
        .fetch_one(&mut *tx)
        .await
        .map_err(|_| OidcProviderError::Unavailable)?;
        if unlinked_after_attempt {
            return Err(OidcProviderError::ValidationFailed);
        }
        let identity = sqlx::query(
            "SELECT identity.id::text,user_row.id::text AS user_id,user_row.display_name
             FROM oidc_identities identity JOIN users user_row ON user_row.id=identity.user_id
             WHERE identity.provider_id=$1::uuid AND identity.subject=$2
               AND user_row.status='active' FOR UPDATE OF identity,user_row",
        )
        .bind(input.provider_id.to_string())
        .bind(subject)
        .fetch_optional(&mut *tx)
        .await
        .map_err(|_| OidcProviderError::Unavailable)?;
        let (identity_id, user_id, display_name) = if let Some(identity) = identity {
            (
                identity.get::<String, _>("id"),
                UserId::from_str(&identity.get::<String, _>("user_id"))
                    .map_err(|_| OidcProviderError::Unavailable)?,
                identity.get::<String, _>("display_name"),
            )
        } else {
            self.resolve_and_link_identity(
                &mut tx,
                input,
                subject,
                verified_email.ok_or(OidcProviderError::ValidationFailed)?,
            )
            .await?
        };
        if let Some(existing) = input.existing_session {
            let authenticated = self
                .sessions
                .authenticate_in_transaction(&mut tx, existing)
                .await
                .map_err(map_session_error)?;
            if authenticated.user_id() != user_id {
                return Err(OidcProviderError::ValidationFailed);
            }
            self.sessions
                .revoke_in_transaction(&mut tx, existing)
                .await
                .map_err(map_session_error)?;
        }
        let issued = self
            .sessions
            .issue_in_transaction(&mut tx, user_id)
            .await
            .map_err(map_session_error)?;
        sqlx::query(
            "UPDATE oidc_identities SET last_authenticated_at=transaction_timestamp()
             WHERE id=$1::uuid",
        )
        .bind(&identity_id)
        .execute(&mut *tx)
        .await
        .map_err(|_| OidcProviderError::Unavailable)?;
        let completed = sqlx::query(
            "UPDATE oidc_login_attempts SET completed_at=transaction_timestamp(),session_id=$2::uuid
             WHERE id=$1::uuid AND consumed_at IS NOT NULL AND completed_at IS NULL",
        )
        .bind(attempt.id.to_string())
        .bind(issued.session().id().to_string())
        .execute(&mut *tx)
        .await
        .map_err(|_| OidcProviderError::Unavailable)?
        .rows_affected();
        if completed != 1 {
            return Err(OidcProviderError::Conflict);
        }
        append_login_audit(
            &mut tx,
            user_id,
            &display_name,
            issued.session().id().to_string(),
            input.provider_id,
            input.correlation_id,
        )
        .await?;
        tx.commit()
            .await
            .map_err(|_| OidcProviderError::Unavailable)?;
        Ok(issued)
    }

    async fn resolve_and_link_identity(
        &self,
        tx: &mut Transaction<'_, Postgres>,
        input: &OidcCallbackInput<'_>,
        subject: &str,
        email: &str,
    ) -> Result<(String, UserId, String), OidcProviderError> {
        let normalized = normalize_verified_email(email)?;
        // Serialize all first-link decisions for this normalized address. The
        // unique provider/subject and user/provider constraints remain the
        // final database fence across different addresses and callbacks.
        sqlx::query("SELECT pg_advisory_xact_lock(hashtextextended($1, 1330200900))")
            .bind(&normalized)
            .execute(&mut **tx)
            .await
            .map_err(|_| OidcProviderError::Unavailable)?;
        let existing = sqlx::query(
            "SELECT id::text,display_name FROM users
             WHERE normalized_email=$1 AND status='active' FOR UPDATE",
        )
        .bind(&normalized)
        .fetch_optional(&mut **tx)
        .await
        .map_err(|_| OidcProviderError::Unavailable)?;
        let invitation = sqlx::query(
            "SELECT id::text FROM activation_invitations
             WHERE normalized_email=$1 AND status='pending'
               AND expires_at>transaction_timestamp() FOR UPDATE",
        )
        .bind(&normalized)
        .fetch_optional(&mut **tx)
        .await
        .map_err(|_| OidcProviderError::Unavailable)?;
        let (user_id, display_name, source, invitation_id) = match (existing, invitation.as_ref()) {
            (Some(account), pending) => {
                if let Some(pending) = pending {
                    accept_invitation(tx, pending.get::<String, _>("id")).await?;
                }
                (
                    UserId::from_str(&account.get::<String, _>("id"))
                        .map_err(|_| OidcProviderError::Unavailable)?,
                    account.get::<String, _>("display_name"),
                    if pending.is_some() {
                        "invitation"
                    } else {
                        "preexisting"
                    },
                    pending.map(|row| row.get::<String, _>("id")),
                )
            }
            (None, Some(pending)) => {
                let user_id = UserId::new();
                let display_name: String = email.chars().take(200).collect();
                sqlx::query(
                    "INSERT INTO users(id,email,normalized_email,display_name,status,is_instance_admin)
                     VALUES($1::uuid,$2,$3,$4,'active',FALSE)",
                )
                .bind(user_id.to_string())
                .bind(email)
                .bind(&normalized)
                .bind(&display_name)
                .execute(&mut **tx)
                .await
                .map_err(map_link_write_error)?;
                accept_invitation(tx, pending.get::<String, _>("id")).await?;
                (
                    user_id,
                    display_name,
                    "invitation",
                    Some(pending.get::<String, _>("id")),
                )
            }
            (None, None) => return Err(OidcProviderError::ValidationFailed),
        };
        if let Some(existing_token) = input.existing_session {
            let existing = self
                .sessions
                .authenticate_in_transaction(tx, existing_token)
                .await
                .map_err(map_session_error)?;
            if existing.user_id() != user_id {
                return Err(OidcProviderError::ValidationFailed);
            }
        }
        let identity_id = Uuid::now_v7();
        sqlx::query(
            "INSERT INTO oidc_identities
             (id,user_id,provider_id,subject,normalized_email_at_link,link_source,
              activation_invitation_id)
             VALUES($1::uuid,$2::uuid,$3::uuid,$4,$5,$6,$7::uuid)",
        )
        .bind(identity_id.to_string())
        .bind(user_id.to_string())
        .bind(input.provider_id.to_string())
        .bind(subject)
        .bind(&normalized)
        .bind(source)
        .bind(invitation_id)
        .execute(&mut **tx)
        .await
        .map_err(map_link_write_error)?;
        append_identity_audit(
            tx,
            user_id,
            &display_name,
            identity_id,
            input.provider_id,
            "auth.oidc_identity_linked",
            input.correlation_id,
        )
        .await?;
        Ok((identity_id.to_string(), user_id, display_name))
    }

    /// Removes the caller's own Provider link. A recent reauthentication and
    /// another usable credential are mandatory; the DB trigger independently
    /// enforces the credential and last-administrator invariants.
    pub(crate) async fn unlink_self(
        &self,
        token: &SessionToken,
        provider_id: Uuid,
        correlation_id: &str,
    ) -> Result<IssuedSession, OidcProviderError> {
        validate_correlation(correlation_id)?;
        time::timeout(self.timeout, async {
            let mut connection = self.integrations.pool().acquire().await.map_err(|_| OidcProviderError::Unavailable)?;
            let mut tx = connection.begin().await.map_err(|_| OidcProviderError::Unavailable)?;
            let session = self.sessions.authenticate_in_transaction(&mut tx, token).await.map_err(map_session_error)?;
            let fields = session.clone().into_fields();
            let now: OffsetDateTime = sqlx::query_scalar("SELECT transaction_timestamp()")
                .fetch_one(&mut *tx).await.map_err(|_| OidcProviderError::Unavailable)?;
            let minutes: i32 = sqlx::query_scalar(
                "SELECT (value #>> '{}')::integer FROM instance_settings
                 WHERE key='security.reauthentication_window_minutes'",
            ).fetch_one(&mut *tx).await.map_err(|_| OidcProviderError::Unavailable)?;
            let recent = fields.last_reauthenticated_at.is_some_and(|value| {
                let value = value.into_datetime();
                (15..=120).contains(&minutes)
                    && value <= now
                    && value >= now - ::time::Duration::minutes(i64::from(minutes))
            });
            if !recent { return Err(OidcProviderError::ReauthenticationRequired); }
            // Acquire the instance-wide usability fence before the identity
            // fence. Provider disable takes the same first lock; this ordering
            // avoids a provider -> identity -> safety deadlock and makes the
            // DELETE statement observe any completed disable transaction.
            sqlx::query("SELECT pg_advisory_xact_lock(1330200900, 0)")
                .execute(&mut *tx).await.map_err(|_| OidcProviderError::Unavailable)?;
            let identity = sqlx::query(
                "SELECT id::text,subject FROM oidc_identities
                 WHERE user_id=$1::uuid AND provider_id=$2::uuid",
            ).bind(session.user_id().to_string()).bind(provider_id.to_string())
             .fetch_optional(&mut *tx).await.map_err(|_| OidcProviderError::Unavailable)?
             .ok_or(OidcProviderError::ValidationFailed)?;
            let subject = identity.get::<String,_>("subject");
            acquire_identity_lock(&mut tx, provider_id, &subject).await?;
            let locked = sqlx::query_scalar::<_, String>(
                "SELECT id::text FROM oidc_identities
                 WHERE id=$1::uuid AND user_id=$2::uuid AND provider_id=$3::uuid AND subject=$4
                 FOR UPDATE",
            ).bind(identity.get::<String,_>("id"))
             .bind(session.user_id().to_string()).bind(provider_id.to_string()).bind(&subject)
             .fetch_optional(&mut *tx).await.map_err(|_| OidcProviderError::Unavailable)?
             .ok_or(OidcProviderError::ValidationFailed)?;
            sqlx::query("DELETE FROM oidc_identities WHERE id=$1::uuid")
                .bind(&locked).execute(&mut *tx).await
                .map_err(map_link_write_error)?;
            let issued = self.sessions.rotate_in_transaction(&mut tx, token, SessionRotationKind::Login)
                .await.map_err(map_session_error)?;
            sqlx::query(
                "UPDATE sessions SET revoked_at=transaction_timestamp(),revocation_reason='oidc_identity_unlinked'
                 WHERE user_id=$1::uuid AND id<>$2::uuid AND revoked_at IS NULL",
            ).bind(session.user_id().to_string()).bind(issued.session().id().to_string())
             .execute(&mut *tx).await.map_err(|_| OidcProviderError::Unavailable)?;
            append_identity_audit(&mut tx, session.user_id(), "OIDC user", Uuid::parse_str(&locked).map_err(|_| OidcProviderError::Unavailable)?, provider_id, "auth.oidc_identity_unlinked", correlation_id).await?;
            tx.commit().await.map_err(|_| OidcProviderError::Unavailable)?;
            Ok(issued)
        }).await.map_err(|_| OidcProviderError::Unavailable)?
    }

    async fn database_time(&self) -> Result<OffsetDateTime, OidcProviderError> {
        sqlx::query_scalar("SELECT transaction_timestamp()")
            .fetch_one(
                &mut *self
                    .integrations
                    .pool()
                    .acquire()
                    .await
                    .map_err(|_| OidcProviderError::Unavailable)?,
            )
            .await
            .map_err(|_| OidcProviderError::Unavailable)
    }
}

struct LoginAttempt {
    id: Uuid,
    config_version: u64,
    secret_version: u64,
    nonce_hash: [u8; 32],
    browser_binding_hash: [u8; 32],
    key_version: u32,
    pkce_nonce: Vec<u8>,
    pkce_ciphertext: Vec<u8>,
    redirect_uri: String,
    created_at: OffsetDateTime,
    issuer: String,
}

impl LoginAttempt {
    fn from_row(row: &sqlx::postgres::PgRow) -> Result<Self, OidcProviderError> {
        Ok(Self {
            id: Uuid::parse_str(&row.get::<String, _>("id"))
                .map_err(|_| OidcProviderError::Unavailable)?,
            config_version: u64::try_from(row.get::<i64, _>("provider_config_version"))
                .map_err(|_| OidcProviderError::Unavailable)?,
            secret_version: u64::try_from(row.get::<i64, _>("provider_secret_version"))
                .map_err(|_| OidcProviderError::Unavailable)?,
            nonce_hash: row
                .get::<Vec<u8>, _>("nonce_hash")
                .try_into()
                .map_err(|_| OidcProviderError::Unavailable)?,
            browser_binding_hash: row
                .get::<Vec<u8>, _>("browser_binding_hash")
                .try_into()
                .map_err(|_| OidcProviderError::Unavailable)?,
            key_version: u32::try_from(row.get::<i32, _>("pkce_key_version"))
                .map_err(|_| OidcProviderError::Unavailable)?,
            pkce_nonce: row.get("pkce_nonce"),
            pkce_ciphertext: row.get("pkce_ciphertext"),
            redirect_uri: row.get("redirect_uri"),
            created_at: row.get("created_at"),
            issuer: row.get("issuer"),
        })
    }
}

fn random_protocol_value(bytes: usize) -> Result<Zeroizing<String>, OidcProviderError> {
    let mut entropy = Zeroizing::new(vec![0_u8; bytes]);
    getrandom::fill(&mut entropy).map_err(|_| OidcProviderError::Unavailable)?;
    Ok(Zeroizing::new(URL_SAFE_NO_PAD.encode(entropy.as_slice())))
}

fn attempt_context(
    id: Uuid,
    provider: Uuid,
    config_version: u64,
    secret_version: u64,
    redirect: &str,
) -> Vec<Vec<u8>> {
    vec![
        id.as_bytes().to_vec(),
        provider.as_bytes().to_vec(),
        config_version.to_be_bytes().to_vec(),
        secret_version.to_be_bytes().to_vec(),
        redirect.as_bytes().to_vec(),
    ]
}

fn validate_callback_input(input: &OidcCallbackInput<'_>) -> Result<(), OidcProviderError> {
    let valid = |value: &str, max: usize| {
        !value.is_empty()
            && value.len() <= max
            && value.trim() == value
            && !value.chars().any(char::is_control)
    };
    if !valid(input.issuer, 2048)
        || !valid(input.state, 128)
        || !valid(input.code, 4096)
        || !valid(input.browser_binding, 128)
        || !valid(input.correlation_id, 128)
    {
        return Err(OidcProviderError::InvalidInput);
    }
    Ok(())
}

fn validate_correlation(value: &str) -> Result<(), OidcProviderError> {
    if value.is_empty()
        || value.len() > 128
        || value.trim() != value
        || value.chars().any(char::is_control)
    {
        return Err(OidcProviderError::InvalidInput);
    }
    Ok(())
}

fn normalize_verified_email(value: &str) -> Result<String, OidcProviderError> {
    NormalizedEmail::from_email(value)
        .map(|email| email.as_str().to_owned())
        .map_err(|_| OidcProviderError::ValidationFailed)
}

async fn acquire_identity_lock(
    tx: &mut Transaction<'_, Postgres>,
    provider_id: Uuid,
    subject: &str,
) -> Result<(), OidcProviderError> {
    // UUID text has a fixed width, so the separator cannot make two
    // (provider, subject) pairs ambiguous. This fence is shared by first-link,
    // login, and unlink so an unlink cannot be silently undone by an in-flight
    // callback using a stale identity observation.
    sqlx::query(
        "SELECT pg_advisory_xact_lock(
             hashtextextended($1 || ':' || $2, 1330200901)
         )",
    )
    .bind(provider_id.to_string())
    .bind(subject)
    .execute(&mut **tx)
    .await
    .map_err(|_| OidcProviderError::Unavailable)?;
    Ok(())
}

async fn accept_invitation(
    tx: &mut Transaction<'_, Postgres>,
    invitation_id: String,
) -> Result<(), OidcProviderError> {
    let changed = sqlx::query(
        "UPDATE activation_invitations
         SET status='accepted',accepted_at=transaction_timestamp()
         WHERE id=$1::uuid AND status='pending' AND expires_at>transaction_timestamp()",
    )
    .bind(invitation_id)
    .execute(&mut **tx)
    .await
    .map_err(|_| OidcProviderError::Unavailable)?
    .rows_affected();
    if changed == 1 {
        Ok(())
    } else {
        Err(OidcProviderError::ValidationFailed)
    }
}

fn map_link_write_error(error: sqlx::Error) -> OidcProviderError {
    if error
        .as_database_error()
        .and_then(|database| database.code())
        .is_some_and(|code| matches!(code.as_ref(), "23505" | "23514" | "P0001"))
    {
        OidcProviderError::ValidationFailed
    } else {
        OidcProviderError::Unavailable
    }
}

async fn append_identity_audit(
    tx: &mut Transaction<'_, Postgres>,
    user_id: UserId,
    display_name: &str,
    identity_id: Uuid,
    provider_id: Uuid,
    action: &str,
    correlation_id: &str,
) -> Result<(), OidcProviderError> {
    let now: OffsetDateTime = sqlx::query_scalar("SELECT transaction_timestamp()")
        .fetch_one(&mut **tx)
        .await
        .map_err(|_| OidcProviderError::Unavailable)?;
    let event = AuditEvent::new(AuditEventFields {
        id: AuditEventId::new(),
        occurred_at: Timestamp::from_datetime(now).map_err(|_| OidcProviderError::Unavailable)?,
        actor: AuditActor {
            kind: ActorType::User,
            id: user_id.to_string(),
            user_id: Some(user_id),
            display_name: Some(display_name.to_owned()),
        },
        action_code: action.into(),
        target: AuditTarget {
            kind: "oidc_identity".into(),
            id: identity_id.to_string(),
        },
        scope: AuditScope {
            kind: ScopeType::User,
            id: user_id.to_string(),
        },
        result: AuditResult::Succeeded,
        reason_code: None,
        correlation_id: correlation_id.into(),
        source_ip: None,
        schema_version: 1,
        changed_fields: vec!["oidc_identity".into()],
        metadata: AuditMetadata::new(json!({"provider_id": provider_id.to_string()}))
            .map_err(|_| OidcProviderError::Unavailable)?,
    })
    .map_err(|_| OidcProviderError::Unavailable)?;
    AuditWriter::append(tx, &event)
        .await
        .map_err(|_| OidcProviderError::Unavailable)
}

async fn append_login_audit(
    tx: &mut sqlx::Transaction<'_, sqlx::Postgres>,
    user_id: UserId,
    display_name: &str,
    session_id: String,
    provider_id: Uuid,
    correlation_id: &str,
) -> Result<(), OidcProviderError> {
    let now: OffsetDateTime = sqlx::query_scalar("SELECT transaction_timestamp()")
        .fetch_one(&mut **tx)
        .await
        .map_err(|_| OidcProviderError::Unavailable)?;
    let event = AuditEvent::new(AuditEventFields {
        id: AuditEventId::new(),
        occurred_at: Timestamp::from_datetime(now).map_err(|_| OidcProviderError::Unavailable)?,
        actor: AuditActor {
            kind: ActorType::User,
            id: user_id.to_string(),
            user_id: Some(user_id),
            display_name: Some(display_name.to_owned()),
        },
        action_code: "auth.oidc_login_succeeded".into(),
        target: AuditTarget {
            kind: "session".into(),
            id: session_id,
        },
        scope: AuditScope {
            kind: ScopeType::User,
            id: user_id.to_string(),
        },
        result: AuditResult::Succeeded,
        reason_code: None,
        correlation_id: correlation_id.into(),
        source_ip: None,
        schema_version: 1,
        changed_fields: vec![],
        metadata: AuditMetadata::new(json!({"provider_id": provider_id.to_string()}))
            .map_err(|_| OidcProviderError::Unavailable)?,
    })
    .map_err(|_| OidcProviderError::Unavailable)?;
    AuditWriter::append(tx, &event)
        .await
        .map_err(|_| OidcProviderError::Unavailable)
}

fn map_session_error(error: SessionServiceError) -> OidcProviderError {
    match error {
        SessionServiceError::InvalidToken | SessionServiceError::UserUnavailable => {
            OidcProviderError::ValidationFailed
        }
        _ => OidcProviderError::Unavailable,
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn callback_values_are_bounded_and_mixup_issuer_is_required() {
        let provider_id = Uuid::now_v7();
        let valid = OidcCallbackInput {
            provider_id,
            issuer: "https://id.example.test",
            state: "bounded-state",
            code: "bounded-code",
            browser_binding: "bounded-browser-binding",
            existing_session: None,
            correlation_id: "request:oidc3-unit",
        };
        assert!(validate_callback_input(&valid).is_ok());
        let invalid = OidcCallbackInput {
            issuer: "",
            ..valid
        };
        assert_eq!(
            validate_callback_input(&invalid).unwrap_err(),
            OidcProviderError::InvalidInput
        );
    }

    #[test]
    fn envelope_context_is_unambiguous_and_authorization_debug_is_redacted() {
        let first = attempt_context(
            Uuid::now_v7(),
            Uuid::now_v7(),
            7,
            3,
            "https://app.example.test/callback",
        );
        let second = attempt_context(
            Uuid::now_v7(),
            Uuid::now_v7(),
            7,
            3,
            "https://app.example.test/callback",
        );
        assert_ne!(first, second);
        let request = OidcAuthorizationRequest {
            url: "https://id.example.test/authorize?state=secret".into(),
            browser_binding: Zeroizing::new("binding-secret".into()),
        };
        let rendered = format!("{request:?}");
        assert!(!rendered.contains("secret"));
        assert!(!rendered.contains("binding-secret"));
    }
}
