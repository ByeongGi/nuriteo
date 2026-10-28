#![allow(unused_imports)]
use super::*;
use super::endpoint::*;

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
use super::{INTEGRATION_TYPE, DEFAULT_TIMEOUT, MIN_TIMEOUT, MAX_TIMEOUT, DNS_TIMEOUT, MAX_DNS_ADDRESSES, RESPONSE_LIMIT, GitProviderKind, GitProviderState, GitProviderInput, GitProviderUpdate, GitProviderMetadata, GitProviderService, GitProviderValidator, GitPreflightProof, map_integration_error, GitProviderError};



impl super::GitProviderKind {
    pub(crate) const fn as_str(self) -> &'static str {
        match self {
            Self::GitHub => "github",
            Self::GitHubEnterprise => "github_enterprise",
            Self::GitLab => "gitlab",
            Self::GitLabSelfManaged => "gitlab_self_managed",
            Self::Generic => "generic",
        }
    }

    pub(crate) fn parse(value: &str) -> Result<Self, GitProviderError> {
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


impl GitProviderState {
    pub(crate) fn parse(value: &str) -> Result<Self, GitProviderError> {
        match value {
            "active" => Ok(Self::Active),
            "disabled" => Ok(Self::Disabled),
            _ => Err(GitProviderError::Unavailable),
        }
    }
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


impl fmt::Debug for GitProviderService { fn fmt(&self, formatter: &mut fmt::Formatter<'_>) -> fmt::Result {
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

    pub(crate) async fn candidate(
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

    pub(crate) async fn activate(
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

    pub(crate) async fn acquire(&self) -> Result<sqlx::pool::PoolConnection<Postgres>, GitProviderError> {
        self.integrations
            .pool()
            .acquire()
            .await
            .map_err(|_| GitProviderError::Unavailable)
    }

    pub(crate) async fn bounded<T>(
        &self,
        operation: impl Future<Output = Result<T, GitProviderError>>,
    ) -> Result<T, GitProviderError> {
        time::timeout(self.timeout, operation)
            .await
            .map_err(|_| GitProviderError::Unavailable)?
    }
}


impl fmt::Debug for GitProviderValidator { fn fmt(&self, formatter: &mut fmt::Formatter<'_>) -> fmt::Result {
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
    pub(crate) fn allowing_test_addresses(timeout: Duration) -> Result<Self, GitProviderError> {
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

    pub(crate) async fn preflight(
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


pub(crate) fn validate_input(input: &GitProviderInput) -> Result<(), GitProviderError> {    if !valid_text(&input.display_name, 200)
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


pub(crate) fn validate_endpoint(value: &str) -> Result<Url, GitProviderError> {    let url = Url::parse(value).map_err(|_| GitProviderError::InvalidInput)?;
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


pub(crate) fn validate_repository_url(value: &str) -> Result<Url, GitProviderError> {    let canonical_candidate = value.to_ascii_lowercase();
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


pub(crate) fn provider_urls(provider: &GitProviderMetadata) -> Result<Vec<Url>, GitProviderError> {    let mut urls = vec![validate_endpoint(&provider.api_base_url)?];
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


pub(crate) fn exact_origin(url: &Url, host: &str, port: u16) -> bool {    url.scheme() == "https"
        && url
            .host_str()
            .is_some_and(|value| value.eq_ignore_ascii_case(host))
        && url.port_or_known_default() == Some(port)
}
