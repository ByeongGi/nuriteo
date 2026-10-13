use std::collections::{BTreeMap, BTreeSet};
use std::env;
use std::ffi::OsString;
use std::fs::File;
use std::io::{self, Read};
use std::path::Path;
use std::time::Duration;

use serde::Deserialize;
use serde_json::Value;

use super::redaction::SecretString;
use super::schema::*;
use super::validation;
use super::{
    CleanupConfig, Config, ConfigError, ConfigWarning, INSTANCE_SETTING_DEFINITIONS,
    InstanceSettingBootstrap, LoadReport, PublicConfig, ServerConfig, SettingConstraint,
    instance_setting_definition,
};
use crate::save::CleanupWorkerPolicy;

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
    let file = load_toml(&values, files)?;
    let strict = resolve(&values, &file.startup, STRICT, "true")
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

    let listen_addr = resolve(&values, &file.startup, LISTEN_ADDR, "127.0.0.1:8080")
        .and_then(|value| validation::socket_addr(LISTEN_ADDR, &value))?;
    let management_listen_addr = resolve(
        &values,
        &file.startup,
        MANAGEMENT_LISTEN_ADDR,
        "127.0.0.1:9090",
    )
    .and_then(|value| validation::socket_addr(MANAGEMENT_LISTEN_ADDR, &value))?;
    if management_listen_addr == listen_addr {
        return Err(ConfigError::invalid(
            MANAGEMENT_LISTEN_ADDR,
            "must differ from the application listener",
        ));
    }
    let shutdown_drain_timeout =
        resolve(&values, &file.startup, SHUTDOWN_DRAIN_TIMEOUT_MS, "30000")
            .and_then(|value| validation::drain_timeout(SHUTDOWN_DRAIN_TIMEOUT_MS, &value))?;
    let log_format = resolve(&values, &file.startup, LOG_FORMAT, "json")
        .and_then(|value| validation::log_format(LOG_FORMAT, &value))?;
    let log_level = resolve(&values, &file.startup, LOG_LEVEL, "info")
        .and_then(|value| validation::log_level(LOG_LEVEL, &value))?;
    let external_url = required(&values, &file.startup, EXTERNAL_URL)
        .and_then(|value| validation::external_url(EXTERNAL_URL, &value))?;
    let preview_base_domain = optional(&values, &file.startup, PREVIEW_BASE_DOMAIN)?
        .map(|value| validation::preview_domain(PREVIEW_BASE_DOMAIN, &value))
        .transpose()?;
    if preview_base_domain.as_deref() == external_url.host_str() {
        return Err(ConfigError::invalid(
            PREVIEW_BASE_DOMAIN,
            "must be different from the application host",
        ));
    }
    let cleanup = load_cleanup(&values, &file.startup)?;
    let instance_settings = load_instance_setting_bootstrap(&values, file.instance_settings)?;

    Ok(LoadReport {
        config: Config {
            server: ServerConfig {
                listen_addr,
                management_listen_addr,
                shutdown_drain_timeout,
                log_format,
                log_level,
            },
            public: PublicConfig {
                external_url,
                preview_base_domain,
            },
            cleanup,
        },
        instance_settings,
        warnings,
    })
}

fn load_cleanup(
    values: &Values,
    file: &BTreeMap<&'static str, String>,
) -> Result<CleanupConfig, ConfigError> {
    let number = |name, default, minimum, maximum| {
        resolve(values, file, name, default)
            .and_then(|value| validation::bounded_u64(name, &value, minimum, maximum))
    };
    let batch_size = number(CLEANUP_BATCH_SIZE, "32", 1, 100)?;
    let concurrency = number(CLEANUP_CONCURRENCY, "4", 1, 16)?;
    let max_attempts = number(CLEANUP_MAX_ATTEMPTS, "8", 2, 16)?;
    let operation_timeout =
        Duration::from_millis(number(CLEANUP_OPERATION_TIMEOUT_MS, "5000", 100, 30_000)?);
    let item_timeout =
        Duration::from_millis(number(CLEANUP_ITEM_TIMEOUT_MS, "30000", 100, 120_000)?);
    let lease_duration =
        Duration::from_millis(number(CLEANUP_LEASE_DURATION_MS, "360000", 100, 600_000)?);
    let poll_interval =
        Duration::from_millis(number(CLEANUP_POLL_INTERVAL_MS, "2000", 10, 60_000)?);
    let base_backoff =
        Duration::from_millis(number(CLEANUP_BASE_BACKOFF_MS, "2000", 100, 3_600_000)?);
    let max_backoff =
        Duration::from_millis(number(CLEANUP_MAX_BACKOFF_MS, "900000", 100, 86_400_000)?);
    let worker_policy = CleanupWorkerPolicy::new(
        u16::try_from(batch_size).map_err(|_| {
            ConfigError::invalid(CLEANUP_BATCH_SIZE, "is outside the supported range")
        })?,
        u16::try_from(concurrency).map_err(|_| {
            ConfigError::invalid(CLEANUP_CONCURRENCY, "is outside the supported range")
        })?,
        u16::try_from(max_attempts).map_err(|_| {
            ConfigError::invalid(CLEANUP_MAX_ATTEMPTS, "is outside the supported range")
        })?,
        operation_timeout,
        item_timeout,
        lease_duration,
        poll_interval,
        base_backoff,
        max_backoff,
    )
    .map_err(|_| {
        ConfigError::invalid(
            CLEANUP_LEASE_DURATION_MS,
            "does not safely cover the configured cleanup batch",
        )
    })?;
    Ok(CleanupConfig {
        worker_policy,
        stale_threshold: Duration::from_secs(number(
            CLEANUP_STALE_THRESHOLD_SECONDS,
            "900",
            60,
            86_400,
        )?),
        failed_threshold: number(CLEANUP_FAILED_THRESHOLD, "1", 1, 1_000_000)?,
        status_timeout: Duration::from_millis(number(
            CLEANUP_STATUS_TIMEOUT_MS,
            "2000",
            100,
            10_000,
        )?),
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
    let mut known: BTreeSet<&str> = CONFIG_FIELDS
        .iter()
        .map(|field| field.environment)
        .collect();
    known.extend(
        INSTANCE_SETTING_DEFINITIONS
            .iter()
            .map(|definition| definition.bootstrap_environment),
    );
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

fn load_toml(values: &Values, files: &impl FileReader) -> Result<LoadedFile, ConfigError> {
    let Some(path) = values.get(CONFIG_FILE) else {
        return Ok(LoadedFile::default());
    };
    if path.trim().is_empty() {
        return Err(ConfigError::Empty { name: CONFIG_FILE });
    }
    let bytes = read_bounded(files, Path::new(path), CONFIG_FILE)?;
    let contents =
        std::str::from_utf8(&bytes).map_err(|_| ConfigError::InvalidUtf8 { name: CONFIG_FILE })?;
    let parsed: FileConfig = toml::from_str(contents).map_err(|_| ConfigError::InvalidToml)?;
    parsed.into_loaded_file()
}

#[derive(Default)]
struct LoadedFile {
    startup: BTreeMap<&'static str, String>,
    instance_settings: BTreeMap<String, Value>,
}

fn load_instance_setting_bootstrap(
    values: &Values,
    file: BTreeMap<String, Value>,
) -> Result<InstanceSettingBootstrap, ConfigError> {
    let mut environment = BTreeMap::new();
    for definition in INSTANCE_SETTING_DEFINITIONS {
        let Some(raw) = values.get(definition.bootstrap_environment) else {
            continue;
        };
        environment.insert(definition.key.to_owned(), raw.to_owned());
    }
    Ok(InstanceSettingBootstrap::from_raw_sources(
        file,
        environment,
    ))
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
    management: FileManagementSection,
    logging: FileLoggingSection,
    public: FilePublicSection,
    cleanup: FileCleanupSection,
    instance_settings: BTreeMap<String, toml::Value>,
}

impl FileConfig {
    fn into_loaded_file(self) -> Result<LoadedFile, ConfigError> {
        let mut values = BTreeMap::new();
        insert(&mut values, STRICT, self.config.strict_environment);
        insert(&mut values, LISTEN_ADDR, self.server.listen_address);
        insert(
            &mut values,
            MANAGEMENT_LISTEN_ADDR,
            self.management.listen_address,
        );
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
        insert(&mut values, CLEANUP_BATCH_SIZE, self.cleanup.batch_size);
        insert(&mut values, CLEANUP_CONCURRENCY, self.cleanup.concurrency);
        insert(&mut values, CLEANUP_MAX_ATTEMPTS, self.cleanup.max_attempts);
        insert(
            &mut values,
            CLEANUP_OPERATION_TIMEOUT_MS,
            self.cleanup.operation_timeout_ms,
        );
        insert(
            &mut values,
            CLEANUP_ITEM_TIMEOUT_MS,
            self.cleanup.item_timeout_ms,
        );
        insert(
            &mut values,
            CLEANUP_LEASE_DURATION_MS,
            self.cleanup.lease_duration_ms,
        );
        insert(
            &mut values,
            CLEANUP_POLL_INTERVAL_MS,
            self.cleanup.poll_interval_ms,
        );
        insert(
            &mut values,
            CLEANUP_BASE_BACKOFF_MS,
            self.cleanup.base_backoff_ms,
        );
        insert(
            &mut values,
            CLEANUP_MAX_BACKOFF_MS,
            self.cleanup.max_backoff_ms,
        );
        insert(
            &mut values,
            CLEANUP_STALE_THRESHOLD_SECONDS,
            self.cleanup.stale_threshold_seconds,
        );
        insert(
            &mut values,
            CLEANUP_FAILED_THRESHOLD,
            self.cleanup.failed_threshold,
        );
        insert(
            &mut values,
            CLEANUP_STATUS_TIMEOUT_MS,
            self.cleanup.status_timeout_ms,
        );
        let mut instance_settings = BTreeMap::new();
        for (key, value) in self.instance_settings {
            let value = match (
                instance_setting_definition(&key).map(|definition| definition.constraint),
                value.as_str(),
            ) {
                (
                    Some(
                        SettingConstraint::RetentionDays {
                            allow_unlimited: true,
                            ..
                        }
                        | SettingConstraint::OptionalUnsignedInteger { .. },
                    ),
                    Some("unlimited"),
                ) => Value::Null,
                _ => serde_json::to_value(value).map_err(|_| ConfigError::InvalidToml)?,
            };
            instance_settings.insert(key, value);
        }
        Ok(LoadedFile {
            startup: values,
            instance_settings,
        })
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
struct FileManagementSection {
    listen_address: Option<String>,
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

#[derive(Debug, Default, Deserialize)]
#[serde(default, deny_unknown_fields)]
struct FileCleanupSection {
    batch_size: Option<u16>,
    concurrency: Option<u16>,
    max_attempts: Option<u16>,
    operation_timeout_ms: Option<u64>,
    item_timeout_ms: Option<u64>,
    lease_duration_ms: Option<u64>,
    poll_interval_ms: Option<u64>,
    base_backoff_ms: Option<u64>,
    max_backoff_ms: Option<u64>,
    stale_threshold_seconds: Option<u64>,
    failed_threshold: Option<u64>,
    status_timeout_ms: Option<u64>,
}
