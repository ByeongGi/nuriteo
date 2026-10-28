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

#[derive(Debug, Clone, PartialEq, Eq)]
pub struct OidcProviderUpdate {
    display_name: String,
    client_id: String,
}

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum OidcProviderState {
    Active,
    Disabled,
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

#[derive(Clone)]
pub struct OidcProviderService {
    integrations: IntegrationRepository,
    timeout: Duration,
}

pub(crate) struct ActivationAttestationInput<'a> {
    provider_id: Uuid,
    proof_id: Uuid,
    config_version: u64,
    secret_version: u64,
    issuer: &'a str,
    client_id: &'a str,
    proof: &'a OidcValidationProof,
    expires_at: OffsetDateTime,
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

#[cfg(test)]
mod tests;

mod provider_model;
pub(crate) use provider_model::*;
mod providers;
pub(crate) use providers::*;
mod provider_store;
pub(crate) use provider_store::*;
