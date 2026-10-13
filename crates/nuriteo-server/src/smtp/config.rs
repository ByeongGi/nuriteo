use std::collections::BTreeMap;
use std::ffi::OsString;
use std::fmt;
use std::io::Cursor;
use std::path::Path;
use std::time::Duration;

use rustls::pki_types::CertificateDer;
use rustls_pemfile::Item;
use x509_parser::prelude::{FromDer, X509Certificate};

use crate::config::{Environment, FileReader, SecretString, load_secret};
use crate::instance_settings::EffectiveInstanceSettings;
use crate::integration::ValidatedCaBundle;

const HOST: &str = "NURITEO_SMTP_HOST";
const PORT: &str = "NURITEO_SMTP_PORT";
const SECURITY: &str = "NURITEO_SMTP_SECURITY";
const FROM_ADDRESS: &str = "NURITEO_SMTP_FROM_ADDRESS";
const FROM_NAME: &str = "NURITEO_SMTP_FROM_NAME";
const USERNAME: &str = "NURITEO_SMTP_USERNAME";
const USERNAME_FILE: &str = "NURITEO_SMTP_USERNAME_FILE";
const PASSWORD: &str = "NURITEO_SMTP_PASSWORD";
const PASSWORD_FILE: &str = "NURITEO_SMTP_PASSWORD_FILE";
const INSTANCE_CA_FILE: &str = "NURITEO_INSTANCE_CA_FILE";
const SMTP_CA_FILE: &str = "NURITEO_SMTP_CA_FILE";
const PREFLIGHT_TIMEOUT_MS: &str = "NURITEO_SMTP_PREFLIGHT_TIMEOUT_MS";

const MAX_CA_BUNDLE_BYTES: usize = 1024 * 1024;
const MAX_CA_CERTIFICATES: usize = 64;
const MIN_PREFLIGHT_TIMEOUT: Duration = Duration::from_millis(100);
const MAX_PREFLIGHT_TIMEOUT: Duration = Duration::from_secs(30);

const SMTP_VARIABLES: &[&str] = &[
    HOST,
    PORT,
    SECURITY,
    FROM_ADDRESS,
    FROM_NAME,
    USERNAME,
    USERNAME_FILE,
    PASSWORD,
    PASSWORD_FILE,
    INSTANCE_CA_FILE,
    SMTP_CA_FILE,
    PREFLIGHT_TIMEOUT_MS,
];

// The Instance CA is shared by every outbound integration. Its presence alone
// must not turn optional SMTP into a partially configured integration.
const SMTP_ACTIVATION_VARIABLES: &[&str] = &[
    HOST,
    PORT,
    SECURITY,
    FROM_ADDRESS,
    FROM_NAME,
    USERNAME,
    USERNAME_FILE,
    PASSWORD,
    PASSWORD_FILE,
    SMTP_CA_FILE,
    PREFLIGHT_TIMEOUT_MS,
];

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum SmtpSecurity {
    ImplicitTls,
    StartTls,
}

#[derive(Clone, PartialEq, Eq)]
pub struct SmtpCredentials {
    username: SecretString,
    password: SecretString,
}

impl SmtpCredentials {
    #[must_use]
    pub const fn username(&self) -> &SecretString {
        &self.username
    }

    #[must_use]
    pub const fn password(&self) -> &SecretString {
        &self.password
    }
}

impl fmt::Debug for SmtpCredentials {
    fn fmt(&self, formatter: &mut fmt::Formatter<'_>) -> fmt::Result {
        formatter.write_str("SmtpCredentials([REDACTED])")
    }
}

#[derive(Clone, PartialEq, Eq)]
pub struct SmtpTlsTrust {
    instance_ca: Option<CaBundle>,
    integration_ca: Option<CaBundle>,
}

impl SmtpTlsTrust {
    #[must_use]
    pub const fn uses_system_roots(&self) -> bool {
        true
    }

    pub(crate) fn certificates(&self) -> impl Iterator<Item = CertificateDer<'static>> + '_ {
        self.instance_ca
            .iter()
            .chain(self.integration_ca.iter())
            .flat_map(|bundle| bundle.certificates.iter().cloned())
    }

    #[must_use]
    pub fn instance_ca_certificates(&self) -> usize {
        self.instance_ca.as_ref().map_or(0, |bundle| bundle.len())
    }

    #[must_use]
    pub fn integration_ca_certificates(&self) -> usize {
        self.integration_ca
            .as_ref()
            .map_or(0, |bundle| bundle.len())
    }
}

impl fmt::Debug for SmtpTlsTrust {
    fn fmt(&self, formatter: &mut fmt::Formatter<'_>) -> fmt::Result {
        formatter
            .debug_struct("SmtpTlsTrust")
            .field("system_roots", &true)
            .field("instance_ca_certificates", &self.instance_ca_certificates())
            .field(
                "integration_ca_certificates",
                &self.integration_ca_certificates(),
            )
            .finish()
    }
}

#[derive(Clone, PartialEq, Eq)]
struct CaBundle {
    certificates: Vec<CertificateDer<'static>>,
}

impl CaBundle {
    fn len(&self) -> usize {
        self.certificates.len()
    }
}

#[derive(Clone, PartialEq, Eq)]
pub struct SmtpConfig {
    host: String,
    port: u16,
    security: SmtpSecurity,
    from_address: String,
    from_name: String,
    credentials: Option<SmtpCredentials>,
    tls_trust: SmtpTlsTrust,
    preflight_timeout: Duration,
}

/// Deployment-file compatibility input for the standalone bootstrap/preflight
/// command. It cannot construct a runtime sender; application delivery must use
/// `IntegrationRepository::smtp_config`.
#[derive(Clone, PartialEq, Eq)]
pub struct SmtpBootstrapConfig(SmtpConfig);

impl SmtpBootstrapConfig {
    pub fn load(
        environment: &impl Environment,
        files: &impl FileReader,
    ) -> Result<Option<Self>, SmtpConfigError> {
        SmtpConfig::load(environment, files).map(|config| config.map(Self))
    }

    pub(crate) const fn as_config(&self) -> &SmtpConfig {
        &self.0
    }

    #[must_use]
    pub fn snapshot(&self) -> SmtpConfigSnapshot {
        self.0.snapshot()
    }
}

impl fmt::Debug for SmtpBootstrapConfig {
    fn fmt(&self, formatter: &mut fmt::Formatter<'_>) -> fmt::Result {
        formatter
            .debug_tuple("SmtpBootstrapConfig")
            .field(&self.snapshot())
            .finish()
    }
}

#[derive(Debug, Clone, PartialEq, Eq)]
pub struct SmtpPublicSettings {
    host: String,
    port: u16,
    security: SmtpSecurity,
    from_address: String,
    from_name: String,
    preflight_timeout: Duration,
}

impl SmtpPublicSettings {
    pub fn from_effective(
        settings: &EffectiveInstanceSettings,
    ) -> Result<Option<Self>, SmtpConfigError> {
        let enabled = effective_value(settings, "smtp.enabled")?
            .as_bool()
            .ok_or(SmtpConfigError::InvalidEffectiveSettings)?;
        if !enabled {
            return Ok(None);
        }
        let host = effective_value(settings, "smtp.host")?
            .as_str()
            .ok_or(SmtpConfigError::InvalidEffectiveSettings)
            .and_then(parse_host)?;
        let port = effective_value(settings, "smtp.port")?
            .as_u64()
            .and_then(|value| u16::try_from(value).ok())
            .filter(|value| *value != 0)
            .ok_or(SmtpConfigError::InvalidEffectiveSettings)?;
        let security = effective_value(settings, "smtp.security")?
            .as_str()
            .ok_or(SmtpConfigError::InvalidEffectiveSettings)
            .and_then(parse_security)?;
        let from_address = effective_value(settings, "smtp.from_address")?
            .as_str()
            .ok_or(SmtpConfigError::InvalidEffectiveSettings)
            .and_then(parse_email_address)?;
        let from_name = effective_value(settings, "smtp.from_name")?
            .as_str()
            .ok_or(SmtpConfigError::InvalidEffectiveSettings)
            .and_then(parse_display_name)?;
        let timeout_ms = effective_value(settings, "smtp.preflight_timeout_ms")?
            .as_u64()
            .ok_or(SmtpConfigError::InvalidEffectiveSettings)?;
        let preflight_timeout = parse_timeout(&timeout_ms.to_string())?;
        Ok(Some(Self {
            host,
            port,
            security,
            from_address,
            from_name,
            preflight_timeout,
        }))
    }

    #[must_use]
    pub fn host(&self) -> &str {
        &self.host
    }

    #[must_use]
    pub const fn port(&self) -> u16 {
        self.port
    }

    #[must_use]
    pub const fn security(&self) -> SmtpSecurity {
        self.security
    }
}

impl SmtpConfig {
    pub(crate) fn with_integration_ca(
        &self,
        bundle: &ValidatedCaBundle,
    ) -> Result<Self, SmtpConfigError> {
        let mut value = self.clone();
        value.tls_trust.integration_ca = Some(parse_ca_bundle(bundle.pem(), SMTP_CA_FILE)?);
        Ok(value)
    }

    pub(crate) fn load(
        environment: &impl Environment,
        files: &impl FileReader,
    ) -> Result<Option<Self>, SmtpConfigError> {
        let values = Values::new(environment.entries())?;
        if !values.contains_any(SMTP_ACTIVATION_VARIABLES) {
            return Ok(None);
        }

        let public = SmtpPublicSettings {
            host: parse_host(values.required(HOST)?)?,
            port: parse_port(values.required(PORT)?)?,
            security: parse_security(values.required(SECURITY)?)?,
            from_address: values
                .optional(FROM_ADDRESS)?
                .map(parse_email_address)
                .transpose()?
                .unwrap_or_else(|| "noreply@localhost".to_owned()),
            from_name: values
                .optional(FROM_NAME)?
                .map(parse_display_name)
                .transpose()?
                .unwrap_or_else(|| "NURITEO".to_owned()),
            preflight_timeout: values
                .optional(PREFLIGHT_TIMEOUT_MS)?
                .map(parse_timeout)
                .transpose()?
                .unwrap_or(Duration::from_secs(5)),
        };
        Self::finish(public, &values, environment, files).map(Some)
    }

    pub(crate) fn from_effective_settings_with_database_sources(
        settings: &EffectiveInstanceSettings,
        environment: &impl Environment,
        files: &impl FileReader,
        database_ca: Option<&ValidatedCaBundle>,
        database_credentials: Option<(&str, &str)>,
    ) -> Result<Option<Self>, SmtpConfigError> {
        let Some(public) = SmtpPublicSettings::from_effective(settings)? else {
            return Ok(None);
        };
        let values = Values::new(environment.entries())?;
        Self::finish_with_database_ca(
            public,
            &values,
            environment,
            files,
            database_ca,
            database_credentials,
        )
        .map(Some)
    }

    fn finish(
        public: SmtpPublicSettings,
        values: &Values,
        environment: &impl Environment,
        files: &impl FileReader,
    ) -> Result<Self, SmtpConfigError> {
        Self::finish_with_database_ca(public, values, environment, files, None, None)
    }

    fn finish_with_database_ca(
        public: SmtpPublicSettings,
        values: &Values,
        environment: &impl Environment,
        files: &impl FileReader,
        database_ca: Option<&ValidatedCaBundle>,
        database_credentials: Option<(&str, &str)>,
    ) -> Result<Self, SmtpConfigError> {
        let credentials = match database_credentials {
            Some((username, password)) => Some(SmtpCredentials {
                username: SecretString::new(username.to_owned()),
                password: SecretString::new(password.to_owned()),
            }),
            None => {
                let username = secret(environment, files, USERNAME, USERNAME_FILE)?;
                let password = secret(environment, files, PASSWORD, PASSWORD_FILE)?;
                match (username, password) {
                    (None, None) => None,
                    (Some(username), Some(password)) => {
                        Some(SmtpCredentials { username, password })
                    }
                    _ => return Err(SmtpConfigError::IncompleteCredentials),
                }
            }
        };
        let tls_trust = SmtpTlsTrust {
            instance_ca: values
                .optional(INSTANCE_CA_FILE)?
                .map(|path| load_ca_bundle(files, Path::new(path), INSTANCE_CA_FILE))
                .transpose()?,
            integration_ca: match database_ca {
                Some(bundle) => Some(parse_ca_bundle(bundle.pem(), SMTP_CA_FILE)?),
                None => values
                    .optional(SMTP_CA_FILE)?
                    .map(|path| load_ca_bundle(files, Path::new(path), SMTP_CA_FILE))
                    .transpose()?,
            },
        };

        Ok(Self {
            host: public.host,
            port: public.port,
            security: public.security,
            from_address: public.from_address,
            from_name: public.from_name,
            credentials,
            tls_trust,
            preflight_timeout: public.preflight_timeout,
        })
    }

    #[must_use]
    pub fn host(&self) -> &str {
        &self.host
    }

    #[must_use]
    pub const fn port(&self) -> u16 {
        self.port
    }

    #[must_use]
    pub const fn security(&self) -> SmtpSecurity {
        self.security
    }

    #[must_use]
    pub fn from_address(&self) -> &str {
        &self.from_address
    }

    #[must_use]
    pub fn from_name(&self) -> &str {
        &self.from_name
    }

    #[must_use]
    pub const fn credentials(&self) -> Option<&SmtpCredentials> {
        self.credentials.as_ref()
    }

    #[must_use]
    pub const fn tls_trust(&self) -> &SmtpTlsTrust {
        &self.tls_trust
    }

    #[must_use]
    pub const fn preflight_timeout(&self) -> Duration {
        self.preflight_timeout
    }

    #[must_use]
    pub fn snapshot(&self) -> SmtpConfigSnapshot {
        SmtpConfigSnapshot {
            host_configured: true,
            port: self.port,
            security: self.security,
            authentication_configured: self.credentials.is_some(),
            sender_configured: true,
            system_roots: true,
            instance_ca_certificates: self.tls_trust.instance_ca_certificates(),
            integration_ca_certificates: self.tls_trust.integration_ca_certificates(),
            preflight_timeout_ms: self.preflight_timeout.as_millis() as u64,
        }
    }
}

impl fmt::Debug for SmtpConfig {
    fn fmt(&self, formatter: &mut fmt::Formatter<'_>) -> fmt::Result {
        self.snapshot().fmt(formatter)
    }
}

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub struct SmtpConfigSnapshot {
    pub host_configured: bool,
    pub port: u16,
    pub security: SmtpSecurity,
    pub authentication_configured: bool,
    pub sender_configured: bool,
    pub system_roots: bool,
    pub instance_ca_certificates: usize,
    pub integration_ca_certificates: usize,
    pub preflight_timeout_ms: u64,
}

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum SmtpConfigError {
    Duplicate {
        name: &'static str,
    },
    Missing {
        name: &'static str,
    },
    Empty {
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
    IncompleteCredentials,
    ReadCa {
        name: &'static str,
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
    InvalidEffectiveSettings,
}

impl fmt::Display for SmtpConfigError {
    fn fmt(&self, formatter: &mut fmt::Formatter<'_>) -> fmt::Result {
        match self {
            Self::Duplicate { name } => {
                write!(formatter, "configuration {name} is set more than once")
            }
            Self::Missing { name } => write!(formatter, "required configuration {name} is missing"),
            Self::Empty { name } => write!(formatter, "configuration {name} must not be empty"),
            Self::NonUnicode { name } => {
                write!(formatter, "configuration {name} is not valid Unicode")
            }
            Self::Invalid { name, reason } => write!(formatter, "configuration {name} {reason}"),
            Self::Secret { name } => {
                write!(formatter, "credential configuration {name} is invalid")
            }
            Self::IncompleteCredentials => {
                formatter.write_str("SMTP username and password must be configured together")
            }
            Self::ReadCa { name } => {
                write!(formatter, "could not read CA bundle referenced by {name}")
            }
            Self::CaBundleTooLarge { name } => write!(
                formatter,
                "CA bundle referenced by {name} exceeds its size limit"
            ),
            Self::InvalidCaBundle { name } => {
                write!(formatter, "CA bundle referenced by {name} is invalid")
            }
            Self::TooManyCaCertificates { name } => write!(
                formatter,
                "CA bundle referenced by {name} contains too many certificates"
            ),
            Self::InvalidEffectiveSettings => {
                formatter.write_str("effective SMTP settings are incomplete or invalid")
            }
        }
    }
}

impl std::error::Error for SmtpConfigError {}

fn effective_value<'a>(
    settings: &'a EffectiveInstanceSettings,
    key: &str,
) -> Result<&'a serde_json::Value, SmtpConfigError> {
    settings
        .get(key)
        .map(|setting| setting.value())
        .ok_or(SmtpConfigError::InvalidEffectiveSettings)
}

struct Values(BTreeMap<&'static str, String>);

impl Values {
    fn new(entries: Vec<(OsString, OsString)>) -> Result<Self, SmtpConfigError> {
        let mut values = BTreeMap::new();
        for (raw_name, raw_value) in entries {
            let Some(name) = raw_name.to_str() else {
                continue;
            };
            let Some(known) = SMTP_VARIABLES.iter().copied().find(|known| *known == name) else {
                continue;
            };
            let value = raw_value
                .into_string()
                .map_err(|_| SmtpConfigError::NonUnicode { name: known })?;
            if values.insert(known, value).is_some() {
                return Err(SmtpConfigError::Duplicate { name: known });
            }
        }
        Ok(Self(values))
    }

    fn optional(&self, name: &'static str) -> Result<Option<&str>, SmtpConfigError> {
        self.0
            .get(name)
            .map(String::as_str)
            .map(str::trim)
            .map(|value| {
                if value.is_empty() {
                    Err(SmtpConfigError::Empty { name })
                } else {
                    Ok(value)
                }
            })
            .transpose()
    }

    fn required(&self, name: &'static str) -> Result<&str, SmtpConfigError> {
        self.optional(name)?
            .ok_or(SmtpConfigError::Missing { name })
    }

    fn contains_any(&self, names: &[&str]) -> bool {
        names.iter().any(|name| self.0.contains_key(name))
    }
}

fn parse_host(value: &str) -> Result<String, SmtpConfigError> {
    let valid = value.len() <= 253
        && !value.starts_with('.')
        && !value.ends_with('.')
        && value.split('.').all(|label| {
            !label.is_empty()
                && label.len() <= 63
                && !label.starts_with('-')
                && !label.ends_with('-')
                && label
                    .bytes()
                    .all(|byte| byte.is_ascii_alphanumeric() || byte == b'-')
        });
    if !valid {
        return Err(SmtpConfigError::Invalid {
            name: HOST,
            reason: "must be a valid ASCII DNS hostname",
        });
    }
    Ok(value.to_ascii_lowercase())
}

fn parse_port(value: &str) -> Result<u16, SmtpConfigError> {
    value
        .parse::<u16>()
        .ok()
        .filter(|port| *port != 0)
        .ok_or(SmtpConfigError::Invalid {
            name: PORT,
            reason: "must be an integer from 1 through 65535",
        })
}

fn parse_security(value: &str) -> Result<SmtpSecurity, SmtpConfigError> {
    match value {
        "implicit-tls" => Ok(SmtpSecurity::ImplicitTls),
        "starttls" => Ok(SmtpSecurity::StartTls),
        _ => Err(SmtpConfigError::Invalid {
            name: SECURITY,
            reason: "must be implicit-tls or starttls",
        }),
    }
}

fn parse_email_address(value: &str) -> Result<String, SmtpConfigError> {
    let Some((local, domain)) = value.rsplit_once('@') else {
        return Err(SmtpConfigError::Invalid {
            name: FROM_ADDRESS,
            reason: "must be a valid email address",
        });
    };
    let valid = !local.is_empty()
        && local.len() <= 64
        && value.len() <= 320
        && !local.chars().any(char::is_control)
        && !local.chars().any(char::is_whitespace)
        && parse_host(domain).is_ok();
    if !valid {
        return Err(SmtpConfigError::Invalid {
            name: FROM_ADDRESS,
            reason: "must be a valid email address",
        });
    }
    Ok(value.to_owned())
}

fn parse_display_name(value: &str) -> Result<String, SmtpConfigError> {
    if value.is_empty() || value.len() > 120 || value.chars().any(char::is_control) {
        return Err(SmtpConfigError::Invalid {
            name: FROM_NAME,
            reason: "must be 1-120 bytes without control characters",
        });
    }
    Ok(value.to_owned())
}

fn parse_timeout(value: &str) -> Result<Duration, SmtpConfigError> {
    let timeout = value
        .parse::<u64>()
        .ok()
        .map(Duration::from_millis)
        .filter(|value| (MIN_PREFLIGHT_TIMEOUT..=MAX_PREFLIGHT_TIMEOUT).contains(value))
        .ok_or(SmtpConfigError::Invalid {
            name: PREFLIGHT_TIMEOUT_MS,
            reason: "must be an integer from 100 through 30000",
        })?;
    Ok(timeout)
}

fn secret(
    environment: &impl Environment,
    files: &impl FileReader,
    direct_name: &'static str,
    file_name: &'static str,
) -> Result<Option<SecretString>, SmtpConfigError> {
    load_secret(environment, files, direct_name, file_name)
        .map_err(|_| SmtpConfigError::Secret { name: direct_name })
}

fn load_ca_bundle(
    files: &impl FileReader,
    path: &Path,
    name: &'static str,
) -> Result<CaBundle, SmtpConfigError> {
    let bytes = files
        .read(path, MAX_CA_BUNDLE_BYTES)
        .map_err(|_| SmtpConfigError::ReadCa { name })?;
    if bytes.len() > MAX_CA_BUNDLE_BYTES {
        return Err(SmtpConfigError::CaBundleTooLarge { name });
    }
    parse_ca_bundle(&bytes, name)
}

fn parse_ca_bundle(bytes: &[u8], name: &'static str) -> Result<CaBundle, SmtpConfigError> {
    let mut certificates = Vec::new();
    for item in rustls_pemfile::read_all(&mut Cursor::new(bytes)) {
        let item = item.map_err(|_| SmtpConfigError::InvalidCaBundle { name })?;
        let Item::X509Certificate(certificate) = item else {
            return Err(SmtpConfigError::InvalidCaBundle { name });
        };
        let (remainder, parsed) = X509Certificate::from_der(certificate.as_ref())
            .map_err(|_| SmtpConfigError::InvalidCaBundle { name })?;
        let is_ca = parsed
            .basic_constraints()
            .map_err(|_| SmtpConfigError::InvalidCaBundle { name })?
            .is_some_and(|constraints| constraints.value.ca);
        if !remainder.is_empty() || !is_ca || !parsed.validity().is_valid() {
            return Err(SmtpConfigError::InvalidCaBundle { name });
        }
        certificates.push(certificate);
        if certificates.len() > MAX_CA_CERTIFICATES {
            return Err(SmtpConfigError::TooManyCaCertificates { name });
        }
    }
    if certificates.is_empty() {
        return Err(SmtpConfigError::InvalidCaBundle { name });
    }
    Ok(CaBundle { certificates })
}
