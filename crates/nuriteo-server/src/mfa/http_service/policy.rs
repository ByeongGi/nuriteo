#![allow(unused_imports)]
use super::enrollment::*;
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

pub(crate) async fn reconcile_policy(
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

pub(crate) async fn load_policy_view(
    pool: &DatabasePool,
) -> Result<MfaPolicyView, MfaHttpServiceError> {
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

pub(crate) async fn load_policy_impact(
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

pub(crate) fn valid_population_proof(value: &str) -> bool {
    value.len() == 43
        && value
            .bytes()
            .all(|byte| byte.is_ascii_alphanumeric() || matches!(byte, b'_' | b'-'))
}

pub(crate) fn format_time(value: OffsetDateTime) -> Result<String, MfaHttpServiceError> {
    value
        .format(&Rfc3339)
        .map_err(|_| MfaHttpServiceError::Internal)
}

pub(crate) fn map_service_error(error: MfaServiceError) -> MfaHttpServiceError {
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

pub(crate) fn map_http_session_error(
    error: crate::identity::SessionServiceError,
) -> MfaHttpServiceError {
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
