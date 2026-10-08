//! Host-bound Git provider configuration and outbound preflight.
//!
//! This module deliberately does not expose Git credentials or execute Git.
//! GIT-002 consumes an active provider through the exact repository URL lookup.

use std::collections::BTreeMap;
use std::fmt;
use std::net::{IpAddr, SocketAddr};
use std::str::FromStr;
use std::time::Duration;

use ::time::OffsetDateTime;
use reqwest::{Certificate, Client};
use sha2::{Digest, Sha256};
use sqlx::{Acquire, Postgres, Row, Transaction};
use tokio::net::lookup_host;
use tokio::time;
use url::Url;
use uuid::Uuid;

use crate::integration::{
    CaEndpointBinding, IntegrationAdminActor, IntegrationError, IntegrationRepository,
    ValidatedCaBundle, authorize_recent_admin,
};

const INTEGRATION_TYPE: &str = "git";
const DEFAULT_TIMEOUT: Duration = Duration::from_secs(5);
const MIN_TIMEOUT: Duration = Duration::from_millis(250);
const MAX_TIMEOUT: Duration = Duration::from_secs(30);
const DNS_TIMEOUT: Duration = Duration::from_secs(3);
const MAX_DNS_ADDRESSES: usize = 16;
const RESPONSE_LIMIT: usize = 64 * 1024;

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum GitProviderKind {
    GitHub,
    GitHubEnterprise,
    GitLab,
    GitLabSelfManaged,
    Generic,
}

impl GitProviderKind {
    const fn as_str(self) -> &'static str {
        match self {
            Self::GitHub => "github",
            Self::GitHubEnterprise => "github_enterprise",
            Self::GitLab => "gitlab",
            Self::GitLabSelfManaged => "gitlab_self_managed",
            Self::Generic => "generic",
        }
    }

    fn parse(value: &str) -> Result<Self, GitProviderError> {
        match value {
            "github" => Ok(Self::GitHub),
            "github_enterprise" => Ok(Self::GitHubEnterprise),
            "gitlab" => Ok(Self::GitLab),
            "gitlab_self_managed" => Ok(Self::GitLabSelfManaged),
            "generic" => Ok(Self::Generic),
            _ => Err(GitProviderError::Unavailable),
        }
    }
}

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum GitProviderState {
    Active,
    Disabled,
}

impl GitProviderState {
    fn parse(value: &str) -> Result<Self, GitProviderError> {
        match value {
            "active" => Ok(Self::Active),
            "disabled" => Ok(Self::Disabled),
            _ => Err(GitProviderError::Unavailable),
        }
    }
}

#[derive(Debug, Clone, PartialEq, Eq)]
pub struct GitProviderInput {
    display_name: String,
    kind: GitProviderKind,
    canonical_host: String,
    canonical_port: u16,
    api_base_url: String,
    oauth_authorization_url: Option<String>,
    oauth_token_url: Option<String>,
    oauth_client_id: Option<String>,
    allows_read: bool,
    allows_write: bool,
}

impl GitProviderInput {
    #[allow(clippy::too_many_arguments)]
    pub fn new(
        display_name: impl Into<String>,
        kind: GitProviderKind,
        canonical_host: impl Into<String>,
        canonical_port: u16,
        api_base_url: impl Into<String>,
        oauth_authorization_url: Option<String>,
        oauth_token_url: Option<String>,
        oauth_client_id: Option<String>,
        allows_read: bool,
        allows_write: bool,
    ) -> Result<Self, GitProviderError> {
        let input = Self {
            display_name: display_name.into(),
            kind,
            canonical_host: canonical_host.into().to_ascii_lowercase(),
            canonical_port,
            api_base_url: api_base_url.into(),
            oauth_authorization_url,
            oauth_token_url,
            oauth_client_id,
            allows_read,
            allows_write,
        };
        validate_input(&input)?;
        Ok(input)
    }
}

#[derive(Debug, Clone, PartialEq, Eq)]
pub struct GitProviderUpdate {
    display_name: String,
    api_base_url: String,
    oauth_authorization_url: Option<String>,
    oauth_token_url: Option<String>,
    oauth_client_id: Option<String>,
    allows_read: bool,
    allows_write: bool,
}

impl GitProviderUpdate {
    #[allow(clippy::too_many_arguments)]
    pub fn new(
        display_name: impl Into<String>,
        api_base_url: impl Into<String>,
        oauth_authorization_url: Option<String>,
        oauth_token_url: Option<String>,
        oauth_client_id: Option<String>,
        allows_read: bool,
        allows_write: bool,
    ) -> Result<Self, GitProviderError> {
        let update = Self {
            display_name: display_name.into(),
            api_base_url: api_base_url.into(),
            oauth_authorization_url,
            oauth_token_url,
            oauth_client_id,
            allows_read,
            allows_write,
        };
        if !valid_text(&update.display_name, 200) || (!allows_read && allows_write) {
            return Err(GitProviderError::InvalidInput);
        }
        Ok(update)
    }
}

#[derive(Debug, Clone, PartialEq, Eq)]
pub struct GitProviderMetadata {
    pub id: Uuid,
    pub display_name: String,
    pub kind: GitProviderKind,
    pub canonical_host: String,
    pub canonical_port: u16,
    pub api_base_url: String,
    pub oauth_authorization_url: Option<String>,
    pub oauth_token_url: Option<String>,
    pub oauth_client_id: Option<String>,
    pub state: GitProviderState,
    pub allows_read: bool,
    pub allows_write: bool,
    pub config_version: u64,
    pub validated_at: Option<OffsetDateTime>,
    pub created_at: OffsetDateTime,
    pub updated_at: OffsetDateTime,
}

#[derive(Clone)]
pub struct GitProviderService {
    integrations: IntegrationRepository,
    timeout: Duration,
}

impl fmt::Debug for GitProviderService {
    fn fmt(&self, formatter: &mut fmt::Formatter<'_>) -> fmt::Result {
        formatter
            .debug_struct("GitProviderService")
            .field("timeout", &self.timeout)
            .finish_non_exhaustive()
    }
}

impl GitProviderService {
    #[must_use]
    pub const fn new(integrations: IntegrationRepository) -> Self {
        Self {
            integrations,
            timeout: DEFAULT_TIMEOUT,
        }
    }

    pub fn with_timeout(mut self, timeout: Duration) -> Result<Self, GitProviderError> {
        if !(MIN_TIMEOUT..=MAX_TIMEOUT).contains(&timeout) {
            return Err(GitProviderError::InvalidInput);
        }
        self.timeout = timeout;
        Ok(self)
    }

    pub async fn list(&self) -> Result<Vec<GitProviderMetadata>, GitProviderError> {
        self.bounded(async {
            let mut connection = self
                .integrations
                .pool()
                .acquire()
                .await
                .map_err(|_| GitProviderError::Unavailable)?;
            let rows = sqlx::query(
                "SELECT id::text,display_name,provider_kind,canonical_host,canonical_port,
                 api_base_url,oauth_authorization_url,oauth_token_url,oauth_client_id,status,
                 allows_read,allows_write,config_version,validated_at,created_at,updated_at
                 FROM git_providers ORDER BY lower(display_name),id LIMIT 100",
            )
            .fetch_all(&mut *connection)
            .await
            .map_err(|_| GitProviderError::Unavailable)?;
            rows.iter().map(metadata_from_row).collect()
        })
        .await
    }

    pub async fn create(
        &self,
        actor: IntegrationAdminActor,
        input: &GitProviderInput,
        correlation_id: &str,
    ) -> Result<GitProviderMetadata, GitProviderError> {
        self.bounded(async {
            validate_input(input)?;
            validate_correlation(correlation_id)?;
            let mut connection = self.acquire().await?;
            let mut tx = connection
                .begin()
                .await
                .map_err(|_| GitProviderError::Unavailable)?;
            authorize_recent_admin(&mut tx, actor)
                .await
                .map_err(map_integration_error)?;
            let id = Uuid::now_v7();
            sqlx::query(
                "INSERT INTO git_providers(id,display_name,provider_kind,canonical_host,canonical_port,
                 api_base_url,oauth_authorization_url,oauth_token_url,oauth_client_id,allows_read,allows_write)
                 VALUES($1::uuid,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11)",
            )
            .bind(id.to_string())
            .bind(&input.display_name)
            .bind(input.kind.as_str())
            .bind(&input.canonical_host)
            .bind(i32::from(input.canonical_port))
            .bind(&input.api_base_url)
            .bind(&input.oauth_authorization_url)
            .bind(&input.oauth_token_url)
            .bind(&input.oauth_client_id)
            .bind(input.allows_read)
            .bind(input.allows_write)
            .execute(&mut *tx)
            .await
            .map_err(map_database_error)?;
            append_audit(&mut tx, actor, "git.provider_created", id, 1, correlation_id).await?;
            let metadata = load_metadata(&mut tx, id).await?;
            tx.commit()
                .await
                .map_err(|_| GitProviderError::Unavailable)?;
            Ok(metadata)
        })
        .await
    }

    pub async fn update(
        &self,
        actor: IntegrationAdminActor,
        id: Uuid,
        expected_version: u64,
        update: &GitProviderUpdate,
        correlation_id: &str,
    ) -> Result<GitProviderMetadata, GitProviderError> {
        self.bounded(async {
            validate_correlation(correlation_id)?;
            let mut connection = self.acquire().await?;
            let mut tx = connection
                .begin()
                .await
                .map_err(|_| GitProviderError::Unavailable)?;
            authorize_recent_admin(&mut tx, actor)
                .await
                .map_err(map_integration_error)?;
            let current = load_metadata_for_update(&mut tx, id, expected_version).await?;
            if current.state != GitProviderState::Disabled {
                return Err(GitProviderError::MustDisable);
            }
            let candidate = GitProviderInput {
                display_name: update.display_name.clone(),
                kind: current.kind,
                canonical_host: current.canonical_host,
                canonical_port: current.canonical_port,
                api_base_url: update.api_base_url.clone(),
                oauth_authorization_url: update.oauth_authorization_url.clone(),
                oauth_token_url: update.oauth_token_url.clone(),
                oauth_client_id: update.oauth_client_id.clone(),
                allows_read: update.allows_read,
                allows_write: update.allows_write,
            };
            validate_input(&candidate)?;
            sqlx::query(
                "UPDATE git_providers SET display_name=$2,api_base_url=$3,oauth_authorization_url=$4,
                 oauth_token_url=$5,oauth_client_id=$6,allows_read=$7,allows_write=$8,
                 config_version=config_version+1,validation_config_version=NULL,
                 validation_endpoint_fingerprint=NULL,validation_ca_fingerprint=NULL,validated_at=NULL,
                 updated_at=CURRENT_TIMESTAMP WHERE id=$1::uuid",
            )
            .bind(id.to_string())
            .bind(&candidate.display_name)
            .bind(&candidate.api_base_url)
            .bind(&candidate.oauth_authorization_url)
            .bind(&candidate.oauth_token_url)
            .bind(&candidate.oauth_client_id)
            .bind(candidate.allows_read)
            .bind(candidate.allows_write)
            .execute(&mut *tx)
            .await
            .map_err(map_database_error)?;
            append_audit(
                &mut tx,
                actor,
                "git.provider_updated",
                id,
                expected_version + 1,
                correlation_id,
            )
            .await?;
            let metadata = load_metadata(&mut tx, id).await?;
            tx.commit()
                .await
                .map_err(|_| GitProviderError::Unavailable)?;
            Ok(metadata)
        })
        .await
    }

    pub async fn disable(
        &self,
        actor: IntegrationAdminActor,
        id: Uuid,
        expected_version: u64,
        correlation_id: &str,
    ) -> Result<GitProviderMetadata, GitProviderError> {
        self.bounded(async {
            validate_correlation(correlation_id)?;
            let mut connection = self.acquire().await?;
            let mut tx = connection
                .begin()
                .await
                .map_err(|_| GitProviderError::Unavailable)?;
            authorize_recent_admin(&mut tx, actor)
                .await
                .map_err(map_integration_error)?;
            let current = load_metadata_for_update(&mut tx, id, expected_version).await?;
            if current.state != GitProviderState::Active {
                return Err(GitProviderError::Conflict);
            }
            sqlx::query(
                "UPDATE git_providers SET status='disabled',disabled_at=CURRENT_TIMESTAMP,
                 config_version=config_version+1,updated_at=CURRENT_TIMESTAMP WHERE id=$1::uuid",
            )
            .bind(id.to_string())
            .execute(&mut *tx)
            .await
            .map_err(map_database_error)?;
            append_audit(
                &mut tx,
                actor,
                "git.provider_disabled",
                id,
                expected_version + 1,
                correlation_id,
            )
            .await?;
            let metadata = load_metadata(&mut tx, id).await?;
            tx.commit()
                .await
                .map_err(|_| GitProviderError::Unavailable)?;
            Ok(metadata)
        })
        .await
    }

    pub async fn delete(
        &self,
        actor: IntegrationAdminActor,
        id: Uuid,
        expected_version: u64,
        correlation_id: &str,
    ) -> Result<(), GitProviderError> {
        self.bounded(async {
            validate_correlation(correlation_id)?;
            let mut connection = self.acquire().await?;
            let mut tx = connection
                .begin()
                .await
                .map_err(|_| GitProviderError::Unavailable)?;
            authorize_recent_admin(&mut tx, actor)
                .await
                .map_err(map_integration_error)?;
            let current = load_metadata_for_update(&mut tx, id, expected_version).await?;
            if current.state != GitProviderState::Disabled {
                return Err(GitProviderError::MustDisable);
            }
            sqlx::query("DELETE FROM git_providers WHERE id=$1::uuid")
                .bind(id.to_string())
                .execute(&mut *tx)
                .await
                .map_err(map_database_error)?;
            append_audit(
                &mut tx,
                actor,
                "git.provider_deleted",
                id,
                expected_version,
                correlation_id,
            )
            .await?;
            tx.commit()
                .await
                .map_err(|_| GitProviderError::Unavailable)?;
            Ok(())
        })
        .await
    }

    /// Resolves one repository URL to one active provider. There is no
    /// provider-order fallback: exact host and effective port either match a
    /// single configured provider or the operation is denied.
    pub async fn resolve_active_repository(
        &self,
        repository_url: &str,
    ) -> Result<GitProviderMetadata, GitProviderError> {
        let url = validate_repository_url(repository_url)?;
        let host = url
            .host_str()
            .ok_or(GitProviderError::InvalidInput)?
            .to_ascii_lowercase();
        let port = url
            .port_or_known_default()
            .ok_or(GitProviderError::InvalidInput)?;
        self.bounded(async {
            let mut connection = self.acquire().await?;
            let row = sqlx::query(
                "SELECT id::text,display_name,provider_kind,canonical_host,canonical_port,
                 api_base_url,oauth_authorization_url,oauth_token_url,oauth_client_id,status,
                 allows_read,allows_write,config_version,validated_at,created_at,updated_at
                 FROM git_providers WHERE canonical_host=$1 AND canonical_port=$2 AND status='active'",
            )
            .bind(host)
            .bind(i32::from(port))
            .fetch_optional(&mut *connection)
            .await
            .map_err(|_| GitProviderError::Unavailable)?
            .ok_or(GitProviderError::NotFound)?;
            metadata_from_row(&row)
        })
        .await
    }

    async fn candidate(
        &self,
        actor: IntegrationAdminActor,
        id: Uuid,
        expected_version: u64,
    ) -> Result<(GitProviderMetadata, Option<ValidatedCaBundle>), GitProviderError> {
        let mut connection = self.acquire().await?;
        let mut tx = connection
            .begin()
            .await
            .map_err(|_| GitProviderError::Unavailable)?;
        authorize_recent_admin(&mut tx, actor)
            .await
            .map_err(map_integration_error)?;
        let candidate = load_metadata_for_update(&mut tx, id, expected_version).await?;
        if candidate.state != GitProviderState::Disabled {
            return Err(GitProviderError::Conflict);
        }
        tx.commit()
            .await
            .map_err(|_| GitProviderError::Unavailable)?;
        let binding = endpoint_binding(&candidate)?;
        let ca = self
            .integrations
            .active_ca_for_endpoint(&binding)
            .await
            .map_err(map_integration_error)?;
        Ok((candidate, ca))
    }

    async fn activate(
        &self,
        actor: IntegrationAdminActor,
        candidate: &GitProviderMetadata,
        proof: &GitPreflightProof,
        correlation_id: &str,
    ) -> Result<GitProviderMetadata, GitProviderError> {
        let mut connection = self.acquire().await?;
        let mut tx = connection
            .begin()
            .await
            .map_err(|_| GitProviderError::Unavailable)?;
        authorize_recent_admin(&mut tx, actor)
            .await
            .map_err(map_integration_error)?;
        let current =
            load_metadata_for_update(&mut tx, candidate.id, candidate.config_version).await?;
        if current != *candidate || proof.config_version != candidate.config_version {
            return Err(GitProviderError::Conflict);
        }
        let binding = endpoint_binding(candidate)?;
        let observed_ca = active_ca_fingerprint(&mut tx, &binding).await?;
        if observed_ca != proof.ca_fingerprint {
            return Err(GitProviderError::Conflict);
        }
        sqlx::query(
            "UPDATE git_providers SET status='active',disabled_at=NULL,
             validation_config_version=config_version,
             validation_endpoint_fingerprint=$2,validation_ca_fingerprint=$3,
             validated_at=CURRENT_TIMESTAMP,config_version=config_version+1,
             updated_at=CURRENT_TIMESTAMP WHERE id=$1::uuid",
        )
        .bind(candidate.id.to_string())
        .bind(proof.endpoint_fingerprint.to_vec())
        .bind(proof.ca_fingerprint.to_vec())
        .execute(&mut *tx)
        .await
        .map_err(map_database_error)?;
        append_audit(
            &mut tx,
            actor,
            "git.provider_activated",
            candidate.id,
            candidate.config_version + 1,
            correlation_id,
        )
        .await?;
        let metadata = load_metadata(&mut tx, candidate.id).await?;
        tx.commit()
            .await
            .map_err(|_| GitProviderError::Unavailable)?;
        Ok(metadata)
    }

    async fn acquire(&self) -> Result<sqlx::pool::PoolConnection<Postgres>, GitProviderError> {
        self.integrations
            .pool()
            .acquire()
            .await
            .map_err(|_| GitProviderError::Unavailable)
    }

    async fn bounded<T>(
        &self,
        operation: impl Future<Output = Result<T, GitProviderError>>,
    ) -> Result<T, GitProviderError> {
        time::timeout(self.timeout, operation)
            .await
            .map_err(|_| GitProviderError::Unavailable)?
    }
}

#[derive(Clone)]
pub struct GitProviderValidator {
    timeout: Duration,
    allow_test_addresses: bool,
}

impl fmt::Debug for GitProviderValidator {
    fn fmt(&self, formatter: &mut fmt::Formatter<'_>) -> fmt::Result {
        formatter
            .debug_struct("GitProviderValidator")
            .field("timeout", &self.timeout)
            .finish_non_exhaustive()
    }
}

impl GitProviderValidator {
    pub fn new(timeout: Duration) -> Result<Self, GitProviderError> {
        if !(MIN_TIMEOUT..=MAX_TIMEOUT).contains(&timeout) {
            return Err(GitProviderError::InvalidInput);
        }
        Ok(Self {
            timeout,
            allow_test_addresses: false,
        })
    }

    #[cfg(test)]
    fn allowing_test_addresses(timeout: Duration) -> Result<Self, GitProviderError> {
        let mut validator = Self::new(timeout)?;
        validator.allow_test_addresses = true;
        Ok(validator)
    }

    pub async fn validate_and_activate(
        &self,
        service: &GitProviderService,
        actor: IntegrationAdminActor,
        id: Uuid,
        expected_version: u64,
        correlation_id: &str,
    ) -> Result<GitProviderMetadata, GitProviderError> {
        validate_correlation(correlation_id)?;
        let (candidate, ca) = service.candidate(actor, id, expected_version).await?;
        let proof = self.preflight(&candidate, ca.as_ref()).await?;
        service
            .activate(actor, &candidate, &proof, correlation_id)
            .await
    }

    /// Runs the normal Git Provider HTTPS validation against a staged CA
    /// candidate without changing Provider state. The endpoint binding is
    /// derived from persisted Provider metadata and must match the candidate
    /// binding supplied by the common integration CA lifecycle.
    pub(crate) async fn preflight_ca_candidate(
        &self,
        service: &GitProviderService,
        id: Uuid,
        candidate_ca: &ValidatedCaBundle,
        endpoint: &CaEndpointBinding,
    ) -> Result<(), GitProviderError> {
        let provider = service
            .list()
            .await?
            .into_iter()
            .find(|provider| provider.id == id)
            .ok_or(GitProviderError::NotFound)?;
        if endpoint_binding(&provider)?.fingerprint() != endpoint.fingerprint() {
            return Err(GitProviderError::ValidationFailed);
        }
        self.preflight(&provider, Some(candidate_ca))
            .await
            .map(|_| ())
    }

    async fn preflight(
        &self,
        candidate: &GitProviderMetadata,
        ca: Option<&ValidatedCaBundle>,
    ) -> Result<GitPreflightProof, GitProviderError> {
        let urls = provider_urls(candidate)?;
        let mut pinned = BTreeMap::<String, Vec<SocketAddr>>::new();
        for url in &urls {
            let host = url
                .host_str()
                .ok_or(GitProviderError::ValidationFailed)?
                .to_ascii_lowercase();
            let port = url
                .port_or_known_default()
                .ok_or(GitProviderError::ValidationFailed)?;
            let addresses = resolve_checked(
                &host,
                port,
                self.allow_test_addresses,
                self.timeout.min(DNS_TIMEOUT),
            )
            .await?;
            pinned.insert(format!("{host}:{port}"), addresses);
        }
        let mut builder = Client::builder()
            .redirect(reqwest::redirect::Policy::none())
            .no_proxy()
            .connect_timeout(self.timeout)
            .timeout(self.timeout)
            .https_only(true);
        for (origin, addresses) in &pinned {
            let host = origin
                .rsplit_once(':')
                .map(|(host, _)| host)
                .ok_or(GitProviderError::ValidationFailed)?;
            builder = builder.resolve_to_addrs(host, addresses);
        }
        if let Some(bundle) = ca {
            let certificates = Certificate::from_pem_bundle(bundle.pem())
                .map_err(|_| GitProviderError::ValidationFailed)?;
            builder = builder.tls_certs_only(certificates);
        }
        let client = builder
            .build()
            .map_err(|_| GitProviderError::ValidationFailed)?;
        let api_url = validate_endpoint(&candidate.api_base_url)?;
        let mut response = client
            .get(api_url)
            .header(reqwest::header::ACCEPT, "application/json")
            .header(reqwest::header::USER_AGENT, "nuriteo-git-preflight/1")
            .send()
            .await
            .map_err(|_| GitProviderError::ValidationFailed)?;
        if response.status().is_redirection()
            || response.status().is_server_error()
            || response
                .content_length()
                .is_some_and(|length| length > RESPONSE_LIMIT as u64)
        {
            return Err(GitProviderError::ValidationFailed);
        }
        let mut read = 0_usize;
        while let Some(chunk) = response
            .chunk()
            .await
            .map_err(|_| GitProviderError::ValidationFailed)?
        {
            read = read
                .checked_add(chunk.len())
                .filter(|size| *size <= RESPONSE_LIMIT)
                .ok_or(GitProviderError::ValidationFailed)?;
        }
        for url in &urls {
            let host = url
                .host_str()
                .ok_or(GitProviderError::ValidationFailed)?
                .to_ascii_lowercase();
            let port = url
                .port_or_known_default()
                .ok_or(GitProviderError::ValidationFailed)?;
            let observed = resolve_checked(
                &host,
                port,
                self.allow_test_addresses,
                self.timeout.min(DNS_TIMEOUT),
            )
            .await?;
            if pinned.get(&format!("{host}:{port}")) != Some(&observed) {
                return Err(GitProviderError::NetworkDenied);
            }
        }
        Ok(GitPreflightProof {
            config_version: candidate.config_version,
            endpoint_fingerprint: endpoint_fingerprint(candidate, &pinned),
            ca_fingerprint: trust_fingerprint(ca),
        })
    }
}

#[derive(Debug)]
struct GitPreflightProof {
    config_version: u64,
    endpoint_fingerprint: [u8; 32],
    ca_fingerprint: [u8; 32],
}

fn validate_input(input: &GitProviderInput) -> Result<(), GitProviderError> {
    if !valid_text(&input.display_name, 200)
        || !valid_host(&input.canonical_host)
        || input.canonical_port == 0
        || (!input.allows_read && input.allows_write)
    {
        return Err(GitProviderError::InvalidInput);
    }
    let api = validate_endpoint(&input.api_base_url)?;
    let oauth = match (
        input.oauth_authorization_url.as_deref(),
        input.oauth_token_url.as_deref(),
        input.oauth_client_id.as_deref(),
    ) {
        (Some(authorization), Some(token), Some(client_id)) if valid_text(client_id, 1024) => {
            Some((validate_endpoint(authorization)?, validate_endpoint(token)?))
        }
        (None, None, None) => None,
        _ => return Err(GitProviderError::InvalidInput),
    };
    match input.kind {
        GitProviderKind::GitHub => {
            if input.canonical_host != "github.com"
                || input.canonical_port != 443
                || !exact_origin(&api, "api.github.com", 443)
                || !oauth.is_some_and(|(authorization, token)| {
                    exact_origin(&authorization, "github.com", 443)
                        && exact_origin(&token, "github.com", 443)
                })
            {
                return Err(GitProviderError::InvalidInput);
            }
        }
        GitProviderKind::GitLab => {
            if input.canonical_host != "gitlab.com"
                || input.canonical_port != 443
                || !exact_origin(&api, "gitlab.com", 443)
                || !oauth.is_some_and(|(authorization, token)| {
                    exact_origin(&authorization, "gitlab.com", 443)
                        && exact_origin(&token, "gitlab.com", 443)
                })
            {
                return Err(GitProviderError::InvalidInput);
            }
        }
        GitProviderKind::GitHubEnterprise | GitProviderKind::GitLabSelfManaged => {
            if !exact_origin(&api, &input.canonical_host, input.canonical_port)
                || !oauth.is_some_and(|(authorization, token)| {
                    exact_origin(&authorization, &input.canonical_host, input.canonical_port)
                        && exact_origin(&token, &input.canonical_host, input.canonical_port)
                })
            {
                return Err(GitProviderError::InvalidInput);
            }
        }
        GitProviderKind::Generic => {
            if oauth.is_some() || !exact_origin(&api, &input.canonical_host, input.canonical_port) {
                return Err(GitProviderError::InvalidInput);
            }
        }
    }
    Ok(())
}

fn validate_endpoint(value: &str) -> Result<Url, GitProviderError> {
    let url = Url::parse(value).map_err(|_| GitProviderError::InvalidInput)?;
    if url.scheme() != "https"
        || url.host_str().is_none()
        || !url.username().is_empty()
        || url.password().is_some()
        || url.query().is_some()
        || url.fragment().is_some()
    {
        return Err(GitProviderError::InvalidInput);
    }
    Ok(url)
}

fn validate_repository_url(value: &str) -> Result<Url, GitProviderError> {
    let canonical_candidate = value.to_ascii_lowercase();
    if canonical_candidate.contains("/../")
        || canonical_candidate.contains("/./")
        || canonical_candidate.contains("%2e")
    {
        return Err(GitProviderError::InvalidInput);
    }
    let url = validate_endpoint(value)?;
    if url.path() == "/" || url.path().is_empty() {
        return Err(GitProviderError::InvalidInput);
    }
    Ok(url)
}

fn provider_urls(provider: &GitProviderMetadata) -> Result<Vec<Url>, GitProviderError> {
    let mut urls = vec![validate_endpoint(&provider.api_base_url)?];
    match (
        provider.oauth_authorization_url.as_deref(),
        provider.oauth_token_url.as_deref(),
    ) {
        (Some(authorization), Some(token)) => {
            urls.push(validate_endpoint(authorization)?);
            urls.push(validate_endpoint(token)?);
        }
        (None, None) if provider.kind == GitProviderKind::Generic => {}
        _ => return Err(GitProviderError::ValidationFailed),
    }
    Ok(urls)
}

fn exact_origin(url: &Url, host: &str, port: u16) -> bool {
    url.scheme() == "https"
        && url
            .host_str()
            .is_some_and(|value| value.eq_ignore_ascii_case(host))
        && url.port_or_known_default() == Some(port)
}

fn valid_host(value: &str) -> bool {
    !value.is_empty()
        && value.len() <= 253
        && value == value.trim()
        && value == value.to_ascii_lowercase()
        && !value
            .bytes()
            .any(|byte| byte.is_ascii_control() || byte.is_ascii_whitespace())
        && !value.contains(['/', ':', '@', '?', '#'])
        && Url::parse(&format!("https://{value}/"))
            .ok()
            .and_then(|url| url.host_str().map(ToOwned::to_owned))
            .is_some_and(|host| host == value)
}

fn valid_text(value: &str, max: usize) -> bool {
    !value.is_empty()
        && value.len() <= max
        && value.trim() == value
        && !value.chars().any(char::is_control)
}

async fn resolve_checked(
    host: &str,
    port: u16,
    allow_test: bool,
    deadline: Duration,
) -> Result<Vec<SocketAddr>, GitProviderError> {
    let resolved = time::timeout(deadline, lookup_host((host, port)))
        .await
        .map_err(|_| GitProviderError::ValidationFailed)?
        .map_err(|_| GitProviderError::ValidationFailed)?
        .take(MAX_DNS_ADDRESSES + 1);
    let mut addresses: Vec<_> = resolved.collect();
    if addresses.is_empty()
        || addresses.len() > MAX_DNS_ADDRESSES
        || (!allow_test && addresses.iter().any(|address| !is_public_ip(address.ip())))
    {
        return Err(GitProviderError::NetworkDenied);
    }
    addresses.sort_unstable();
    addresses.dedup();
    Ok(addresses)
}

fn is_public_ip(ip: IpAddr) -> bool {
    match ip {
        IpAddr::V4(ip) => {
            let [a, b, c, d] = ip.octets();
            !(a == 0
                || a == 10
                || a == 127
                || a >= 224
                || (a == 169 && b == 254)
                || (a == 168 && b == 63 && c == 129 && d == 16)
                || (a == 172 && (16..=31).contains(&b))
                || (a == 192 && b == 168)
                || (a == 100 && (64..=127).contains(&b))
                || (a == 192 && b == 0 && c == 0)
                || (a == 192 && b == 0 && c == 2)
                || (a == 198 && (b == 18 || b == 19))
                || (a == 198 && b == 51 && c == 100)
                || (a == 203 && b == 0 && c == 113))
        }
        IpAddr::V6(ip) => {
            if let Some(mapped) = ip.to_ipv4_mapped() {
                return is_public_ip(IpAddr::V4(mapped));
            }
            let segments = ip.segments();
            !(ip.is_loopback()
                || ip.is_unspecified()
                || ip.is_multicast()
                || ip.is_unique_local()
                || (segments[0] & 0xffc0) == 0xfe80
                || (segments[0] & 0xffc0) == 0xfec0
                || (segments[0] == 0x2001 && segments[1] == 0x0db8)
                || segments[0] == 0x2002)
        }
    }
}

fn endpoint_fingerprint(
    candidate: &GitProviderMetadata,
    addresses: &BTreeMap<String, Vec<SocketAddr>>,
) -> [u8; 32] {
    let mut digest = Sha256::new();
    for field in [
        "nuriteo.git-provider-preflight.v1",
        candidate.id.to_string().as_str(),
        candidate.kind.as_str(),
        &candidate.canonical_host,
        &candidate.canonical_port.to_string(),
        &candidate.api_base_url,
        candidate.oauth_authorization_url.as_deref().unwrap_or(""),
        candidate.oauth_token_url.as_deref().unwrap_or(""),
    ] {
        digest.update((field.len() as u32).to_be_bytes());
        digest.update(field.as_bytes());
    }
    for (origin, values) in addresses {
        digest.update((origin.len() as u32).to_be_bytes());
        digest.update(origin.as_bytes());
        for value in values {
            let value = value.to_string();
            digest.update((value.len() as u32).to_be_bytes());
            digest.update(value.as_bytes());
        }
    }
    digest.finalize().into()
}

fn trust_fingerprint(ca: Option<&ValidatedCaBundle>) -> [u8; 32] {
    match ca {
        Some(bundle) => Sha256::digest(bundle.pem()).into(),
        None => Sha256::digest(b"nuriteo.git-provider.system-roots.v1").into(),
    }
}

pub(crate) fn endpoint_binding(
    provider: &GitProviderMetadata,
) -> Result<CaEndpointBinding, GitProviderError> {
    CaEndpointBinding::new(
        INTEGRATION_TYPE,
        provider.id.to_string(),
        provider.canonical_host.clone(),
        provider.canonical_port,
        "https",
    )
    .map_err(map_integration_error)
}

async fn active_ca_fingerprint(
    tx: &mut Transaction<'_, Postgres>,
    binding: &CaEndpointBinding,
) -> Result<[u8; 32], GitProviderError> {
    let rows: Vec<Vec<u8>> = sqlx::query_scalar(
        "SELECT pem FROM integration_ca_bundles WHERE integration_type=$1 AND integration_id=$2
         AND state='active' AND endpoint_fingerprint=$3",
    )
    .bind(binding.integration_type())
    .bind(binding.integration_id())
    .bind(binding.fingerprint().to_vec())
    .fetch_all(&mut **tx)
    .await
    .map_err(|_| GitProviderError::Unavailable)?;
    match rows.as_slice() {
        [] => Ok(trust_fingerprint(None)),
        [pem] => Ok(Sha256::digest(pem).into()),
        _ => Err(GitProviderError::Conflict),
    }
}

async fn load_metadata_for_update(
    tx: &mut Transaction<'_, Postgres>,
    id: Uuid,
    expected_version: u64,
) -> Result<GitProviderMetadata, GitProviderError> {
    let row = sqlx::query(
        "SELECT id::text,display_name,provider_kind,canonical_host,canonical_port,
         api_base_url,oauth_authorization_url,oauth_token_url,oauth_client_id,status,
         allows_read,allows_write,config_version,validated_at,created_at,updated_at
         FROM git_providers WHERE id=$1::uuid FOR UPDATE",
    )
    .bind(id.to_string())
    .fetch_optional(&mut **tx)
    .await
    .map_err(|_| GitProviderError::Unavailable)?
    .ok_or(GitProviderError::NotFound)?;
    let metadata = metadata_from_row(&row)?;
    if metadata.config_version != expected_version {
        return Err(GitProviderError::Conflict);
    }
    Ok(metadata)
}

async fn load_metadata(
    tx: &mut Transaction<'_, Postgres>,
    id: Uuid,
) -> Result<GitProviderMetadata, GitProviderError> {
    let row = sqlx::query(
        "SELECT id::text,display_name,provider_kind,canonical_host,canonical_port,
         api_base_url,oauth_authorization_url,oauth_token_url,oauth_client_id,status,
         allows_read,allows_write,config_version,validated_at,created_at,updated_at
         FROM git_providers WHERE id=$1::uuid",
    )
    .bind(id.to_string())
    .fetch_optional(&mut **tx)
    .await
    .map_err(|_| GitProviderError::Unavailable)?
    .ok_or(GitProviderError::NotFound)?;
    metadata_from_row(&row)
}

pub(crate) fn metadata_from_database_row(
    row: &sqlx::postgres::PgRow,
) -> Result<GitProviderMetadata, GitProviderError> {
    Ok(GitProviderMetadata {
        id: Uuid::from_str(row.get::<String, _>("id").as_str())
            .map_err(|_| GitProviderError::Unavailable)?,
        display_name: row.get("display_name"),
        kind: GitProviderKind::parse(row.get("provider_kind"))?,
        canonical_host: row.get("canonical_host"),
        canonical_port: u16::try_from(row.get::<i32, _>("canonical_port"))
            .map_err(|_| GitProviderError::Unavailable)?,
        api_base_url: row.get("api_base_url"),
        oauth_authorization_url: row.get("oauth_authorization_url"),
        oauth_token_url: row.get("oauth_token_url"),
        oauth_client_id: row.get("oauth_client_id"),
        state: GitProviderState::parse(row.get("status"))?,
        allows_read: row.get("allows_read"),
        allows_write: row.get("allows_write"),
        config_version: u64::try_from(row.get::<i64, _>("config_version"))
            .map_err(|_| GitProviderError::Unavailable)?,
        validated_at: row.get("validated_at"),
        created_at: row.get("created_at"),
        updated_at: row.get("updated_at"),
    })
}

fn metadata_from_row(row: &sqlx::postgres::PgRow) -> Result<GitProviderMetadata, GitProviderError> {
    metadata_from_database_row(row)
}

async fn append_audit(
    tx: &mut Transaction<'_, Postgres>,
    actor: IntegrationAdminActor,
    action: &str,
    id: Uuid,
    version: u64,
    correlation_id: &str,
) -> Result<(), GitProviderError> {
    sqlx::query(
        "INSERT INTO audit_events(id,actor_type,actor_id,actor_user_id,action_code,target_type,target_id,
         scope_type,scope_id,result,correlation_id,changed_fields,metadata)
         VALUES($1::uuid,'user',$2,$2::uuid,$3,'git_provider',$4,'instance','instance','succeeded',$5,$6,$7::jsonb)",
    )
    .bind(Uuid::now_v7().to_string())
    .bind(actor.user_id.to_string())
    .bind(action)
    .bind(id.to_string())
    .bind(correlation_id)
    .bind(vec!["provider_config".to_owned()])
    .bind(serde_json::json!({"configVersion": version}).to_string())
    .execute(&mut **tx)
    .await
    .map_err(|_| GitProviderError::Unavailable)?;
    Ok(())
}

fn validate_correlation(value: &str) -> Result<(), GitProviderError> {
    if (1..=128).contains(&value.len())
        && value
            .bytes()
            .all(|byte| byte.is_ascii_alphanumeric() || matches!(byte, b'.' | b'_' | b':' | b'-'))
    {
        Ok(())
    } else {
        Err(GitProviderError::InvalidInput)
    }
}

fn map_database_error(error: sqlx::Error) -> GitProviderError {
    match error
        .as_database_error()
        .and_then(|database| database.code())
        .as_deref()
    {
        Some("23505") => GitProviderError::HostAlreadyRegistered,
        Some("23514" | "P0001") => GitProviderError::ValidationFailed,
        _ => GitProviderError::Unavailable,
    }
}

const fn map_integration_error(error: IntegrationError) -> GitProviderError {
    match error {
        IntegrationError::InvalidInput => GitProviderError::InvalidInput,
        IntegrationError::ReauthenticationRequired => GitProviderError::ReauthenticationRequired,
        IntegrationError::Conflict => GitProviderError::Conflict,
        IntegrationError::InvalidCaBundle | IntegrationError::PreflightFailed => {
            GitProviderError::ValidationFailed
        }
        IntegrationError::KeyConfiguration
        | IntegrationError::CredentialUnavailable
        | IntegrationError::Unavailable => GitProviderError::Unavailable,
    }
}

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum GitProviderError {
    InvalidInput,
    ReauthenticationRequired,
    NotFound,
    MustDisable,
    HostAlreadyRegistered,
    Conflict,
    NetworkDenied,
    ValidationFailed,
    Unavailable,
}

impl fmt::Display for GitProviderError {
    fn fmt(&self, formatter: &mut fmt::Formatter<'_>) -> fmt::Result {
        formatter.write_str(match self {
            Self::InvalidInput => "Git provider input is invalid",
            Self::ReauthenticationRequired => "recent administrator authentication is required",
            Self::NotFound => "Git provider was not found",
            Self::MustDisable => "Git provider must be disabled first",
            Self::HostAlreadyRegistered => "Git provider host is already registered",
            Self::Conflict => "Git provider changed concurrently",
            Self::NetworkDenied => "Git provider network destination is denied",
            Self::ValidationFailed => "Git provider validation failed",
            Self::Unavailable => "Git provider service is unavailable",
        })
    }
}

impl std::error::Error for GitProviderError {}

#[cfg(test)]
mod tests {
    use std::env;
    use std::ffi::OsString;
    use std::fs;
    use std::io;
    use std::path::Path;
    use std::pin::Pin;

    use base64::Engine;
    use base64::engine::general_purpose::URL_SAFE_NO_PAD;

    use super::*;
    use crate::config::{Environment, FileReader, InstanceSettingBootstrap};
    use crate::database::{
        DatabasePool, DatabasePoolConfig, DatabaseTlsConfig, MigrationOptions,
        run_embedded_migrations,
    };
    use crate::identity::{SessionId, UserId};
    use crate::instance_settings::InstanceSettingsRepository;
    use crate::integration::{
        CaCandidatePreflight, CaPreflightProof, IntegrationAdminService, MasterKeyring,
    };

    fn github() -> GitProviderInput {
        GitProviderInput::new(
            "GitHub",
            GitProviderKind::GitHub,
            "github.com",
            443,
            "https://api.github.com/",
            Some("https://github.com/login/oauth/authorize".into()),
            Some("https://github.com/login/oauth/access_token".into()),
            Some("client-id".into()),
            true,
            true,
        )
        .unwrap()
    }

    #[test]
    fn accepts_exact_public_provider_contracts() {
        let github = github();
        assert_eq!(github.kind, GitProviderKind::GitHub);
        let gitlab = GitProviderInput::new(
            "GitLab",
            GitProviderKind::GitLab,
            "gitlab.com",
            443,
            "https://gitlab.com/api/v4",
            Some("https://gitlab.com/oauth/authorize".into()),
            Some("https://gitlab.com/oauth/token".into()),
            Some("client-id".into()),
            true,
            false,
        );
        assert!(gitlab.is_ok());
    }

    #[test]
    fn rejects_cross_host_oauth_and_generic_credentials() {
        let cross_host = GitProviderInput::new(
            "GitLab",
            GitProviderKind::GitLab,
            "gitlab.com",
            443,
            "https://gitlab.com/api/v4",
            Some("https://attacker.example/oauth".into()),
            Some("https://gitlab.com/oauth/token".into()),
            Some("client-id".into()),
            true,
            false,
        );
        assert_eq!(cross_host.unwrap_err(), GitProviderError::InvalidInput);
        let generic_oauth = GitProviderInput::new(
            "Forge",
            GitProviderKind::Generic,
            "git.example.test",
            443,
            "https://git.example.test/",
            Some("https://git.example.test/oauth".into()),
            Some("https://git.example.test/token".into()),
            Some("client".into()),
            true,
            false,
        );
        assert_eq!(generic_oauth.unwrap_err(), GitProviderError::InvalidInput);
    }

    #[test]
    fn repository_urls_are_https_credential_free_and_path_bound() {
        assert!(validate_repository_url("https://git.example.test/acme/app.git").is_ok());
        for invalid in [
            "http://git.example.test/acme/app.git",
            "https://token@git.example.test/acme/app.git",
            "https://git.example.test/",
            "https://git.example.test/acme/../admin",
            "https://git.example.test/acme/app.git?token=value",
        ] {
            assert!(validate_repository_url(invalid).is_err(), "{invalid}");
        }
    }

    #[test]
    fn blocks_private_and_metadata_networks() {
        for value in [
            "127.0.0.1:443",
            "10.0.0.1:443",
            "169.254.169.254:443",
            "168.63.129.16:443",
            "[::1]:443",
        ] {
            let address: SocketAddr = value.parse().unwrap();
            assert!(!is_public_ip(address.ip()), "{value}");
        }
        assert!(is_public_ip("1.1.1.1".parse().unwrap()));
    }

    #[test]
    fn test_validator_is_explicitly_scoped() {
        let validator = GitProviderValidator::allowing_test_addresses(Duration::from_secs(1));
        assert!(validator.is_ok());
    }

    #[tokio::test]
    #[ignore = "requires tests/fixtures/postgres-git-provider/run.sh"]
    async fn actual_provider_preflight_is_host_bound_tls_pinned_and_no_fallback() {
        let pool = fixture_pool().await;
        reset_fixture(&pool).await;
        let report = run_embedded_migrations(
            &pool,
            MigrationOptions::new(Duration::from_secs(5), Duration::from_secs(30)).unwrap(),
        )
        .await
        .unwrap();
        assert_eq!(report.latest_version, Some(40));
        InstanceSettingsRepository::new(pool.clone(), Duration::from_secs(5))
            .unwrap()
            .materialize(&InstanceSettingBootstrap::empty())
            .await
            .unwrap();
        seed_admin(&pool).await;

        let port = env::var("NURITEO_TEST_GIT_PORT")
            .unwrap()
            .parse::<u16>()
            .unwrap();
        let control = env::var("NURITEO_TEST_GIT_CONTROL_DIR").unwrap();
        let repository = IntegrationRepository::new(pool.clone(), keyring());
        let service = GitProviderService::new(repository.clone());
        let input = GitProviderInput::new(
            "Internal Forge",
            GitProviderKind::Generic,
            "localhost",
            port,
            format!("https://localhost:{port}/api"),
            None,
            None,
            None,
            true,
            true,
        )
        .unwrap();
        let created = service
            .create(actor(), &input, "request:git-create")
            .await
            .unwrap();
        assert_eq!(created.state, GitProviderState::Disabled);

        assert_eq!(
            service
                .create(actor(), &input, "request:git-duplicate")
                .await
                .unwrap_err(),
            GitProviderError::HostAlreadyRegistered
        );
        assert!(
            sqlx::query(
                "INSERT INTO git_providers(id,display_name,provider_kind,canonical_host,
                 canonical_port,api_base_url,status,disabled_at,allows_read,allows_write)
                 VALUES($1::uuid,'Bypass','generic','bypass.example.test',443,
                 'https://bypass.example.test/','active',NULL,TRUE,FALSE)",
            )
            .bind(Uuid::now_v7().to_string())
            .execute(&mut *pool.acquire().await.unwrap())
            .await
            .is_err(),
            "providers must be inserted disabled and unvalidated"
        );

        let production = GitProviderValidator::new(Duration::from_secs(3)).unwrap();
        assert_eq!(
            production
                .validate_and_activate(
                    &service,
                    actor(),
                    created.id,
                    created.config_version,
                    "request:git-ssrf",
                )
                .await
                .unwrap_err(),
            GitProviderError::NetworkDenied
        );
        let test_validator =
            GitProviderValidator::allowing_test_addresses(Duration::from_secs(3)).unwrap();
        assert_eq!(
            test_validator
                .validate_and_activate(
                    &service,
                    actor(),
                    created.id,
                    created.config_version,
                    "request:git-wrong-ca",
                )
                .await
                .unwrap_err(),
            GitProviderError::ValidationFailed
        );

        let ca =
            ValidatedCaBundle::parse(fs::read(env::var("NURITEO_TEST_GIT_CA").unwrap()).unwrap())
                .unwrap();
        let endpoint = endpoint_binding(&created).unwrap();
        let admin = IntegrationAdminService::new(repository);
        let staged = admin
            .stage_ca_candidate(actor(), &endpoint, ca, "request:git-ca-stage")
            .await
            .unwrap();
        admin
            .activate_ca_candidate(
                actor(),
                staged.id,
                &endpoint,
                "request:git-ca-activate",
                &ExactPreflight,
            )
            .await
            .unwrap();

        for mode in ["redirect", "oversize"] {
            fs::write(Path::new(&control).join("mode"), mode).unwrap();
            assert_eq!(
                test_validator
                    .validate_and_activate(
                        &service,
                        actor(),
                        created.id,
                        created.config_version,
                        "request:git-negative-preflight",
                    )
                    .await
                    .unwrap_err(),
                GitProviderError::ValidationFailed,
                "{mode}"
            );
        }
        fs::write(Path::new(&control).join("mode"), "normal").unwrap();
        let active = test_validator
            .validate_and_activate(
                &service,
                actor(),
                created.id,
                created.config_version,
                "request:git-activate",
            )
            .await
            .unwrap();
        assert_eq!(active.state, GitProviderState::Active);
        assert_eq!(active.config_version, created.config_version + 1);
        assert!(
            sqlx::query(
                "UPDATE git_providers SET display_name='Bypass Active Mutation',
                 config_version=config_version+1,updated_at=CURRENT_TIMESTAMP WHERE id=$1::uuid",
            )
            .bind(active.id.to_string())
            .execute(&mut *pool.acquire().await.unwrap())
            .await
            .is_err(),
            "active configuration cannot be changed through raw SQL"
        );

        let resolved = service
            .resolve_active_repository(&format!(
                "https://localhost:{port}/organization/project.git"
            ))
            .await
            .unwrap();
        assert_eq!(resolved.id, active.id);
        assert_eq!(
            service
                .resolve_active_repository(&format!(
                    "https://localhost:{}/organization/project.git",
                    port + 1
                ))
                .await
                .unwrap_err(),
            GitProviderError::NotFound,
            "an exact-host miss must not fall back to another provider"
        );
        assert_eq!(
            service
                .update(
                    actor(),
                    active.id,
                    active.config_version,
                    &GitProviderUpdate::new(
                        "Changed",
                        format!("https://localhost:{port}/api"),
                        None,
                        None,
                        None,
                        true,
                        false,
                    )
                    .unwrap(),
                    "request:git-active-update",
                )
                .await
                .unwrap_err(),
            GitProviderError::MustDisable
        );
        let disabled = service
            .disable(
                actor(),
                active.id,
                active.config_version,
                "request:git-disable",
            )
            .await
            .unwrap();
        assert_eq!(disabled.state, GitProviderState::Disabled);
        assert_eq!(
            service
                .resolve_active_repository(&format!(
                    "https://localhost:{port}/organization/project.git"
                ))
                .await
                .unwrap_err(),
            GitProviderError::NotFound
        );

        let audit_count: i64 = sqlx::query_scalar(
            "SELECT count(*) FROM audit_events WHERE target_type='git_provider' AND target_id=$1",
        )
        .bind(created.id.to_string())
        .fetch_one(&mut *pool.acquire().await.unwrap())
        .await
        .unwrap();
        assert_eq!(audit_count, 3);
        reset_fixture(&pool).await;
        pool.close(Duration::from_secs(2)).await.unwrap();
    }

    struct ExactPreflight;

    impl CaCandidatePreflight for ExactPreflight {
        fn preflight<'a>(
            &'a self,
            _: &'a ValidatedCaBundle,
            endpoint: &'a CaEndpointBinding,
        ) -> Pin<Box<dyn Future<Output = Result<CaPreflightProof, IntegrationError>> + Send + 'a>>
        {
            Box::pin(async move {
                Ok(CaPreflightProof {
                    endpoint_fingerprint: endpoint.fingerprint(),
                })
            })
        }
    }

    fn actor() -> IntegrationAdminActor {
        IntegrationAdminActor {
            user_id: "0199ee6c-c777-7000-8000-000000009001"
                .parse::<UserId>()
                .unwrap(),
            session_id: "0199ee6c-c777-7000-8000-000000009002"
                .parse::<SessionId>()
                .unwrap(),
        }
    }

    async fn seed_admin(pool: &DatabasePool) {
        sqlx::query("INSERT INTO users(id,email,normalized_email,display_name,is_instance_admin) VALUES('0199ee6c-c777-7000-8000-000000009001','git-admin@example.test','git-admin@example.test','Git Admin',TRUE)")
            .execute(&mut *pool.acquire().await.unwrap()).await.unwrap();
        sqlx::query("INSERT INTO sessions(id,user_id,token_hash,created_at,last_seen_at,idle_expires_at,absolute_expires_at,last_reauthenticated_at) VALUES('0199ee6c-c777-7000-8000-000000009002','0199ee6c-c777-7000-8000-000000009001',decode(repeat('71',32),'hex'),CURRENT_TIMESTAMP,CURRENT_TIMESTAMP,CURRENT_TIMESTAMP+INTERVAL '1 hour',CURRENT_TIMESTAMP+INTERVAL '2 hour',CURRENT_TIMESTAMP)")
            .execute(&mut *pool.acquire().await.unwrap()).await.unwrap();
        sqlx::query("INSERT INTO local_password_credentials(user_id,password_verifier) VALUES('0199ee6c-c777-7000-8000-000000009001','$argon2id$v=19$m=19456,t=2,p=1$c2FsdHNhbHRzYWx0c2FsdA$5izDQ8GG3kr1hDx0wzfQt5n4kQ2DqVfvMXkZXS8RvlM')")
            .execute(&mut *pool.acquire().await.unwrap()).await.unwrap();
    }

    fn keyring() -> MasterKeyring {
        MasterKeyring::load(
            &TestEnvironment(vec![
                (
                    "NURITEO_MASTER_KEY".into(),
                    URL_SAFE_NO_PAD.encode([91; 32]).into(),
                ),
                ("NURITEO_MASTER_KEY_VERSION".into(), "1".into()),
            ]),
            &NoFiles,
        )
        .unwrap()
    }

    #[derive(Clone)]
    struct TestEnvironment(Vec<(OsString, OsString)>);

    impl Environment for TestEnvironment {
        fn entries(&self) -> Vec<(OsString, OsString)> {
            self.0.clone()
        }
    }

    struct NoFiles;

    impl FileReader for NoFiles {
        fn read(&self, _: &Path, _: usize) -> io::Result<Vec<u8>> {
            Err(io::ErrorKind::NotFound.into())
        }
    }

    async fn reset_fixture(pool: &DatabasePool) {
        sqlx::raw_sql("DROP SCHEMA public CASCADE; CREATE SCHEMA public;")
            .execute(&mut *pool.acquire().await.unwrap())
            .await
            .unwrap();
    }

    async fn fixture_pool() -> DatabasePool {
        let tls = DatabaseTlsConfig::verify_full(
            None,
            Some(fs::read(env::var("NURITEO_TEST_DATABASE_CA").unwrap()).unwrap()),
            None,
        )
        .unwrap();
        DatabasePool::connect(
            DatabasePoolConfig::new(
                env::var("NURITEO_TEST_DATABASE_URL").unwrap(),
                1,
                4,
                Duration::from_secs(5),
                Duration::from_secs(5),
                tls,
            )
            .unwrap(),
        )
        .await
        .unwrap()
    }
}
