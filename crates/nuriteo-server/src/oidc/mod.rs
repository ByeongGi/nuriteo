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
    CaEndpointBinding, CredentialIdentity, IntegrationAdminActor, IntegrationError,
    IntegrationRepository, SecretValue, ValidatedCaBundle, authorize_recent_admin,
};

mod http_routes;
mod http_service;
mod login;
mod protocol;
pub(crate) use http_routes::openapi_router;
pub use http_service::OidcHttpService;
pub(crate) use http_service::{
    OidcIdentityCollectionView, OidcLoginProviderCollectionView, OidcProviderCollectionView,
    OidcProviderView,
};
#[allow(unused_imports, reason = "crate-private OIDC HTTP adapter handoff")]
pub(crate) use login::{OidcAuthorizationRequest, OidcCallbackInput, OidcLoginService};
pub use protocol::OidcEndpointValidator;
use protocol::{OidcValidationProof, trust_fingerprint};

const INSTANCE_ID: &str = "instance";
const INTEGRATION_TYPE: &str = "oidc";
const CLIENT_SECRET_KIND: &str = "client_secret";
const ACTIVATION_ATTESTATION_DOMAIN: &[u8] = b"nuriteo.oidc.activation-attestation.v1";
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
    pub(crate) authorization_endpoint: String,
    pub(crate) token_endpoint: String,
    pub(crate) jwks_uri: String,
    pub(crate) redirect_uri: String,
    pub(crate) ca: Option<ValidatedCaBundle>,
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

    pub async fn list_providers(&self) -> Result<Vec<OidcProviderMetadata>, OidcProviderError> {
        self.bounded(async {
            let mut connection = self
                .integrations
                .pool()
                .acquire()
                .await
                .map_err(|_| OidcProviderError::Unavailable)?;
            let mut transaction = connection
                .begin()
                .await
                .map_err(|_| OidcProviderError::Unavailable)?;
            let ids: Vec<String> = sqlx::query_scalar(
                "SELECT id::text FROM oidc_providers ORDER BY lower(display_name), id LIMIT 100",
            )
            .fetch_all(&mut *transaction)
            .await
            .map_err(|_| OidcProviderError::Unavailable)?;
            let mut providers = Vec::with_capacity(ids.len());
            for id in ids {
                providers.push(
                    load_metadata(
                        &mut transaction,
                        Uuid::from_str(&id).map_err(|_| OidcProviderError::Unavailable)?,
                    )
                    .await?,
                );
            }
            transaction
                .commit()
                .await
                .map_err(|_| OidcProviderError::Unavailable)?;
            Ok(providers)
        })
        .await
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
            // Shares the database unlink trigger's instance-wide safety fence:
            // disabling a provider cannot race an unlink decision that counted
            // this provider as another usable administrator credential.
            sqlx::query("SELECT pg_advisory_xact_lock(1330200900, 0)")
                .execute(&mut *tx)
                .await
                .map_err(|_| OidcProviderError::Unavailable)?;
            let current = lock_expected_version(&mut tx, id, expected_version).await?;
            if current == OidcProviderState::Disabled {
                return Err(OidcProviderError::Conflict);
            }
            let administrator_survives: bool = sqlx::query_scalar(
                "SELECT EXISTS(
                    SELECT 1 FROM users administrator
                    WHERE administrator.status='active' AND administrator.is_instance_admin
                      AND (
                        EXISTS(SELECT 1 FROM local_password_credentials local
                               WHERE local.user_id=administrator.id)
                        OR EXISTS(
                            SELECT 1 FROM oidc_identities identity
                            JOIN oidc_providers provider ON provider.id=identity.provider_id
                            WHERE identity.user_id=administrator.id
                              AND provider.status='active' AND provider.id<>$1::uuid
                        )
                      )
                 )",
            )
            .bind(id.to_string())
            .fetch_one(&mut *tx)
            .await
            .map_err(|_| OidcProviderError::Unavailable)?;
            if !administrator_survives {
                return Err(OidcProviderError::ValidationFailed);
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
            let state = lock_expected_version(&mut tx, id, expected_version).await?;
            if state != OidcProviderState::Disabled {
                return Err(OidcProviderError::MustDisable);
            }
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
                "SELECT EXISTS(SELECT 1 FROM oidc_identities WHERE provider_id=$1::uuid)
                     OR EXISTS(SELECT 1 FROM oidc_identity_unlink_tombstones WHERE provider_id=$1::uuid)",
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

    pub async fn validate_and_activate(
        &self,
        validator: &OidcEndpointValidator,
        actor: IntegrationAdminActor,
        id: Uuid,
        expected_version: u64,
        redirect_uri: &str,
        correlation_id: &str,
    ) -> Result<OidcProviderMetadata, OidcProviderError> {
        validator
            .validate_and_activate(
                self,
                actor,
                id,
                expected_version,
                redirect_uri,
                correlation_id,
            )
            .await
    }

    async fn precheck_validation_actor(
        &self,
        actor: IntegrationAdminActor,
        id: Uuid,
        expected_version: u64,
    ) -> Result<OidcProviderMetadata, OidcProviderError> {
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
            authorize_recent_admin(&mut tx, actor)
                .await
                .map_err(map_integration_error)?;
            let metadata = load_metadata(&mut tx, id).await?;
            if metadata.state != OidcProviderState::Disabled {
                return Err(OidcProviderError::Conflict);
            }
            if metadata.config_version != expected_version {
                return Err(OidcProviderError::Conflict);
            }
            tx.commit()
                .await
                .map_err(|_| OidcProviderError::Unavailable)?;
            Ok(metadata)
        })
        .await
    }

    async fn verify_candidate_secret(
        &self,
        id: Uuid,
        expected_version: u64,
        expected_secret_version: u64,
    ) -> Result<(), OidcProviderError> {
        self.bounded(async {
            let mut connection = self.integrations.pool().acquire().await.map_err(|_| OidcProviderError::Unavailable)?;
            let mut tx = connection.begin().await.map_err(|_| OidcProviderError::Unavailable)?;
            sqlx::query("SET TRANSACTION ISOLATION LEVEL REPEATABLE READ READ ONLY")
                .execute(&mut *tx).await.map_err(|_| OidcProviderError::Unavailable)?;
            let row = sqlx::query("SELECT config_version,secret_version,client_secret_credential_id::text FROM oidc_providers WHERE id=$1::uuid AND status='disabled'")
                .bind(id.to_string()).fetch_optional(&mut *tx).await.map_err(|_| OidcProviderError::Unavailable)?
                .ok_or(OidcProviderError::NotFound)?;
            if u64::try_from(row.get::<i64,_>("config_version")).ok() != Some(expected_version)
                || u64::try_from(row.get::<i64,_>("secret_version")).ok() != Some(expected_secret_version) {
                return Err(OidcProviderError::Conflict);
            }
            let credential_id = Uuid::from_str(&row.get::<String,_>("client_secret_credential_id"))
                .map_err(|_| OidcProviderError::CredentialUnavailable)?;
            let (identity, version, secret) = self.integrations.read_credential_by_id_in_transaction(&mut tx, credential_id)
                .await.map_err(map_integration_error)?;
            if identity.integration_type != INTEGRATION_TYPE || identity.integration_id != id.to_string()
                || identity.credential_kind != CLIENT_SECRET_KIND || version != expected_secret_version {
                return Err(OidcProviderError::CredentialUnavailable);
            }
            drop(secret);
            tx.commit().await.map_err(|_| OidcProviderError::Unavailable)?;
            Ok(())
        }).await
    }

    async fn activate_validated(
        &self,
        actor: IntegrationAdminActor,
        id: Uuid,
        expected_version: u64,
        proof: &OidcValidationProof,
        correlation_id: &str,
    ) -> Result<OidcProviderMetadata, OidcProviderError> {
        self.bounded(async {
            validate_correlation(correlation_id)?;
            if proof.config_version != expected_version {
                return Err(OidcProviderError::Conflict);
            }
            let mut connection = self.integrations.pool().acquire().await.map_err(|_| OidcProviderError::Unavailable)?;
            let mut tx = connection.begin().await.map_err(|_| OidcProviderError::Unavailable)?;
            authorize_recent_admin(&mut tx, actor).await.map_err(map_integration_error)?;
            lock_integration_ca(&mut tx, id).await?;
            let state = lock_expected_version(&mut tx, id, expected_version).await?;
            if state != OidcProviderState::Disabled {
                return Err(OidcProviderError::Conflict);
            }
            let secret_version: i64 = sqlx::query_scalar("SELECT secret_version FROM oidc_providers WHERE id=$1::uuid")
                .bind(id.to_string()).fetch_one(&mut *tx).await.map_err(|_| OidcProviderError::Unavailable)?;
            if u64::try_from(secret_version).ok() != Some(proof.secret_version) {
                return Err(OidcProviderError::Conflict);
            }
            assert_current_ca(&mut tx, id, proof.ca_fingerprint).await?;
            let current = load_metadata(&mut tx, id).await?;
            let created_at: OffsetDateTime = sqlx::query_scalar("SELECT transaction_timestamp()")
                .fetch_one(&mut *tx)
                .await
                .map_err(|_| OidcProviderError::Unavailable)?;
            let expires_at = created_at + ::time::Duration::minutes(5);
            let fields = activation_attestation_fields(&ActivationAttestationInput {
                provider_id: id,
                proof_id: proof.id,
                config_version: proof.config_version,
                secret_version: proof.secret_version,
                issuer: &current.issuer,
                client_id: &current.client_id,
                proof,
                expires_at,
            });
            let field_refs = fields.iter().map(Vec::as_slice).collect::<Vec<_>>();
            let (attestation_key_version, activation_attestation) = self
                .integrations
                .attest_scoped(ACTIVATION_ATTESTATION_DOMAIN, &field_refs)
                .map_err(map_integration_error)?;
            sqlx::query(
                "INSERT INTO oidc_validation_proofs
                 (id,provider_id,config_version,secret_version,authorization_endpoint,
                  token_endpoint,jwks_uri,redirect_uri,validation_fingerprint,
                  validation_ca_fingerprint,jwks_fingerprint,expires_at,
                  attestation_key_version,activation_attestation)
                 VALUES($1::uuid,$2::uuid,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,$14)",
            )
            .bind(proof.id.to_string())
            .bind(id.to_string())
            .bind(i64::try_from(proof.config_version).map_err(|_| OidcProviderError::Unavailable)?)
            .bind(i64::try_from(proof.secret_version).map_err(|_| OidcProviderError::Unavailable)?)
            .bind(&proof.authorization_endpoint)
            .bind(&proof.token_endpoint)
            .bind(&proof.jwks_uri)
            .bind(&proof.redirect_uri)
            .bind(proof.validation_fingerprint.to_vec())
            .bind(proof.ca_fingerprint.to_vec())
            .bind(proof.jwks_fingerprint.to_vec())
            .bind(expires_at)
            .bind(i32::try_from(attestation_key_version).map_err(|_| OidcProviderError::Unavailable)?)
            .bind(activation_attestation.to_vec())
            .execute(&mut *tx)
            .await
            .map_err(map_database_error)?;
            sqlx::query("UPDATE oidc_providers SET status='active',disabled_at=NULL,config_version=config_version+1,
                 authorization_endpoint=$2,token_endpoint=$3,jwks_uri=$4,redirect_uri=$5,
                 validation_config_version=$6,validation_secret_version=$7,validation_fingerprint=$8,
                 jwks_fingerprint=$9,validation_ca_fingerprint=$10,validation_proof_id=$11::uuid,
                 validated_at=CURRENT_TIMESTAMP,
                 updated_at=CURRENT_TIMESTAMP WHERE id=$1::uuid")
                .bind(id.to_string()).bind(&proof.authorization_endpoint).bind(&proof.token_endpoint)
                .bind(&proof.jwks_uri).bind(&proof.redirect_uri)
                .bind(i64::try_from(proof.config_version).map_err(|_| OidcProviderError::Unavailable)?)
                .bind(i64::try_from(proof.secret_version).map_err(|_| OidcProviderError::Unavailable)?)
                .bind(proof.validation_fingerprint.to_vec()).bind(proof.jwks_fingerprint.to_vec())
                .bind(proof.ca_fingerprint.to_vec())
                .bind(proof.id.to_string())
                .execute(&mut *tx).await.map_err(map_database_error)?;
            append_audit(&mut tx, actor, "oidc.provider_activated", id, expected_version + 1,
                &["status", "validated_endpoints", "redirect_uri"], correlation_id).await?;
            let metadata = load_metadata(&mut tx, id).await?;
            tx.commit().await.map_err(|_| OidcProviderError::Unavailable)?;
            Ok(metadata)
        }).await
    }

    /// OIDC-002-only handoff. It must expose this resolver only behind its typed
    /// discovery/JWKS/CA/SSRF validation proof and never to a general admin API.
    #[allow(dead_code, reason = "crate-private OIDC-002 protocol adapter handoff")]
    async fn active_provider(
        &self,
        _: &protocol::RuntimeAccess,
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
            let row = sqlx::query(
                "SELECT provider.client_secret_credential_id::text,provider.validation_ca_fingerprint,
                        provider.authorization_endpoint,provider.token_endpoint,provider.jwks_uri,
                        provider.redirect_uri,provider.validation_proof_id::text,
                        provider.validation_fingerprint,provider.jwks_fingerprint,
                        proof.config_version AS proof_config_version,
                        proof.secret_version AS proof_secret_version,
                        proof.expires_at AS proof_expires_at,
                        proof.attestation_key_version,proof.activation_attestation,
                        proof.used_at AS proof_used_at
                 FROM oidc_providers provider
                 JOIN oidc_validation_proofs proof ON proof.id=provider.validation_proof_id
                 WHERE provider.id=$1::uuid",
            )
            .bind(id.to_string())
            .fetch_one(&mut *tx)
            .await
            .map_err(|_| OidcProviderError::CredentialUnavailable)?;
            let credential_id =
                Uuid::from_str(&row.get::<String, _>("client_secret_credential_id"))
                    .map_err(|_| OidcProviderError::CredentialUnavailable)?;
            let issuer = url::Url::parse(&metadata.issuer)
                .map_err(|_| OidcProviderError::ValidationFailed)?;
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
            let ca = self
                .integrations
                .active_ca_for_endpoint(&endpoint)
                .await
                .map_err(|_| OidcProviderError::ValidationFailed)?;
            let stored_ca: Vec<u8> = row.get("validation_ca_fingerprint");
            if stored_ca != trust_fingerprint(ca.as_ref()) {
                return Err(OidcProviderError::ValidationFailed);
            }
            let proof_id = Uuid::from_str(&row.get::<String, _>("validation_proof_id"))
                .map_err(|_| OidcProviderError::ValidationFailed)?;
            let proof_config_version = u64::try_from(row.get::<i64, _>("proof_config_version"))
                .map_err(|_| OidcProviderError::ValidationFailed)?;
            let proof_secret_version = u64::try_from(row.get::<i64, _>("proof_secret_version"))
                .map_err(|_| OidcProviderError::ValidationFailed)?;
            if proof_config_version.checked_add(1) != Some(metadata.config_version)
                || proof_secret_version != metadata.secret_version
                || row.get::<Option<OffsetDateTime>, _>("proof_used_at").is_none()
            {
                return Err(OidcProviderError::ValidationFailed);
            }
            let proof = OidcValidationProof {
                id: proof_id,
                config_version: proof_config_version,
                secret_version: proof_secret_version,
                authorization_endpoint: row.get("authorization_endpoint"),
                token_endpoint: row.get("token_endpoint"),
                jwks_uri: row.get("jwks_uri"),
                redirect_uri: row.get("redirect_uri"),
                validation_fingerprint: fixed_digest(&row, "validation_fingerprint")?,
                jwks_fingerprint: fixed_digest(&row, "jwks_fingerprint")?,
                ca_fingerprint: fixed_digest(&row, "validation_ca_fingerprint")?,
            };
            let fields = activation_attestation_fields(&ActivationAttestationInput {
                provider_id: id,
                proof_id,
                config_version: proof_config_version,
                secret_version: proof_secret_version,
                issuer: &metadata.issuer,
                client_id: &metadata.client_id,
                proof: &proof,
                expires_at: row.get("proof_expires_at"),
            });
            let field_refs = fields.iter().map(Vec::as_slice).collect::<Vec<_>>();
            let key_version = u32::try_from(row.get::<i32, _>("attestation_key_version"))
                .map_err(|_| OidcProviderError::ValidationFailed)?;
            self.integrations
                .verify_scoped_attestation(
                    ACTIVATION_ATTESTATION_DOMAIN,
                    &field_refs,
                    key_version,
                    &row.get::<Vec<u8>, _>("activation_attestation"),
                )
                .map_err(|_| OidcProviderError::ValidationFailed)?;
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
                authorization_endpoint: proof.authorization_endpoint,
                token_endpoint: proof.token_endpoint,
                jwks_uri: proof.jwks_uri,
                redirect_uri: proof.redirect_uri,
                ca,
            })
        })
        .await
    }

    #[cfg(test)]
    async fn active_provider_for_test(
        &self,
        id: Uuid,
    ) -> Result<OidcRuntimeProvider, OidcProviderError> {
        self.active_provider(protocol::runtime_access_for_test(), id)
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

struct ActivationAttestationInput<'a> {
    provider_id: Uuid,
    proof_id: Uuid,
    config_version: u64,
    secret_version: u64,
    issuer: &'a str,
    client_id: &'a str,
    proof: &'a OidcValidationProof,
    expires_at: OffsetDateTime,
}

fn activation_attestation_fields(input: &ActivationAttestationInput<'_>) -> Vec<Vec<u8>> {
    vec![
        input.provider_id.as_bytes().to_vec(),
        input.proof_id.as_bytes().to_vec(),
        input.config_version.to_be_bytes().to_vec(),
        input.secret_version.to_be_bytes().to_vec(),
        input.issuer.as_bytes().to_vec(),
        input.client_id.as_bytes().to_vec(),
        input.proof.authorization_endpoint.as_bytes().to_vec(),
        input.proof.token_endpoint.as_bytes().to_vec(),
        input.proof.jwks_uri.as_bytes().to_vec(),
        input.proof.redirect_uri.as_bytes().to_vec(),
        input.proof.validation_fingerprint.to_vec(),
        input.proof.ca_fingerprint.to_vec(),
        input.proof.jwks_fingerprint.to_vec(),
        input
            .expires_at
            .unix_timestamp_nanos()
            .to_be_bytes()
            .to_vec(),
    ]
}

fn fixed_digest(row: &sqlx::postgres::PgRow, column: &str) -> Result<[u8; 32], OidcProviderError> {
    row.get::<Vec<u8>, _>(column)
        .try_into()
        .map_err(|_| OidcProviderError::ValidationFailed)
}

async fn lock_integration_ca(
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

async fn assert_current_ca(
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
    AuthenticationFailed,
    Forbidden,
    InvalidInput,
    ReauthenticationRequired,
    NotFound,
    Disabled,
    MustDisable,
    LinkedIdentities,
    Conflict,
    CredentialUnavailable,
    NetworkDenied,
    ValidationFailed,
    Unavailable,
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

#[cfg(test)]
mod tests;
