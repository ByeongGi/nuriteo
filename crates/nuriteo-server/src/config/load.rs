use std::collections::{BTreeMap, BTreeSet};
use std::env;
use std::ffi::OsString;
use std::fs::File;
use std::io::{self, Read};
use std::path::Path;

use serde::Deserialize;

use super::redaction::SecretString;
use super::schema::*;
use super::validation;
use super::{Config, ConfigError, ConfigWarning, LoadReport, PublicConfig, ServerConfig};

const MAX_FILE_BYTES: usize = 64 * 1024;

/// Injectable source for process configuration variables.
pub trait Environment {
    fn entries(&self) -> Vec<(OsString, OsString)>;
}

/// Production environment source.
#[derive(Debug, Clone, Copy, Default)]
pub struct SystemEnvironment;

impl Environment for SystemEnvironment {
    fn entries(&self) -> Vec<(OsString, OsString)> {
        env::vars_os().collect()
    }
}

/// Injectable bounded file source for configuration and mounted secrets.
pub trait FileReader {
    fn read(&self, path: &Path, limit: usize) -> io::Result<Vec<u8>>;
}

/// Production filesystem reader.
#[derive(Debug, Clone, Copy, Default)]
pub struct SystemFileReader;

impl FileReader for SystemFileReader {
    fn read(&self, path: &Path, limit: usize) -> io::Result<Vec<u8>> {
        let file = File::open(path)?;
        let read_limit = u64::try_from(limit).unwrap_or(u64::MAX).saturating_add(1);
        let mut bytes = Vec::new();
        file.take(read_limit).read_to_end(&mut bytes)?;
        Ok(bytes)
    }
}

pub(super) fn from_sources(
    environment: &impl Environment,
    files: &impl FileReader,
) -> Result<LoadReport, ConfigError> {
    let values = Values::new(environment.entries())?;
    let file_values = load_toml(&values, files)?;
    let strict = resolve(&values, &file_values, STRICT, "true")
        .and_then(|value| validation::boolean(STRICT, &value))?;
    let unknown_names = unknown_names(&values);
    if strict && !unknown_names.is_empty() {
        return Err(ConfigError::Unknown {
            names: unknown_names,
        });
    }
    let warnings = unknown_names
        .into_iter()
        .map(|name| ConfigWarning::UnknownEnvironmentVariable { name })
        .collect();

    let listen_addr = resolve(&values, &file_values, LISTEN_ADDR, "127.0.0.1:8080")
        .and_then(|value| validation::socket_addr(LISTEN_ADDR, &value))?;
    let shutdown_drain_timeout = resolve(&values, &file_values, SHUTDOWN_DRAIN_TIMEOUT_MS, "30000")
        .and_then(|value| validation::drain_timeout(SHUTDOWN_DRAIN_TIMEOUT_MS, &value))?;
    let log_format = resolve(&values, &file_values, LOG_FORMAT, "json")
        .and_then(|value| validation::log_format(LOG_FORMAT, &value))?;
    let log_level = resolve(&values, &file_values, LOG_LEVEL, "info")
        .and_then(|value| validation::log_level(LOG_LEVEL, &value))?;
    let external_url = required(&values, &file_values, EXTERNAL_URL)
        .and_then(|value| validation::external_url(EXTERNAL_URL, &value))?;
    let preview_base_domain = optional(&values, &file_values, PREVIEW_BASE_DOMAIN)?
        .map(|value| validation::preview_domain(PREVIEW_BASE_DOMAIN, &value))
        .transpose()?;
    if preview_base_domain.as_deref() == external_url.host_str() {
        return Err(ConfigError::invalid(
            PREVIEW_BASE_DOMAIN,
            "must be different from the application host",
        ));
    }

    Ok(LoadReport {
        config: Config {
            server: ServerConfig {
                listen_addr,
                shutdown_drain_timeout,
                log_format,
                log_level,
            },
            public: PublicConfig {
                external_url,
                preview_base_domain,
            },
        },
        warnings,
    })
}

struct Values(BTreeMap<String, String>);

impl Values {
    fn new(entries: Vec<(OsString, OsString)>) -> Result<Self, ConfigError> {
        let mut values = BTreeMap::new();
        for (raw_name, raw_value) in entries {
            let Some(name) = raw_name.to_str() else {
                if raw_name.as_encoded_bytes().starts_with(b"NURITEO_") {
                    return Err(ConfigError::NonUnicodeName);
                }
                continue;
            };
            if !name.starts_with("NURITEO_") {
                continue;
            }
            let value = raw_value
                .into_string()
                .map_err(|_| ConfigError::NonUnicodeValue {
                    name: name.to_owned(),
                })?;
            if values.insert(name.to_owned(), value).is_some() {
                return Err(ConfigError::Duplicate {
                    name: name.to_owned(),
                });
            }
        }
        Ok(Self(values))
    }

    fn get(&self, name: &str) -> Option<&str> {
        self.0.get(name).map(String::as_str)
    }
}

fn unknown_names(values: &Values) -> Vec<String> {
    let known: BTreeSet<&str> = CONFIG_FIELDS
        .iter()
        .map(|field| field.environment)
        .collect();
    values
        .0
        .keys()
        .filter(|name| !known.contains(name.as_str()))
        .cloned()
        .collect()
}

fn resolve(
    environment: &Values,
    file: &BTreeMap<&'static str, String>,
    name: &'static str,
    default: &str,
) -> Result<String, ConfigError> {
    let value = environment
        .get(name)
        .map(str::to_owned)
        .or_else(|| file.get(name).cloned())
        .unwrap_or_else(|| default.to_owned());
    non_empty(name, value)
}

fn required(
    environment: &Values,
    file: &BTreeMap<&'static str, String>,
    name: &'static str,
) -> Result<String, ConfigError> {
    environment
        .get(name)
        .map(str::to_owned)
        .or_else(|| file.get(name).cloned())
        .ok_or(ConfigError::Missing { name })
        .and_then(|value| non_empty(name, value))
}

fn optional(
    environment: &Values,
    file: &BTreeMap<&'static str, String>,
    name: &'static str,
) -> Result<Option<String>, ConfigError> {
    environment
        .get(name)
        .map(str::to_owned)
        .or_else(|| file.get(name).cloned())
        .map(|value| non_empty(name, value))
        .transpose()
}

fn non_empty(name: &'static str, value: String) -> Result<String, ConfigError> {
    let trimmed = value.trim();
    if trimmed.is_empty() {
        Err(ConfigError::Empty { name })
    } else {
        Ok(trimmed.to_owned())
    }
}

fn load_toml(
    values: &Values,
    files: &impl FileReader,
) -> Result<BTreeMap<&'static str, String>, ConfigError> {
    let Some(path) = values.get(CONFIG_FILE) else {
        return Ok(BTreeMap::new());
    };
    if path.trim().is_empty() {
        return Err(ConfigError::Empty { name: CONFIG_FILE });
    }
    let bytes = read_bounded(files, Path::new(path), CONFIG_FILE)?;
    let contents =
        std::str::from_utf8(&bytes).map_err(|_| ConfigError::InvalidUtf8 { name: CONFIG_FILE })?;
    let parsed: FileConfig = toml::from_str(contents).map_err(|_| ConfigError::InvalidToml)?;
    Ok(parsed.into_values())
}

fn read_bounded(
    files: &impl FileReader,
    path: &Path,
    name: &'static str,
) -> Result<Vec<u8>, ConfigError> {
    let bytes = files
        .read(path, MAX_FILE_BYTES)
        .map_err(|source| ConfigError::ReadFile {
            name,
            kind: source.kind(),
        })?;
    if bytes.len() > MAX_FILE_BYTES {
        return Err(ConfigError::FileTooLarge {
            name,
            limit: MAX_FILE_BYTES,
        });
    }
    Ok(bytes)
}

/// Loads one explicitly registered secret from either a direct value or a
/// mounted `_FILE` reference. Setting both sources fails closed.
pub fn load_secret(
    environment: &impl Environment,
    files: &impl FileReader,
    direct_name: &'static str,
    file_name: &'static str,
) -> Result<Option<SecretString>, ConfigError> {
    let values = Values::new(environment.entries())?;
    match (values.get(direct_name), values.get(file_name)) {
        (Some(_), Some(_)) => Err(ConfigError::ConflictingSecretSources {
            name: direct_name,
            file_name,
        }),
        (Some(""), None) => Err(ConfigError::Empty { name: direct_name }),
        (Some(value), None) => validate_secret(direct_name, value.as_bytes()).map(Some),
        (None, Some(path)) => {
            if path.trim().is_empty() {
                return Err(ConfigError::Empty { name: file_name });
            }
            let bytes = read_bounded(files, Path::new(path), file_name)?;
            let bytes = remove_one_line_ending(&bytes);
            validate_secret(file_name, bytes).map(Some)
        }
        (None, None) => Ok(None),
    }
}

fn remove_one_line_ending(bytes: &[u8]) -> &[u8] {
    if let Some(without_crlf) = bytes.strip_suffix(b"\r\n") {
        without_crlf
    } else if let Some(without_lf) = bytes.strip_suffix(b"\n") {
        without_lf
    } else {
        bytes
    }
}

fn validate_secret(name: &'static str, bytes: &[u8]) -> Result<SecretString, ConfigError> {
    if bytes.is_empty() {
        return Err(ConfigError::EmptySecretFile { name });
    }
    if bytes.contains(&0) {
        return Err(ConfigError::InvalidSecretFile { name });
    }
    let value = std::str::from_utf8(bytes)
        .map_err(|_| ConfigError::InvalidUtf8 { name })?
        .to_owned();
    Ok(SecretString::new(value))
}

#[derive(Debug, Default, Deserialize)]
#[serde(default, deny_unknown_fields)]
struct FileConfig {
    config: FileConfigSection,
    server: FileServerSection,
    logging: FileLoggingSection,
    public: FilePublicSection,
}

impl FileConfig {
    fn into_values(self) -> BTreeMap<&'static str, String> {
        let mut values = BTreeMap::new();
        insert(&mut values, STRICT, self.config.strict_environment);
        insert(&mut values, LISTEN_ADDR, self.server.listen_address);
        insert(
            &mut values,
            SHUTDOWN_DRAIN_TIMEOUT_MS,
            self.server.shutdown_drain_timeout_ms,
        );
        insert(&mut values, LOG_FORMAT, self.logging.format);
        insert(&mut values, LOG_LEVEL, self.logging.level);
        insert(&mut values, EXTERNAL_URL, self.public.external_url);
        insert(
            &mut values,
            PREVIEW_BASE_DOMAIN,
            self.public.preview_base_domain,
        );
        values
    }
}

fn insert<T: ToString>(
    values: &mut BTreeMap<&'static str, String>,
    name: &'static str,
    value: Option<T>,
) {
    if let Some(value) = value {
        values.insert(name, value.to_string());
    }
}

#[derive(Debug, Default, Deserialize)]
#[serde(default, deny_unknown_fields)]
struct FileConfigSection {
    strict_environment: Option<bool>,
}

#[derive(Debug, Default, Deserialize)]
#[serde(default, deny_unknown_fields)]
struct FileServerSection {
    listen_address: Option<String>,
    shutdown_drain_timeout_ms: Option<u64>,
}

#[derive(Debug, Default, Deserialize)]
#[serde(default, deny_unknown_fields)]
struct FileLoggingSection {
    format: Option<String>,
    level: Option<String>,
}

#[derive(Debug, Default, Deserialize)]
#[serde(default, deny_unknown_fields)]
struct FilePublicSection {
    external_url: Option<String>,
    preview_base_domain: Option<String>,
}
