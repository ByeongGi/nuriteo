//! Fail-closed network preparation for embedded Git smart-HTTP transports.
//!
//! The Git protocol implementation is deliberately kept separate from this
//! boundary. Any production adapter must obtain a [`PreparedGitHttpsTransport`]
//! before it can receive a credential. This prevents a library default from
//! silently enabling proxies, redirects, an unregistered origin, or a private
//! network destination.

use std::fmt;
use std::net::{IpAddr, SocketAddr};
use std::time::Duration;

use reqwest::{Certificate, Client};
use tokio::net::lookup_host;
use tokio::time;
use url::Url;

use crate::git_provider::{GitProviderMetadata, GitProviderState};
use crate::integration::{CaEndpointBinding, IntegrationRepository, ValidatedCaBundle};

use super::GitExecutorError;

const INTEGRATION_TYPE: &str = "git";
const DEFAULT_CONNECT_TIMEOUT: Duration = Duration::from_secs(10);
const DEFAULT_DNS_TIMEOUT: Duration = Duration::from_secs(3);
const MAX_DNS_ADDRESSES: usize = 16;

#[derive(Clone)]
pub struct GitHttpsTransportGuard {
    integrations: IntegrationRepository,
    connect_timeout: Duration,
    dns_timeout: Duration,
    allow_test_addresses: bool,
}

impl fmt::Debug for GitHttpsTransportGuard {
    fn fmt(&self, formatter: &mut fmt::Formatter<'_>) -> fmt::Result {
        formatter
            .debug_struct("GitHttpsTransportGuard")
            .field("connect_timeout", &self.connect_timeout)
            .field("dns_timeout", &self.dns_timeout)
            .finish_non_exhaustive()
    }
}

impl GitHttpsTransportGuard {
    #[must_use]
    pub fn new(integrations: IntegrationRepository) -> Self {
        Self {
            integrations,
            connect_timeout: DEFAULT_CONNECT_TIMEOUT,
            dns_timeout: DEFAULT_DNS_TIMEOUT,
            allow_test_addresses: false,
        }
    }

    /// Resolves and pins an exact registered HTTPS origin, then builds a
    /// no-proxy/no-redirect client using either system roots or the active CA
    /// bundle bound to that provider endpoint.
    pub async fn prepare(
        &self,
        provider: &GitProviderMetadata,
        repository_url: &str,
    ) -> Result<PreparedGitHttpsTransport, GitExecutorError> {
        let repository_url = exact_repository_url(provider, repository_url)?;
        if provider.state != GitProviderState::Active || provider.validated_at.is_none() {
            return Err(GitExecutorError::InvalidRemote);
        }
        let addresses = resolve_checked(
            &provider.canonical_host,
            provider.canonical_port,
            self.allow_test_addresses,
            self.dns_timeout,
        )
        .await?;
        let binding = CaEndpointBinding::new(
            INTEGRATION_TYPE,
            provider.id.to_string(),
            provider.canonical_host.clone(),
            provider.canonical_port,
            "https",
        )
        .map_err(|_| GitExecutorError::InvalidRemote)?;
        let ca = self
            .integrations
            .active_ca_for_endpoint(&binding)
            .await
            .map_err(|_| GitExecutorError::RepositoryUnavailable)?;
        let client = build_client(
            &provider.canonical_host,
            &addresses,
            ca.as_ref(),
            self.connect_timeout,
        )?;
        Ok(PreparedGitHttpsTransport {
            repository_url,
            canonical_host: provider.canonical_host.clone(),
            canonical_port: provider.canonical_port,
            addresses,
            client,
            custom_ca: ca.is_some(),
            custom_ca_pem: ca.as_ref().map(|value| value.pem().to_vec()),
            dns_timeout: self.dns_timeout,
            allow_test_addresses: self.allow_test_addresses,
        })
    }

    #[cfg(test)]
    pub(super) fn allowing_test_addresses(mut self) -> Self {
        self.allow_test_addresses = true;
        self
    }
}

#[derive(Clone)]
pub struct PreparedGitHttpsTransport {
    repository_url: Url,
    canonical_host: String,
    canonical_port: u16,
    addresses: Vec<SocketAddr>,
    client: Client,
    custom_ca: bool,
    custom_ca_pem: Option<Vec<u8>>,
    dns_timeout: Duration,
    allow_test_addresses: bool,
}

impl fmt::Debug for PreparedGitHttpsTransport {
    fn fmt(&self, formatter: &mut fmt::Formatter<'_>) -> fmt::Result {
        formatter
            .debug_struct("PreparedGitHttpsTransport")
            .field("canonical_host", &self.canonical_host)
            .field("canonical_port", &self.canonical_port)
            .field("address_count", &self.addresses.len())
            .field("custom_ca", &self.custom_ca)
            .finish_non_exhaustive()
    }
}

impl PreparedGitHttpsTransport {
    #[must_use]
    pub fn repository_url(&self) -> &Url {
        &self.repository_url
    }

    pub(super) fn custom_ca_pem(&self) -> Option<&[u8]> {
        self.custom_ca_pem.as_deref()
    }

    /// Creates a request only for one of the two smart-HTTP service endpoints
    /// below the prepared repository path. Keeping the client private prevents
    /// a transport adapter from accidentally using its trust configuration for
    /// an unrelated URL.
    pub fn request(
        &self,
        method: reqwest::Method,
        service_url: &str,
    ) -> Result<reqwest::RequestBuilder, GitExecutorError> {
        let service_url = Url::parse(service_url).map_err(|_| GitExecutorError::InvalidRemote)?;
        if !same_origin(&service_url, &self.repository_url)
            || !valid_service_path(&self.repository_url, &service_url)
        {
            return Err(GitExecutorError::InvalidRemote);
        }
        Ok(self.client.request(method, service_url))
    }

    /// Checks a credential callback URL before returning any credential. This
    /// is intentionally exact (including path), so redirects and URL rewrite
    /// hooks cannot expand the credential scope.
    #[must_use]
    pub fn permits_credential_for(&self, callback_url: &str) -> bool {
        Url::parse(callback_url)
            .ok()
            .is_some_and(|candidate| candidate == self.repository_url)
    }

    /// Re-resolves after the operation. A changed answer is treated as a
    /// security failure, including a public-to-private DNS rebinding attempt.
    pub async fn revalidate_dns(&self) -> Result<(), GitExecutorError> {
        let observed = resolve_checked(
            &self.canonical_host,
            self.canonical_port,
            self.allow_test_addresses,
            self.dns_timeout,
        )
        .await?;
        if observed == self.addresses {
            Ok(())
        } else {
            Err(GitExecutorError::InvalidRemote)
        }
    }
}

fn same_origin(left: &Url, right: &Url) -> bool {
    left.scheme() == "https"
        && right.scheme() == "https"
        && left
            .host_str()
            .zip(right.host_str())
            .is_some_and(|(left, right)| left.eq_ignore_ascii_case(right))
        && left.port_or_known_default() == right.port_or_known_default()
        && left.username().is_empty()
        && left.password().is_none()
}

fn valid_service_path(repository: &Url, service: &Url) -> bool {
    if service.fragment().is_some() {
        return false;
    }
    let root = repository.path().trim_end_matches('/');
    let suffix = service.path().strip_prefix(root);
    match suffix {
        Some("/git-upload-pack" | "/git-receive-pack") => service.query().is_none(),
        Some("/info/refs") => matches!(
            service.query(),
            Some("service=git-upload-pack" | "service=git-receive-pack")
        ),
        _ => false,
    }
}

fn exact_repository_url(
    provider: &GitProviderMetadata,
    value: &str,
) -> Result<Url, GitExecutorError> {
    let lower = value.to_ascii_lowercase();
    if lower.contains("/../")
        || lower.contains("/./")
        || lower.contains("%2e")
        || value.len() > 2_048
    {
        return Err(GitExecutorError::InvalidRemote);
    }
    let url = Url::parse(value).map_err(|_| GitExecutorError::InvalidRemote)?;
    if url.scheme() != "https"
        || url
            .host_str()
            .is_none_or(|host| !host.eq_ignore_ascii_case(&provider.canonical_host))
        || url.port_or_known_default() != Some(provider.canonical_port)
        || !url.username().is_empty()
        || url.password().is_some()
        || url.query().is_some()
        || url.fragment().is_some()
        || matches!(url.path(), "" | "/")
    {
        return Err(GitExecutorError::InvalidRemote);
    }
    Ok(url)
}

fn build_client(
    host: &str,
    addresses: &[SocketAddr],
    ca: Option<&ValidatedCaBundle>,
    timeout: Duration,
) -> Result<Client, GitExecutorError> {
    let mut builder = Client::builder()
        .redirect(reqwest::redirect::Policy::none())
        .no_proxy()
        .https_only(true)
        .connect_timeout(timeout)
        .timeout(timeout)
        .resolve_to_addrs(host, addresses);
    if let Some(ca) = ca {
        let certificates =
            Certificate::from_pem_bundle(ca.pem()).map_err(|_| GitExecutorError::InvalidRemote)?;
        builder = builder.tls_certs_only(certificates);
    }
    builder.build().map_err(|_| GitExecutorError::Unavailable)
}

async fn resolve_checked(
    host: &str,
    port: u16,
    allow_test_addresses: bool,
    timeout: Duration,
) -> Result<Vec<SocketAddr>, GitExecutorError> {
    let resolved = time::timeout(timeout, lookup_host((host, port)))
        .await
        .map_err(|_| GitExecutorError::RepositoryUnavailable)?
        .map_err(|_| GitExecutorError::RepositoryUnavailable)?
        .take(MAX_DNS_ADDRESSES + 1);
    let mut addresses: Vec<_> = resolved.collect();
    if addresses.is_empty()
        || addresses.len() > MAX_DNS_ADDRESSES
        || (!allow_test_addresses && addresses.iter().any(|value| !is_public_ip(value.ip())))
    {
        return Err(GitExecutorError::InvalidRemote);
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

#[cfg(test)]
mod tests {
    use super::*;
    use ::time::OffsetDateTime;
    use uuid::Uuid;

    fn provider() -> GitProviderMetadata {
        GitProviderMetadata {
            id: Uuid::now_v7(),
            display_name: "Example".to_owned(),
            kind: crate::git_provider::GitProviderKind::Generic,
            canonical_host: "git.example.test".to_owned(),
            canonical_port: 443,
            api_base_url: "https://git.example.test/api".to_owned(),
            oauth_authorization_url: None,
            oauth_token_url: None,
            oauth_client_id: None,
            state: GitProviderState::Active,
            allows_read: true,
            allows_write: true,
            config_version: 2,
            validated_at: Some(OffsetDateTime::UNIX_EPOCH),
            created_at: OffsetDateTime::UNIX_EPOCH,
            updated_at: OffsetDateTime::UNIX_EPOCH,
        }
    }

    #[test]
    fn repository_url_is_bound_to_the_exact_registered_https_origin() {
        let provider = provider();
        assert!(exact_repository_url(&provider, "https://git.example.test/a/b.git").is_ok());
        for value in [
            "http://git.example.test/a/b.git",
            "https://evil.example/a/b.git",
            "https://git.example.test:444/a/b.git",
            "https://token@git.example.test/a/b.git",
            "https://git.example.test/a/../b.git",
            "https://git.example.test/a/b.git?redirect=https://evil.example",
            "https://git.example.test/",
        ] {
            assert_eq!(
                exact_repository_url(&provider, value),
                Err(GitExecutorError::InvalidRemote),
                "{value}"
            );
        }
    }

    #[test]
    fn address_policy_rejects_internal_special_and_documentation_networks() {
        for value in [
            "0.0.0.0",
            "10.0.0.1",
            "127.0.0.1",
            "169.254.1.1",
            "172.16.0.1",
            "192.168.1.1",
            "100.64.0.1",
            "192.0.2.1",
            "198.51.100.1",
            "203.0.113.1",
            "::1",
            "fc00::1",
            "fe80::1",
            "2001:db8::1",
            "::ffff:127.0.0.1",
        ] {
            assert!(!is_public_ip(value.parse().unwrap()), "{value}");
        }
        for value in ["1.1.1.1", "8.8.8.8", "2606:4700:4700::1111"] {
            assert!(is_public_ip(value.parse().unwrap()), "{value}");
        }
    }

    #[test]
    fn credential_scope_is_exact_and_debug_output_has_no_repository_path() {
        let prepared = PreparedGitHttpsTransport {
            repository_url: Url::parse("https://git.example.test/acme/private.git").unwrap(),
            canonical_host: "git.example.test".to_owned(),
            canonical_port: 443,
            addresses: vec!["127.0.0.1:443".parse().unwrap()],
            client: build_client(
                "git.example.test",
                &["127.0.0.1:443".parse().unwrap()],
                None,
                Duration::from_secs(1),
            )
            .unwrap(),
            custom_ca: false,
            custom_ca_pem: None,
            dns_timeout: Duration::from_secs(1),
            allow_test_addresses: true,
        };
        assert!(prepared.permits_credential_for("https://git.example.test/acme/private.git"));
        assert!(!prepared.permits_credential_for("https://git.example.test/acme/other.git"));
        assert!(!prepared.permits_credential_for("https://evil.example/acme/private.git"));
        assert!(!format!("{prepared:?}").contains("private.git"));
        assert!(
            prepared
                .request(
                    reqwest::Method::GET,
                    "https://git.example.test/acme/private.git/info/refs?service=git-upload-pack",
                )
                .is_ok()
        );
        for service_url in [
            "https://evil.example/acme/private.git/info/refs?service=git-upload-pack",
            "https://git.example.test/acme/other.git/info/refs?service=git-upload-pack",
            "https://git.example.test/acme/private.git/info/refs?service=evil",
            "https://git.example.test/acme/private.git/arbitrary",
        ] {
            assert!(
                prepared.request(reqwest::Method::GET, service_url).is_err(),
                "{service_url}"
            );
        }
    }

    #[test]
    fn test_address_mode_is_not_enabled_by_default() {
        let _method: fn(GitHttpsTransportGuard) -> GitHttpsTransportGuard =
            GitHttpsTransportGuard::allowing_test_addresses;
    }
}
