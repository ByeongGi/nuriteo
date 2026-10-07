//! Global OIDC provider administration and credential lifecycle.
//!
//! Discovery, JWKS retrieval, endpoint validation and browser protocol flows
//! are intentionally deferred to OIDC-002 and later tasks.

use std::fmt;
use std::str::FromStr;
use std::time::Duration;

use ::time::OffsetDateTime;
use sqlx::{Acquire, Postgres, Row, Transaction};
use tokio::time;
use uuid::Uuid;

use crate::integration::{
    CredentialIdentity, IntegrationAdminActor, IntegrationError, IntegrationRepository,
    SecretValue, authorize_recent_admin,
};

const INSTANCE_ID: &str = "instance";
const INTEGRATION_TYPE: &str = "oidc";
const CLIENT_SECRET_KIND: &str = "client_secret";
const DEFAULT_TIMEOUT: Duration = Duration::from_secs(5);
const MIN_TIMEOUT: Duration = Duration::from_millis(100);
const MAX_TIMEOUT: Duration = Duration::from_secs(30);

#[derive(Debug, Clone, PartialEq, Eq)]
pub struct OidcProviderInput {
    display_name: String,
    issuer: String,
    client_id: String,
}

impl OidcProviderInput {
    pub fn new(
        display_name: impl Into<String>,
        issuer: impl Into<String>,
        client_id: impl Into<String>,
    ) -> Result<Self, OidcProviderError> {
        let value = Self {
            display_name: display_name.into(),
            issuer: issuer.into(),
            client_id: client_id.into(),
        };
        if !valid_text(&value.display_name, 200)
            || !valid_text(&value.issuer, 2048)
            || value.issuer.len() < 8
            || !valid_text(&value.client_id, 1024)
        {
            return Err(OidcProviderError::InvalidInput);
        }
        Ok(value)
    }
}

#[derive(Debug, Clone, PartialEq, Eq)]
pub struct OidcProviderUpdate {
    display_name: String,
    client_id: String,
}

impl OidcProviderUpdate {
    pub fn new(
        display_name: impl Into<String>,
        client_id: impl Into<String>,
    ) -> Result<Self, OidcProviderError> {
        let value = Self {
            display_name: display_name.into(),
            client_id: client_id.into(),
        };
        if !valid_text(&value.display_name, 200) || !valid_text(&value.client_id, 1024) {
            return Err(OidcProviderError::InvalidInput);
        }
        Ok(value)
    }
}

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum OidcProviderState {
    Active,
    Disabled,
}

impl OidcProviderState {
    fn parse(value: &str) -> Result<Self, OidcProviderError> {
        match value {
            "active" => Ok(Self::Active),
            "disabled" => Ok(Self::Disabled),
            _ => Err(OidcProviderError::Unavailable),
        }
    }
}

#[derive(Debug, Clone, PartialEq, Eq)]
pub struct OidcProviderMetadata {
    pub id: Uuid,
    pub display_name: String,
    pub issuer: String,
    pub client_id: String,
    pub state: OidcProviderState,
    pub config_version: u64,
    pub secret_version: u64,
    pub linked_identity_count: u64,
    pub created_at: OffsetDateTime,
    pub updated_at: OffsetDateTime,
}

#[derive(Clone)]
#[allow(dead_code, reason = "crate-private OIDC-002 protocol adapter handoff")]
pub(crate) struct OidcRuntimeProvider {
    pub(crate) metadata: OidcProviderMetadata,
    pub(crate) client_secret: SecretValue,
}

impl fmt::Debug for OidcRuntimeProvider {
    fn fmt(&self, formatter: &mut fmt::Formatter<'_>) -> fmt::Result {
        formatter
            .debug_struct("OidcRuntimeProvider")
            .field("metadata", &self.metadata)
            .field("client_secret", &"[REDACTED]")
            .finish()
    }
}

#[derive(Clone)]
pub struct OidcProviderService {
    integrations: IntegrationRepository,
    timeout: Duration,
}

impl fmt::Debug for OidcProviderService {
    fn fmt(&self, formatter: &mut fmt::Formatter<'_>) -> fmt::Result {
        formatter
            .debug_struct("OidcProviderService")
            .field("timeout", &self.timeout)
            .finish_non_exhaustive()
    }
}

impl OidcProviderService {
    #[must_use]
    pub const fn new(integrations: IntegrationRepository) -> Self {
        Self {
            integrations,
            timeout: DEFAULT_TIMEOUT,
        }
    }

    pub fn with_timeout(mut self, timeout: Duration) -> Result<Self, OidcProviderError> {
        if !(MIN_TIMEOUT..=MAX_TIMEOUT).contains(&timeout) {
            return Err(OidcProviderError::InvalidInput);
        }
        self.timeout = timeout;
        Ok(self)
    }

    pub async fn create_provider(
        &self,
        actor: IntegrationAdminActor,
        input: &OidcProviderInput,
        client_secret: &SecretValue,
        correlation_id: &str,
    ) -> Result<OidcProviderMetadata, OidcProviderError> {
        self.bounded(self.create_provider_inner(actor, input, client_secret, correlation_id))
            .await
    }

    async fn create_provider_inner(
        &self,
        actor: IntegrationAdminActor,
        input: &OidcProviderInput,
        client_secret: &SecretValue,
        correlation_id: &str,
    ) -> Result<OidcProviderMetadata, OidcProviderError> {
        validate_correlation(correlation_id)?;
        let id = Uuid::now_v7();
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
        authorize_recent_admin(&mut tx, actor)
            .await
            .map_err(map_integration_error)?;
        sqlx::query(
            "INSERT INTO oidc_providers
             (id,display_name,issuer,status,disabled_at,client_id,config_version,secret_version)
             VALUES($1::uuid,$2,$3,'disabled',CURRENT_TIMESTAMP,$4,1,0)",
        )
        .bind(id.to_string())
        .bind(&input.display_name)
        .bind(&input.issuer)
        .bind(&input.client_id)
        .execute(&mut *tx)
        .await
        .map_err(map_database_error)?;
        let identity = credential_identity(id)?;
        let credential = self
            .integrations
            .upsert_credential_in_transaction(&mut tx, &identity, client_secret)
            .await
            .map_err(map_integration_error)?;
        sqlx::query(
            "UPDATE oidc_providers SET config_version=2,
              secret_version=$2,client_secret_credential_id=$3::uuid,
              updated_at=CURRENT_TIMESTAMP WHERE id=$1::uuid",
        )
        .bind(id.to_string())
        .bind(
            i64::try_from(credential.credential_version)
                .map_err(|_| OidcProviderError::Unavailable)?,
        )
        .bind(credential.id.to_string())
        .execute(&mut *tx)
        .await
        .map_err(map_database_error)?;
        append_audit(
            &mut tx,
            actor,
            "oidc.provider_created",
            id,
            2,
            &["provider", "client_secret"],
            correlation_id,
        )
        .await?;
        let metadata = load_metadata(&mut tx, id).await?;
        tx.commit()
            .await
            .map_err(|_| OidcProviderError::Unavailable)?;
        Ok(metadata)
    }

    pub async fn update_provider(
        &self,
        actor: IntegrationAdminActor,
        id: Uuid,
        expected_version: u64,
        update: &OidcProviderUpdate,
        correlation_id: &str,
    ) -> Result<OidcProviderMetadata, OidcProviderError> {
        self.bounded(async {
            validate_correlation(correlation_id)?;
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
            authorize_recent_admin(&mut tx, actor)
                .await
                .map_err(map_integration_error)?;
            let state = lock_expected_version(&mut tx, id, expected_version).await?;
            if state != OidcProviderState::Disabled {
                return Err(OidcProviderError::MustDisable);
            }
            let affected = sqlx::query(
                "UPDATE oidc_providers SET display_name=$2,client_id=$3,
                  config_version=config_version+1,updated_at=CURRENT_TIMESTAMP WHERE id=$1::uuid",
            )
            .bind(id.to_string())
            .bind(&update.display_name)
            .bind(&update.client_id)
            .execute(&mut *tx)
            .await
            .map_err(map_database_error)?
            .rows_affected();
            if affected != 1 {
                return Err(OidcProviderError::NotFound);
            }
            append_audit(
                &mut tx,
                actor,
                "oidc.provider_updated",
                id,
                expected_version + 1,
                &["display_name", "client_id"],
                correlation_id,
            )
            .await?;
            let metadata = load_metadata(&mut tx, id).await?;
            tx.commit()
                .await
                .map_err(|_| OidcProviderError::Unavailable)?;
            Ok(metadata)
        })
        .await
    }

    pub async fn disable_provider(
        &self,
        actor: IntegrationAdminActor,
        id: Uuid,
        expected_version: u64,
        correlation_id: &str,
    ) -> Result<OidcProviderMetadata, OidcProviderError> {
        self.bounded(async {
            validate_correlation(correlation_id)?;
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
            authorize_recent_admin(&mut tx, actor)
                .await
                .map_err(map_integration_error)?;
            let current = lock_expected_version(&mut tx, id, expected_version).await?;
            if current == OidcProviderState::Disabled {
                return Err(OidcProviderError::Conflict);
            }
            sqlx::query(
                "UPDATE oidc_providers SET status='disabled',disabled_at=CURRENT_TIMESTAMP,
                  config_version=config_version+1,
                  updated_at=CURRENT_TIMESTAMP WHERE id=$1::uuid",
            )
            .bind(id.to_string())
            .execute(&mut *tx)
            .await
            .map_err(map_database_error)?;
            append_audit(
                &mut tx,
                actor,
                "oidc.provider_disabled",
                id,
                expected_version + 1,
                &["status"],
                correlation_id,
            )
            .await?;
            let metadata = load_metadata(&mut tx, id).await?;
            tx.commit()
                .await
                .map_err(|_| OidcProviderError::Unavailable)?;
            Ok(metadata)
        })
        .await
    }

    pub async fn rotate_client_secret(
        &self,
        actor: IntegrationAdminActor,
        id: Uuid,
        expected_version: u64,
        client_secret: &SecretValue,
        correlation_id: &str,
    ) -> Result<OidcProviderMetadata, OidcProviderError> {
        self.bounded(async {
            validate_correlation(correlation_id)?;
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
            authorize_recent_admin(&mut tx, actor)
                .await
                .map_err(map_integration_error)?;
            lock_expected_version(&mut tx, id, expected_version).await?;
            let identity = credential_identity(id)?;
            let credential = self
                .integrations
                .upsert_credential_in_transaction(&mut tx, &identity, client_secret)
                .await
                .map_err(map_integration_error)?;
            let affected = sqlx::query(
                "UPDATE oidc_providers SET secret_version=$2,config_version=config_version+1,
                  updated_at=CURRENT_TIMESTAMP WHERE id=$1::uuid",
            )
            .bind(id.to_string())
            .bind(
                i64::try_from(credential.credential_version)
                    .map_err(|_| OidcProviderError::Unavailable)?,
            )
            .execute(&mut *tx)
            .await
            .map_err(map_database_error)?
            .rows_affected();
            if affected != 1 {
                return Err(OidcProviderError::NotFound);
            }
            append_audit(
                &mut tx,
                actor,
                "oidc.provider_secret_rotated",
                id,
                expected_version + 1,
                &["client_secret"],
                correlation_id,
            )
            .await?;
            let metadata = load_metadata(&mut tx, id).await?;
            tx.commit()
                .await
                .map_err(|_| OidcProviderError::Unavailable)?;
            Ok(metadata)
        })
        .await
    }

    pub async fn delete_provider(
        &self,
        actor: IntegrationAdminActor,
        id: Uuid,
        expected_version: u64,
        correlation_id: &str,
    ) -> Result<(), OidcProviderError> {
        self.bounded(async {
            validate_correlation(correlation_id)?;
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
            authorize_recent_admin(&mut tx, actor)
                .await
                .map_err(map_integration_error)?;
            let state = lock_expected_version(&mut tx, id, expected_version).await?;
            if state != OidcProviderState::Disabled {
                return Err(OidcProviderError::MustDisable);
            }
            let linked: bool = sqlx::query_scalar(
                "SELECT EXISTS(SELECT 1 FROM oidc_identities WHERE provider_id=$1::uuid)",
            )
            .bind(id.to_string())
            .fetch_one(&mut *tx)
            .await
            .map_err(|_| OidcProviderError::Unavailable)?;
            if linked {
                return Err(OidcProviderError::LinkedIdentities);
            }
            sqlx::query("DELETE FROM oidc_providers WHERE id=$1::uuid")
                .bind(id.to_string())
                .execute(&mut *tx)
                .await
                .map_err(map_database_error)?;
            append_audit(
                &mut tx,
                actor,
                "oidc.provider_deleted",
                id,
                expected_version,
                &["provider"],
                correlation_id,
            )
            .await?;
            tx.commit()
                .await
                .map_err(|_| OidcProviderError::Unavailable)?;
            Ok(())
        })
        .await
    }

    /// OIDC-002-only handoff. It must expose this resolver only behind its typed
    /// discovery/JWKS/CA/SSRF validation proof and never to a general admin API.
    #[allow(dead_code, reason = "crate-private OIDC-002 protocol adapter handoff")]
    pub(crate) async fn active_provider(
        &self,
        id: Uuid,
    ) -> Result<OidcRuntimeProvider, OidcProviderError> {
        self.bounded(async {
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
            sqlx::query("SET TRANSACTION ISOLATION LEVEL REPEATABLE READ READ ONLY")
                .execute(&mut *tx)
                .await
                .map_err(|_| OidcProviderError::Unavailable)?;
            let metadata = load_metadata(&mut tx, id).await?;
            if metadata.state != OidcProviderState::Active {
                return Err(OidcProviderError::Disabled);
            }
            let credential_id: String = sqlx::query_scalar(
                "SELECT client_secret_credential_id::text FROM oidc_providers WHERE id=$1::uuid",
            )
            .bind(id.to_string())
            .fetch_one(&mut *tx)
            .await
            .map_err(|_| OidcProviderError::CredentialUnavailable)?;
            let credential_id = Uuid::from_str(&credential_id)
                .map_err(|_| OidcProviderError::CredentialUnavailable)?;
            let (identity, credential_version, client_secret) = self
                .integrations
                .read_credential_by_id_in_transaction(&mut tx, credential_id)
                .await
                .map_err(map_integration_error)?;
            if identity.integration_type != INTEGRATION_TYPE
                || identity.integration_id != id.to_string()
                || identity.credential_kind != CLIENT_SECRET_KIND
                || credential_version != metadata.secret_version
            {
                return Err(OidcProviderError::CredentialUnavailable);
            }
            tx.commit()
                .await
                .map_err(|_| OidcProviderError::Unavailable)?;
            Ok(OidcRuntimeProvider {
                metadata,
                client_secret,
            })
        })
        .await
    }

    async fn bounded<T>(
        &self,
        future: impl Future<Output = Result<T, OidcProviderError>>,
    ) -> Result<T, OidcProviderError> {
        time::timeout(self.timeout, future)
            .await
            .map_err(|_| OidcProviderError::Unavailable)?
    }
}

async fn lock_expected_version(
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

async fn load_metadata(
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

fn credential_identity(id: Uuid) -> Result<CredentialIdentity, OidcProviderError> {
    CredentialIdentity::new(
        INSTANCE_ID,
        INTEGRATION_TYPE,
        id.to_string(),
        CLIENT_SECRET_KIND,
    )
    .map_err(map_integration_error)
}

async fn append_audit(
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

fn valid_text(value: &str, max: usize) -> bool {
    !value.is_empty()
        && value.len() <= max
        && value.trim() == value
        && !value.chars().any(char::is_control)
}

fn validate_correlation(value: &str) -> Result<(), OidcProviderError> {
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

fn map_database_error(error: sqlx::Error) -> OidcProviderError {
    if error
        .as_database_error()
        .and_then(|database| database.code())
        .as_deref()
        == Some("23505")
    {
        OidcProviderError::Conflict
    } else {
        OidcProviderError::Unavailable
    }
}

const fn map_integration_error(error: IntegrationError) -> OidcProviderError {
    match error {
        IntegrationError::InvalidInput => OidcProviderError::InvalidInput,
        IntegrationError::ReauthenticationRequired => OidcProviderError::ReauthenticationRequired,
        IntegrationError::Conflict => OidcProviderError::Conflict,
        IntegrationError::CredentialUnavailable | IntegrationError::KeyConfiguration => {
            OidcProviderError::CredentialUnavailable
        }
        IntegrationError::InvalidCaBundle
        | IntegrationError::PreflightFailed
        | IntegrationError::Unavailable => OidcProviderError::Unavailable,
    }
}

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum OidcProviderError {
    InvalidInput,
    ReauthenticationRequired,
    NotFound,
    Disabled,
    MustDisable,
    LinkedIdentities,
    Conflict,
    CredentialUnavailable,
    Unavailable,
}

impl fmt::Display for OidcProviderError {
    fn fmt(&self, formatter: &mut fmt::Formatter<'_>) -> fmt::Result {
        formatter.write_str(match self {
            Self::InvalidInput => "OIDC provider input is invalid",
            Self::ReauthenticationRequired => "recent administrator reauthentication is required",
            Self::NotFound => "OIDC provider was not found",
            Self::Disabled => "OIDC provider is disabled",
            Self::MustDisable => "OIDC provider must be disabled before deletion",
            Self::LinkedIdentities => "OIDC provider still has linked identities",
            Self::Conflict => "OIDC provider state changed concurrently",
            Self::CredentialUnavailable => "OIDC provider credential is unavailable",
            Self::Unavailable => "OIDC provider persistence is unavailable",
        })
    }
}

impl std::error::Error for OidcProviderError {}

#[cfg(test)]
mod tests;
