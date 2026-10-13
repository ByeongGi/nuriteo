use std::collections::BTreeMap;
use std::ffi::OsString;
use std::fmt;
use std::io::Cursor;
use std::net::IpAddr;
use std::path::Path;
use std::str::FromStr;

use rustls_pemfile::Item;
use serde::Serialize;
use url::{Host, Url};
use x509_parser::prelude::{FromDer, X509Certificate};

use crate::config::{Environment, FileReader, SecretString, load_secret};

const ENDPOINT: &str = "NURITEO_S3_ENDPOINT";
const REGION: &str = "NURITEO_S3_REGION";
const BUCKET: &str = "NURITEO_S3_BUCKET";
const ADDRESSING_STYLE: &str = "NURITEO_S3_ADDRESSING_STYLE";
const CREDENTIAL_PROVIDER: &str = "NURITEO_S3_CREDENTIAL_PROVIDER";
const ACCESS_KEY_ID: &str = "NURITEO_S3_ACCESS_KEY_ID";
const ACCESS_KEY_ID_FILE: &str = "NURITEO_S3_ACCESS_KEY_ID_FILE";
const SECRET_ACCESS_KEY: &str = "NURITEO_S3_SECRET_ACCESS_KEY";
const SECRET_ACCESS_KEY_FILE: &str = "NURITEO_S3_SECRET_ACCESS_KEY_FILE";
const SESSION_TOKEN: &str = "NURITEO_S3_SESSION_TOKEN";
const SESSION_TOKEN_FILE: &str = "NURITEO_S3_SESSION_TOKEN_FILE";
const INSTANCE_CA_FILE: &str = "NURITEO_INSTANCE_CA_FILE";
const S3_CA_FILE: &str = "NURITEO_S3_CA_FILE";

const MAX_CA_BUNDLE_BYTES: usize = 1024 * 1024;
const MAX_CA_CERTIFICATES: usize = 64;

const STORAGE_VARIABLES: &[&str] = &[
    ENDPOINT,
    REGION,
    BUCKET,
    ADDRESSING_STYLE,
    CREDENTIAL_PROVIDER,
    ACCESS_KEY_ID,
    ACCESS_KEY_ID_FILE,
    SECRET_ACCESS_KEY,
    SECRET_ACCESS_KEY_FILE,
    SESSION_TOKEN,
    SESSION_TOKEN_FILE,
    INSTANCE_CA_FILE,
    S3_CA_FILE,
];

#[derive(Clone, PartialEq, Eq)]
pub struct ObjectStorageConfig {
    endpoint: Url,
    region: String,
    bucket: String,
    addressing_style: AddressingStyle,
    credential_provider: CredentialProvider,
    tls_trust: TlsTrust,
}

impl ObjectStorageConfig {
    pub fn load(
        environment: &impl Environment,
        files: &impl FileReader,
    ) -> Result<Self, ObjectStorageConfigError> {
        let values = Values::new(environment.entries())?;
        let endpoint = parse_endpoint(values.required(ENDPOINT)?)?;
        let region = parse_region(values.required(REGION)?)?;
        let bucket = parse_bucket(values.required(BUCKET)?)?;
        let addressing_style = parse_addressing_style(values.required(ADDRESSING_STYLE)?)?;
        let credential_provider = load_credentials(&values, environment, files)?;
        let tls_trust = load_tls_trust(&values, files, &endpoint)?;

        Ok(Self {
            endpoint,
            region,
            bucket,
            addressing_style,
            credential_provider,
            tls_trust,
        })
    }

    #[must_use]
    pub const fn endpoint(&self) -> &Url {
        &self.endpoint
    }

    #[must_use]
    pub fn region(&self) -> &str {
        &self.region
    }

    #[must_use]
    pub fn bucket(&self) -> &str {
        &self.bucket
    }

    #[must_use]
    pub const fn addressing_style(&self) -> AddressingStyle {
        self.addressing_style
    }

    #[must_use]
    pub const fn credential_provider(&self) -> &CredentialProvider {
        &self.credential_provider
    }

    #[must_use]
    pub const fn tls_trust(&self) -> &TlsTrust {
        &self.tls_trust
    }

    #[must_use]
    pub fn snapshot(&self) -> ObjectStorageConfigSnapshot {
        ObjectStorageConfigSnapshot {
            endpoint_configured: true,
            region_configured: true,
            bucket_configured: true,
            addressing_style: self.addressing_style,
            credential_provider: self.credential_provider.kind(),
            instance_ca_certificates: self
                .tls_trust
                .instance_ca
                .as_ref()
                .map_or(0, CaBundle::certificate_count),
            integration_ca_certificates: self
                .tls_trust
                .integration_ca
                .as_ref()
                .map_or(0, CaBundle::certificate_count),
        }
    }

    /// Compares the physical S3 endpoint and bucket without exposing either in
    /// diagnostics. Restore uses this to reject the production data plane as a
    /// target even when different credentials were supplied.
    #[must_use]
    pub fn same_target(&self, other: &Self) -> bool {
        self.endpoint == other.endpoint && self.bucket == other.bucket
    }
}

impl fmt::Debug for ObjectStorageConfig {
    fn fmt(&self, formatter: &mut fmt::Formatter<'_>) -> fmt::Result {
        self.snapshot().fmt(formatter)
    }
}

#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize)]
#[serde(rename_all = "kebab-case")]
pub enum AddressingStyle {
    Path,
    VirtualHosted,
}

#[derive(Clone, PartialEq, Eq)]
pub enum CredentialProvider {
    Static(StaticCredentials),
    Workload,
    Default,
}

impl CredentialProvider {
    const fn kind(&self) -> CredentialProviderKind {
        match self {
            Self::Static(_) => CredentialProviderKind::Static,
            Self::Workload => CredentialProviderKind::Workload,
            Self::Default => CredentialProviderKind::Default,
        }
    }
}

impl fmt::Debug for CredentialProvider {
    fn fmt(&self, formatter: &mut fmt::Formatter<'_>) -> fmt::Result {
        formatter
            .debug_struct("CredentialProvider")
            .field("kind", &self.kind())
            .finish_non_exhaustive()
    }
}

#[derive(Clone, PartialEq, Eq)]
pub struct StaticCredentials {
    access_key_id: SecretString,
    secret_access_key: SecretString,
    session_token: Option<SecretString>,
}

impl StaticCredentials {
    #[must_use]
    pub const fn access_key_id(&self) -> &SecretString {
        &self.access_key_id
    }

    #[must_use]
    pub const fn secret_access_key(&self) -> &SecretString {
        &self.secret_access_key
    }

    #[must_use]
    pub const fn session_token(&self) -> Option<&SecretString> {
        self.session_token.as_ref()
    }
}

impl fmt::Debug for StaticCredentials {
    fn fmt(&self, formatter: &mut fmt::Formatter<'_>) -> fmt::Result {
        formatter
            .debug_struct("StaticCredentials")
            .field("access_key_id", &"[REDACTED]")
            .field("secret_access_key", &"[REDACTED]")
            .field("session_token_configured", &self.session_token.is_some())
            .finish()
    }
}

#[derive(Clone, PartialEq, Eq)]
pub struct TlsTrust {
    instance_ca: Option<CaBundle>,
    integration_ca: Option<CaBundle>,
}

impl TlsTrust {
    #[must_use]
    pub const fn uses_system_roots(&self) -> bool {
        true
    }

    #[must_use]
    pub const fn instance_ca(&self) -> Option<&CaBundle> {
        self.instance_ca.as_ref()
    }

    #[must_use]
    pub const fn integration_ca(&self) -> Option<&CaBundle> {
        self.integration_ca.as_ref()
    }
}

impl fmt::Debug for TlsTrust {
    fn fmt(&self, formatter: &mut fmt::Formatter<'_>) -> fmt::Result {
        formatter
            .debug_struct("TlsTrust")
            .field("system_roots", &true)
            .field(
                "instance_ca_certificates",
                &self
                    .instance_ca
                    .as_ref()
                    .map_or(0, CaBundle::certificate_count),
            )
            .field(
                "integration_ca_certificates",
                &self
                    .integration_ca
                    .as_ref()
                    .map_or(0, CaBundle::certificate_count),
            )
            .finish()
    }
}

#[derive(Clone, PartialEq, Eq)]
pub struct CaBundle {
    certificates_der: Vec<Vec<u8>>,
}

impl CaBundle {
    #[must_use]
    pub fn certificate_count(&self) -> usize {
        self.certificates_der.len()
    }

    pub fn certificates_der(&self) -> impl Iterator<Item = &[u8]> {
        self.certificates_der.iter().map(Vec::as_slice)
    }
}

impl fmt::Debug for CaBundle {
    fn fmt(&self, formatter: &mut fmt::Formatter<'_>) -> fmt::Result {
        formatter
            .debug_struct("CaBundle")
            .field("certificate_count", &self.certificate_count())
            .finish_non_exhaustive()
    }
}

#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize)]
#[serde(rename_all = "lowercase")]
pub enum CredentialProviderKind {
    Static,
    Workload,
    Default,
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize)]
pub struct ObjectStorageConfigSnapshot {
    pub endpoint_configured: bool,
    pub region_configured: bool,
    pub bucket_configured: bool,
    pub addressing_style: AddressingStyle,
    pub credential_provider: CredentialProviderKind,
    pub instance_ca_certificates: usize,
    pub integration_ca_certificates: usize,
}

#[derive(Debug, Clone, PartialEq, Eq)]
pub enum ObjectStorageConfigError {
    Missing {
        name: &'static str,
    },
    Empty {
        name: &'static str,
    },
    Duplicate {
        name: &'static str,
    },
    NonUnicode {
        name: &'static str,
    },
    Invalid {
        name: &'static str,
        reason: &'static str,
    },
    Secret {
        name: &'static str,
    },
    UnexpectedStaticCredential {
        provider: &'static str,
    },
    ReadCa {
        name: &'static str,
        kind: std::io::ErrorKind,
    },
    CaBundleTooLarge {
        name: &'static str,
    },
    InvalidCaBundle {
        name: &'static str,
    },
    TooManyCaCertificates {
        name: &'static str,
    },
    InvalidSignedUrl,
}

impl fmt::Display for ObjectStorageConfigError {
    fn fmt(&self, formatter: &mut fmt::Formatter<'_>) -> fmt::Result {
        match self {
            Self::Missing { name } => write!(formatter, "required configuration {name} is missing"),
            Self::Empty { name } => write!(formatter, "configuration {name} must not be empty"),
            Self::Duplicate { name } => write!(formatter, "configuration {name} is duplicated"),
            Self::NonUnicode { name } => {
                write!(formatter, "configuration {name} is not valid Unicode")
            }
            Self::Invalid { name, reason } => write!(formatter, "configuration {name} {reason}"),
            Self::Secret { name } => {
                write!(formatter, "credential configuration {name} is invalid")
            }
            Self::UnexpectedStaticCredential { provider } => write!(
                formatter,
                "static credential inputs are not allowed with the explicit {provider} provider"
            ),
            Self::ReadCa { name, kind } => {
                write!(
                    formatter,
                    "could not read CA bundle referenced by {name}: {kind}"
                )
            }
            Self::CaBundleTooLarge { name } => {
                write!(
                    formatter,
                    "CA bundle referenced by {name} exceeds its size limit"
                )
            }
            Self::InvalidCaBundle { name } => {
                write!(formatter, "CA bundle referenced by {name} is invalid")
            }
            Self::TooManyCaCertificates { name } => write!(
                formatter,
                "CA bundle referenced by {name} contains too many certificates"
            ),
            Self::InvalidSignedUrl => formatter.write_str("signed URL is invalid"),
        }
    }
}

impl std::error::Error for ObjectStorageConfigError {}

struct Values(BTreeMap<&'static str, String>);

impl Values {
    fn new(entries: Vec<(OsString, OsString)>) -> Result<Self, ObjectStorageConfigError> {
        let mut values = BTreeMap::new();
        for (raw_name, raw_value) in entries {
            let Some(name) = raw_name.to_str() else {
                continue;
            };
            let Some(known_name) = STORAGE_VARIABLES
                .iter()
                .copied()
                .find(|known| *known == name)
            else {
                continue;
            };
            let value = raw_value
                .into_string()
                .map_err(|_| ObjectStorageConfigError::NonUnicode { name: known_name })?;
            if values.insert(known_name, value).is_some() {
                return Err(ObjectStorageConfigError::Duplicate { name: known_name });
            }
        }
        Ok(Self(values))
    }

    fn optional(&self, name: &'static str) -> Result<Option<&str>, ObjectStorageConfigError> {
        self.0
            .get(name)
            .map(String::as_str)
            .map(str::trim)
            .map(|value| {
                if value.is_empty() {
                    Err(ObjectStorageConfigError::Empty { name })
                } else {
                    Ok(value)
                }
            })
            .transpose()
    }

    fn required(&self, name: &'static str) -> Result<&str, ObjectStorageConfigError> {
        self.optional(name)?
            .ok_or(ObjectStorageConfigError::Missing { name })
    }

    fn contains_any(&self, names: &[&str]) -> bool {
        names.iter().any(|name| self.0.contains_key(name))
    }
}

fn parse_endpoint(value: &str) -> Result<Url, ObjectStorageConfigError> {
    let url = Url::parse(value).map_err(|_| ObjectStorageConfigError::Invalid {
        name: ENDPOINT,
        reason: "must be a valid URL",
    })?;
    if url.cannot_be_a_base()
        || url.host().is_none()
        || !url.username().is_empty()
        || url.password().is_some()
        || url.path() != "/"
        || url.query().is_some()
        || url.fragment().is_some()
    {
        return Err(ObjectStorageConfigError::Invalid {
            name: ENDPOINT,
            reason: "must be an origin without credentials, path, query, or fragment",
        });
    }
    let is_loopback = url.host().is_some_and(host_is_loopback);
    if url.scheme() != "https" && !(url.scheme() == "http" && is_loopback) {
        return Err(ObjectStorageConfigError::Invalid {
            name: ENDPOINT,
            reason: "must use HTTPS except for a loopback development endpoint",
        });
    }
    Ok(url)
}

fn host_is_loopback(host: Host<&str>) -> bool {
    match host {
        Host::Domain(domain) => domain.eq_ignore_ascii_case("localhost"),
        Host::Ipv4(address) => address.is_loopback(),
        Host::Ipv6(address) => address.is_loopback(),
    }
}

fn parse_region(value: &str) -> Result<String, ObjectStorageConfigError> {
    if value.len() > 63
        || !value
            .bytes()
            .all(|byte| byte.is_ascii_alphanumeric() || matches!(byte, b'-' | b'_'))
    {
        return Err(ObjectStorageConfigError::Invalid {
            name: REGION,
            reason: "must be a 1-63 character region identifier",
        });
    }
    Ok(value.to_owned())
}

fn parse_bucket(value: &str) -> Result<String, ObjectStorageConfigError> {
    let valid = (3..=63).contains(&value.len())
        && value.bytes().all(|byte| {
            byte.is_ascii_lowercase() || byte.is_ascii_digit() || matches!(byte, b'.' | b'-')
        })
        && value
            .as_bytes()
            .first()
            .is_some_and(u8::is_ascii_alphanumeric)
        && value
            .as_bytes()
            .last()
            .is_some_and(u8::is_ascii_alphanumeric)
        && !value.contains("..")
        && IpAddr::from_str(value).is_err();
    if !valid {
        return Err(ObjectStorageConfigError::Invalid {
            name: BUCKET,
            reason: "must be a valid DNS-compatible S3 bucket name",
        });
    }
    Ok(value.to_owned())
}

fn parse_addressing_style(value: &str) -> Result<AddressingStyle, ObjectStorageConfigError> {
    match value {
        "path" => Ok(AddressingStyle::Path),
        "virtual-hosted" => Ok(AddressingStyle::VirtualHosted),
        _ => Err(ObjectStorageConfigError::Invalid {
            name: ADDRESSING_STYLE,
            reason: "must be path or virtual-hosted",
        }),
    }
}

fn load_credentials(
    values: &Values,
    environment: &impl Environment,
    files: &impl FileReader,
) -> Result<CredentialProvider, ObjectStorageConfigError> {
    let provider = values.required(CREDENTIAL_PROVIDER)?;
    match provider {
        "static" => {
            let access_key = secret(environment, files, ACCESS_KEY_ID, ACCESS_KEY_ID_FILE)?;
            let secret_key = secret(
                environment,
                files,
                SECRET_ACCESS_KEY,
                SECRET_ACCESS_KEY_FILE,
            )?;
            let session_token = secret(environment, files, SESSION_TOKEN, SESSION_TOKEN_FILE)?;
            let access_key_id = access_key.ok_or(ObjectStorageConfigError::Missing {
                name: ACCESS_KEY_ID,
            })?;
            let secret_access_key = secret_key.ok_or(ObjectStorageConfigError::Missing {
                name: SECRET_ACCESS_KEY,
            })?;
            Ok(CredentialProvider::Static(StaticCredentials {
                access_key_id,
                secret_access_key,
                session_token,
            }))
        }
        "workload" => {
            if values.contains_any(&[
                ACCESS_KEY_ID,
                ACCESS_KEY_ID_FILE,
                SECRET_ACCESS_KEY,
                SECRET_ACCESS_KEY_FILE,
                SESSION_TOKEN,
                SESSION_TOKEN_FILE,
            ]) {
                return Err(ObjectStorageConfigError::UnexpectedStaticCredential {
                    provider: "workload",
                });
            }
            Ok(CredentialProvider::Workload)
        }
        "default" => {
            if values.contains_any(&[
                ACCESS_KEY_ID,
                ACCESS_KEY_ID_FILE,
                SECRET_ACCESS_KEY,
                SECRET_ACCESS_KEY_FILE,
                SESSION_TOKEN,
                SESSION_TOKEN_FILE,
            ]) {
                return Err(ObjectStorageConfigError::UnexpectedStaticCredential {
                    provider: "default",
                });
            }
            Ok(CredentialProvider::Default)
        }
        _ => Err(ObjectStorageConfigError::Invalid {
            name: CREDENTIAL_PROVIDER,
            reason: "must be static, workload, or default",
        }),
    }
}

fn secret(
    environment: &impl Environment,
    files: &impl FileReader,
    direct_name: &'static str,
    file_name: &'static str,
) -> Result<Option<SecretString>, ObjectStorageConfigError> {
    load_secret(environment, files, direct_name, file_name)
        .map_err(|_| ObjectStorageConfigError::Secret { name: direct_name })
}

fn load_tls_trust(
    values: &Values,
    files: &impl FileReader,
    endpoint: &Url,
) -> Result<TlsTrust, ObjectStorageConfigError> {
    let instance_path = values.optional(INSTANCE_CA_FILE)?;
    let integration_path = values.optional(S3_CA_FILE)?;
    if endpoint.scheme() == "http" && (instance_path.is_some() || integration_path.is_some()) {
        return Err(ObjectStorageConfigError::Invalid {
            name: S3_CA_FILE,
            reason: "cannot be used with an HTTP endpoint",
        });
    }
    Ok(TlsTrust {
        instance_ca: instance_path
            .map(|path| load_ca_bundle(files, Path::new(path), INSTANCE_CA_FILE))
            .transpose()?,
        integration_ca: integration_path
            .map(|path| load_ca_bundle(files, Path::new(path), S3_CA_FILE))
            .transpose()?,
    })
}

fn load_ca_bundle(
    files: &impl FileReader,
    path: &Path,
    name: &'static str,
) -> Result<CaBundle, ObjectStorageConfigError> {
    let bytes = files.read(path, MAX_CA_BUNDLE_BYTES).map_err(|source| {
        ObjectStorageConfigError::ReadCa {
            name,
            kind: source.kind(),
        }
    })?;
    if bytes.len() > MAX_CA_BUNDLE_BYTES {
        return Err(ObjectStorageConfigError::CaBundleTooLarge { name });
    }

    let mut certificates_der = Vec::new();
    for item in rustls_pemfile::read_all(&mut Cursor::new(bytes)) {
        let item = item.map_err(|_| ObjectStorageConfigError::InvalidCaBundle { name })?;
        let Item::X509Certificate(certificate) = item else {
            return Err(ObjectStorageConfigError::InvalidCaBundle { name });
        };
        let (remainder, parsed) = X509Certificate::from_der(certificate.as_ref())
            .map_err(|_| ObjectStorageConfigError::InvalidCaBundle { name })?;
        let is_ca = parsed
            .basic_constraints()
            .map_err(|_| ObjectStorageConfigError::InvalidCaBundle { name })?
            .is_some_and(|constraints| constraints.value.ca);
        if !remainder.is_empty() || !is_ca || !parsed.validity().is_valid() {
            return Err(ObjectStorageConfigError::InvalidCaBundle { name });
        }
        certificates_der.push(certificate.as_ref().to_vec());
        if certificates_der.len() > MAX_CA_CERTIFICATES {
            return Err(ObjectStorageConfigError::TooManyCaCertificates { name });
        }
    }
    if certificates_der.is_empty() {
        return Err(ObjectStorageConfigError::InvalidCaBundle { name });
    }
    Ok(CaBundle { certificates_der })
}
