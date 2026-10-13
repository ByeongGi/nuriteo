use std::fmt;

use rustls_pemfile::Item;
use x509_parser::prelude::parse_x509_certificate;

const MAX_TRUST_BUNDLE_BYTES: usize = 256 * 1024;
const MAX_CLIENT_IDENTITY_BYTES: usize = 256 * 1024;

/// Additional PostgreSQL trust and optional mutual-TLS identity.
///
/// SQLx combines this CA bundle with the native OS trust store enabled by the
/// crate feature set. Instance and database authorities therefore extend,
/// rather than replace, system trust.
#[derive(Clone, Default)]
pub struct DatabaseTlsConfig {
    instance_ca_pem: Option<Vec<u8>>,
    database_ca_pem: Option<Vec<u8>>,
    client_identity: Option<ClientIdentity>,
}

impl DatabaseTlsConfig {
    pub fn verify_full(
        instance_ca_pem: Option<Vec<u8>>,
        database_ca_pem: Option<Vec<u8>>,
        client_identity: Option<ClientIdentity>,
    ) -> Result<Self, TlsConfigError> {
        if let Some(bundle) = &instance_ca_pem {
            validate_ca_bundle(bundle)?;
        }
        if let Some(bundle) = &database_ca_pem {
            validate_ca_bundle(bundle)?;
        }
        if instance_ca_pem.as_ref().map_or(0, Vec::len)
            + database_ca_pem.as_ref().map_or(0, Vec::len)
            > MAX_TRUST_BUNDLE_BYTES
        {
            return Err(TlsConfigError::TrustBundleTooLarge);
        }
        Ok(Self {
            instance_ca_pem,
            database_ca_pem,
            client_identity,
        })
    }

    pub(super) fn combined_ca_bundle(&self) -> Option<Vec<u8>> {
        let mut combined = Vec::new();
        for bundle in [&self.instance_ca_pem, &self.database_ca_pem]
            .into_iter()
            .flatten()
        {
            combined.extend_from_slice(bundle);
            if !bundle.ends_with(b"\n") {
                combined.push(b'\n');
            }
        }
        (!combined.is_empty()).then_some(combined)
    }

    pub(super) const fn client_identity(&self) -> Option<&ClientIdentity> {
        self.client_identity.as_ref()
    }
}

impl fmt::Debug for DatabaseTlsConfig {
    fn fmt(&self, formatter: &mut fmt::Formatter<'_>) -> fmt::Result {
        formatter
            .debug_struct("DatabaseTlsConfig")
            .field("mode", &"verify-full")
            .field("instance_ca_configured", &self.instance_ca_pem.is_some())
            .field("database_ca_configured", &self.database_ca_pem.is_some())
            .field(
                "client_identity_configured",
                &self.client_identity.is_some(),
            )
            .finish()
    }
}

#[derive(Clone)]
pub struct ClientIdentity {
    certificate_pem: Vec<u8>,
    private_key_pem: Vec<u8>,
}

impl ClientIdentity {
    pub fn new(certificate_pem: Vec<u8>, private_key_pem: Vec<u8>) -> Result<Self, TlsConfigError> {
        if certificate_pem.len() + private_key_pem.len() > MAX_CLIENT_IDENTITY_BYTES {
            return Err(TlsConfigError::ClientIdentityTooLarge);
        }
        validate_client_certificates(&certificate_pem)?;
        validate_private_key(&private_key_pem)?;
        Ok(Self {
            certificate_pem,
            private_key_pem,
        })
    }

    pub(super) fn certificate_pem(&self) -> &[u8] {
        &self.certificate_pem
    }

    pub(super) fn private_key_pem(&self) -> &[u8] {
        &self.private_key_pem
    }
}

impl fmt::Debug for ClientIdentity {
    fn fmt(&self, formatter: &mut fmt::Formatter<'_>) -> fmt::Result {
        formatter.write_str("ClientIdentity([REDACTED])")
    }
}

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum TlsConfigError {
    EmptyTrustBundle,
    InvalidTrustBundle,
    NonCaCertificate,
    TrustBundleTooLarge,
    InvalidClientCertificate,
    InvalidClientKey,
    ClientIdentityTooLarge,
}

impl fmt::Display for TlsConfigError {
    fn fmt(&self, formatter: &mut fmt::Formatter<'_>) -> fmt::Result {
        let message = match self {
            Self::EmptyTrustBundle => "trust bundle must contain a CA certificate",
            Self::InvalidTrustBundle => "trust bundle must contain only valid CA certificates",
            Self::NonCaCertificate => "trust bundle contains a non-CA certificate",
            Self::TrustBundleTooLarge => "combined trust bundle exceeds 256 KiB",
            Self::InvalidClientCertificate => "client certificate chain is invalid",
            Self::InvalidClientKey => "client private key is invalid",
            Self::ClientIdentityTooLarge => "client identity exceeds 256 KiB",
        };
        formatter.write_str(message)
    }
}

impl std::error::Error for TlsConfigError {}

fn validate_ca_bundle(bundle: &[u8]) -> Result<(), TlsConfigError> {
    if bundle.is_empty() {
        return Err(TlsConfigError::EmptyTrustBundle);
    }
    let mut remainder = bundle;
    let mut certificate_count = 0_u32;
    while let Some((item, rest)) = rustls_pemfile::read_one_from_slice(remainder)
        .map_err(|_| TlsConfigError::InvalidTrustBundle)?
    {
        remainder = rest;
        let Item::X509Certificate(certificate) = item else {
            return Err(TlsConfigError::InvalidTrustBundle);
        };
        let (trailing, parsed) = parse_x509_certificate(certificate.as_ref())
            .map_err(|_| TlsConfigError::InvalidTrustBundle)?;
        if !trailing.is_empty() {
            return Err(TlsConfigError::InvalidTrustBundle);
        }
        let is_ca = parsed
            .basic_constraints()
            .map_err(|_| TlsConfigError::InvalidTrustBundle)?
            .is_some_and(|constraints| constraints.value.ca);
        if !is_ca {
            return Err(TlsConfigError::NonCaCertificate);
        }
        certificate_count = certificate_count.saturating_add(1);
    }
    if certificate_count == 0 {
        return Err(TlsConfigError::EmptyTrustBundle);
    }
    Ok(())
}

fn validate_client_certificates(bundle: &[u8]) -> Result<(), TlsConfigError> {
    let mut remainder = bundle;
    let mut certificate_count = 0_u32;
    while let Some((item, rest)) = rustls_pemfile::read_one_from_slice(remainder)
        .map_err(|_| TlsConfigError::InvalidClientCertificate)?
    {
        remainder = rest;
        let Item::X509Certificate(certificate) = item else {
            return Err(TlsConfigError::InvalidClientCertificate);
        };
        let (trailing, _) = parse_x509_certificate(certificate.as_ref())
            .map_err(|_| TlsConfigError::InvalidClientCertificate)?;
        if !trailing.is_empty() {
            return Err(TlsConfigError::InvalidClientCertificate);
        }
        certificate_count = certificate_count.saturating_add(1);
    }
    if certificate_count == 0 {
        return Err(TlsConfigError::InvalidClientCertificate);
    }
    Ok(())
}

fn validate_private_key(bundle: &[u8]) -> Result<(), TlsConfigError> {
    let mut remainder = bundle;
    let mut key_count = 0_u32;
    while let Some((item, rest)) = rustls_pemfile::read_one_from_slice(remainder)
        .map_err(|_| TlsConfigError::InvalidClientKey)?
    {
        remainder = rest;
        match item {
            Item::Pkcs1Key(_) | Item::Pkcs8Key(_) | Item::Sec1Key(_) => {
                key_count = key_count.saturating_add(1);
            }
            _ => return Err(TlsConfigError::InvalidClientKey),
        }
    }
    if key_count != 1 {
        return Err(TlsConfigError::InvalidClientKey);
    }
    Ok(())
}
