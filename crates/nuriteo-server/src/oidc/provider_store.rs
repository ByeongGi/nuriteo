#![allow(unused_imports)]
use super::provider_model::*;
use super::providers::*;
use super::*;

use std::fmt;

use std::str::FromStr;

use std::time::Duration;

use ::time::OffsetDateTime;

use sqlx::{Acquire, Postgres, Row, Transaction};

use tokio::time;

use uuid::Uuid;

use crate::integration::{
    CaEndpointBinding, CredentialIdentity, IntegrationAdminActor, IntegrationError,
    IntegrationRepository, SecretValue, ValidatedCaBundle, authorize_recent_admin,
};

pub(crate) use http_routes::openapi_router;

pub use http_service::OidcHttpService;

pub(crate) use http_service::{
    OidcIdentityCollectionView, OidcLoginProviderCollectionView, OidcProviderCollectionView,
    OidcProviderView,
};

#[allow(unused_imports, reason = "crate-private OIDC HTTP adapter handoff")]
pub(crate) use login::{OidcAuthorizationRequest, OidcCallbackInput, OidcLoginService};

pub use protocol::OidcEndpointValidator;

use super::{
    ACTIVATION_ATTESTATION_DOMAIN, ActivationAttestationInput, CLIENT_SECRET_KIND, DEFAULT_TIMEOUT,
    INSTANCE_ID, INTEGRATION_TYPE, MAX_TIMEOUT, MIN_TIMEOUT, OidcProviderError, OidcProviderInput,
    OidcProviderMetadata, OidcProviderService, OidcProviderState, OidcProviderUpdate,
    OidcRuntimeProvider, map_integration_error,
};
use protocol::{OidcValidationProof, trust_fingerprint};

pub(crate) fn fixed_digest(
    row: &sqlx::postgres::PgRow,
    column: &str,
) -> Result<[u8; 32], OidcProviderError> {
    row.get::<Vec<u8>, _>(column)
        .try_into()
        .map_err(|_| OidcProviderError::ValidationFailed)
}

pub(crate) async fn lock_integration_ca(
    tx: &mut Transaction<'_, Postgres>,
    id: Uuid,
) -> Result<(), OidcProviderError> {
    sqlx::query("SELECT pg_advisory_xact_lock(1229870147, hashtext($1))")
        .bind(format!("oidc:{id}"))
        .execute(&mut **tx)
        .await
        .map_err(|_| OidcProviderError::Unavailable)?;
    Ok(())
}

pub(crate) async fn assert_current_ca(
    tx: &mut Transaction<'_, Postgres>,
    id: Uuid,
    expected: [u8; 32],
) -> Result<(), OidcProviderError> {
    let issuer: String = sqlx::query_scalar("SELECT issuer FROM oidc_providers WHERE id=$1::uuid")
        .bind(id.to_string())
        .fetch_one(&mut **tx)
        .await
        .map_err(|_| OidcProviderError::Unavailable)?;
    let issuer = url::Url::parse(&issuer).map_err(|_| OidcProviderError::ValidationFailed)?;
    let endpoint = CaEndpointBinding::new(
        INTEGRATION_TYPE,
        id.to_string(),
        issuer
            .host_str()
            .ok_or(OidcProviderError::ValidationFailed)?,
        issuer
            .port_or_known_default()
            .ok_or(OidcProviderError::ValidationFailed)?,
        "https",
    )
    .map_err(|_| OidcProviderError::ValidationFailed)?;
    let rows = sqlx::query(
        "SELECT state,pem,endpoint_fingerprint FROM integration_ca_bundles
         WHERE integration_type='oidc' AND integration_id=$1 ORDER BY version DESC FOR SHARE",
    )
    .bind(id.to_string())
    .fetch_all(&mut **tx)
    .await
    .map_err(|_| OidcProviderError::Unavailable)?;
    let active = rows
        .iter()
        .find(|row| row.get::<String, _>("state") == "active");
    let observed = match active {
        Some(row) => {
            let stored_endpoint: Vec<u8> = row.get("endpoint_fingerprint");
            if stored_endpoint != endpoint.fingerprint() {
                return Err(OidcProviderError::ValidationFailed);
            }
            let pem: Vec<u8> = row.get("pem");
            let bundle =
                ValidatedCaBundle::parse(pem).map_err(|_| OidcProviderError::ValidationFailed)?;
            trust_fingerprint(Some(&bundle))
        }
        None if rows.is_empty() => trust_fingerprint(None),
        None => return Err(OidcProviderError::ValidationFailed),
    };
    if observed != expected {
        return Err(OidcProviderError::Conflict);
    }
    Ok(())
}

pub(crate) async fn lock_expected_version(
    tx: &mut Transaction<'_, Postgres>,
    id: Uuid,
    expected_version: u64,
) -> Result<OidcProviderState, OidcProviderError> {
    let row = sqlx::query(
        "SELECT status,config_version FROM oidc_providers WHERE id=$1::uuid FOR UPDATE",
    )
    .bind(id.to_string())
    .fetch_optional(&mut **tx)
    .await
    .map_err(|_| OidcProviderError::Unavailable)?
    .ok_or(OidcProviderError::NotFound)?;
    let observed: i64 = row.get("config_version");
    if u64::try_from(observed).ok() != Some(expected_version) {
        return Err(OidcProviderError::Conflict);
    }
    OidcProviderState::parse(row.get("status"))
}

pub(crate) async fn load_metadata(
    tx: &mut Transaction<'_, Postgres>,
    id: Uuid,
) -> Result<OidcProviderMetadata, OidcProviderError> {
    let row = sqlx::query(
        "SELECT p.id::text,p.display_name,p.issuer,p.client_id,p.status,p.config_version,
          p.secret_version,p.created_at,p.updated_at,COUNT(i.id)::bigint AS linked_identity_count
         FROM oidc_providers p LEFT JOIN oidc_identities i ON i.provider_id=p.id
         WHERE p.id=$1::uuid GROUP BY p.id",
    )
    .bind(id.to_string())
    .fetch_optional(&mut **tx)
    .await
    .map_err(|_| OidcProviderError::Unavailable)?
    .ok_or(OidcProviderError::NotFound)?;
    Ok(OidcProviderMetadata {
        id: Uuid::from_str(row.get::<String, _>("id").as_str())
            .map_err(|_| OidcProviderError::Unavailable)?,
        display_name: row.get("display_name"),
        issuer: row.get("issuer"),
        client_id: row.get("client_id"),
        state: OidcProviderState::parse(row.get("status"))?,
        config_version: u64::try_from(row.get::<i64, _>("config_version"))
            .map_err(|_| OidcProviderError::Unavailable)?,
        secret_version: u64::try_from(row.get::<i64, _>("secret_version"))
            .map_err(|_| OidcProviderError::Unavailable)?,
        linked_identity_count: u64::try_from(row.get::<i64, _>("linked_identity_count"))
            .map_err(|_| OidcProviderError::Unavailable)?,
        created_at: row.get("created_at"),
        updated_at: row.get("updated_at"),
    })
}

pub(crate) fn credential_identity(id: Uuid) -> Result<CredentialIdentity, OidcProviderError> {
    CredentialIdentity::new(
        INSTANCE_ID,
        INTEGRATION_TYPE,
        id.to_string(),
        CLIENT_SECRET_KIND,
    )
    .map_err(map_integration_error)
}

pub(crate) async fn append_audit(
    tx: &mut Transaction<'_, Postgres>,
    actor: IntegrationAdminActor,
    action: &str,
    id: Uuid,
    version: u64,
    changed_fields: &[&str],
    correlation_id: &str,
) -> Result<(), OidcProviderError> {
    sqlx::query(
        "INSERT INTO audit_events(id,actor_type,actor_id,actor_user_id,action_code,target_type,target_id,
         scope_type,scope_id,result,correlation_id,changed_fields,metadata)
         VALUES($1::uuid,'user',$2,$2::uuid,$3,'oidc_provider',$4,'instance','instance','succeeded',$5,$6,$7::jsonb)",
    ).bind(Uuid::now_v7().to_string()).bind(actor.user_id.to_string()).bind(action).bind(id.to_string())
     .bind(correlation_id).bind(changed_fields.iter().map(|field| (*field).to_owned()).collect::<Vec<_>>())
     .bind(serde_json::json!({"configVersion": version}).to_string())
     .execute(&mut **tx).await.map_err(|_| OidcProviderError::Unavailable)?;
    Ok(())
}

pub(crate) fn valid_text(value: &str, max: usize) -> bool {
    !value.is_empty()
        && value.len() <= max
        && value.trim() == value
        && !value.chars().any(char::is_control)
}

pub(crate) fn validate_correlation(value: &str) -> Result<(), OidcProviderError> {
    if (1..=128).contains(&value.len())
        && value
            .bytes()
            .all(|byte| byte.is_ascii_alphanumeric() || matches!(byte, b'.' | b'_' | b':' | b'-'))
    {
        Ok(())
    } else {
        Err(OidcProviderError::InvalidInput)
    }
}

pub(crate) fn map_database_error(error: sqlx::Error) -> OidcProviderError {
    match error
        .as_database_error()
        .and_then(|database| database.code())
        .as_deref()
    {
        Some("23505") => OidcProviderError::Conflict,
        Some("P0001") => OidcProviderError::ValidationFailed,
        _ => OidcProviderError::Unavailable,
    }
}

impl fmt::Display for OidcProviderError {
    fn fmt(&self, formatter: &mut fmt::Formatter<'_>) -> fmt::Result {
        formatter.write_str(match self {
            Self::AuthenticationFailed => "OIDC authentication failed",
            Self::Forbidden => "OIDC operation is forbidden",
            Self::InvalidInput => "OIDC provider input is invalid",
            Self::ReauthenticationRequired => "recent administrator reauthentication is required",
            Self::NotFound => "OIDC provider was not found",
            Self::Disabled => "OIDC provider is disabled",
            Self::MustDisable => "OIDC provider must be disabled before deletion",
            Self::LinkedIdentities => "OIDC provider still has linked identities",
            Self::Conflict => "OIDC provider state changed concurrently",
            Self::CredentialUnavailable => "OIDC provider credential is unavailable",
            Self::NetworkDenied => "OIDC endpoint network is not permitted",
            Self::ValidationFailed => "OIDC endpoint validation failed",
            Self::Unavailable => "OIDC provider persistence is unavailable",
        })
    }
}

impl std::error::Error for OidcProviderError {}
