#![allow(unused_imports)]
use super::*;
use super::providers::*;
use super::provider_store::*;

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

use protocol::{OidcValidationProof, trust_fingerprint};
use super::{INSTANCE_ID, INTEGRATION_TYPE, CLIENT_SECRET_KIND, ACTIVATION_ATTESTATION_DOMAIN, DEFAULT_TIMEOUT, MIN_TIMEOUT, MAX_TIMEOUT, OidcProviderInput, OidcProviderUpdate, OidcProviderState, OidcProviderMetadata, OidcRuntimeProvider, OidcProviderService, ActivationAttestationInput, map_integration_error, OidcProviderError};



impl super::OidcProviderInput {
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


impl OidcProviderState {
    pub(crate) fn parse(value: &str) -> Result<Self, OidcProviderError> {
        match value {
            "active" => Ok(Self::Active),
            "disabled" => Ok(Self::Disabled),
            _ => Err(OidcProviderError::Unavailable),
        }
    }
}


impl fmt::Debug for OidcRuntimeProvider { fn fmt(&self, formatter: &mut fmt::Formatter<'_>) -> fmt::Result {
        formatter
            .debug_struct("OidcRuntimeProvider")
            .field("metadata", &self.metadata)
            .field("client_secret", &"[REDACTED]")
            .finish()
    }
}


impl fmt::Debug for OidcProviderService { fn fmt(&self, formatter: &mut fmt::Formatter<'_>) -> fmt::Result {
        formatter
            .debug_struct("OidcProviderService")
            .field("timeout", &self.timeout)
            .finish_non_exhaustive()
    }
}
