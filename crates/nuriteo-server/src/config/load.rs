use std::collections::{BTreeMap, BTreeSet};
use std::env;
use std::ffi::OsString;
use std::fs;
use std::io;
use std::path::Path;

use super::redaction::SecretString;
use super::schema::*;
use super::validation;
use super::{
    Config, ConfigError, CryptoConfig, DatabaseConfig, ObjectStorageConfig, PublicConfig,
    ServerConfig,
};

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

/// Injectable source for secret-file contents.
pub trait FileReader {
    fn read_to_string(&self, path: &Path) -> io::Result<String>;
}

/// Production filesystem reader.
#[derive(Debug, Clone, Copy, Default)]
pub struct SystemFileReader;

impl FileReader for SystemFileReader {
    fn read_to_string(&self, path: &Path) -> io::Result<String> {
        fs::read_to_string(path)
    }
}

pub(super) fn from_sources(
    environment: &impl Environment,
    files: &impl FileReader,
) -> Result<Config, ConfigError> {
    let values = Values::new(environment.entries())?;
    let strict =
        optional(&values, STRICT, "true").and_then(|value| validation::boolean(STRICT, value))?;
    if strict {
        reject_unknown_names(&values)?;
    }

    let listen_addr = optional(&values, LISTEN_ADDR, "0.0.0.0:8080")
        .and_then(|value| validation::socket_addr(LISTEN_ADDR, value))?;
    let log_format = optional(&values, LOG_FORMAT, "json")
        .and_then(|value| validation::log_format(LOG_FORMAT, value))?;
    let log_level = optional(&values, LOG_LEVEL, "info")
        .and_then(|value| validation::log_level(LOG_LEVEL, value))?;
    let external_url = validation::external_url(EXTERNAL_URL, required(&values, EXTERNAL_URL)?)?;
    let preview_base_domain =
        validation::preview_domain(PREVIEW_BASE_DOMAIN, required(&values, PREVIEW_BASE_DOMAIN)?)?;
    if external_url.host_str() == Some(preview_base_domain.as_str()) {
        return Err(ConfigError::invalid(
            PREVIEW_BASE_DOMAIN,
            "must be different from the application host",
        ));
    }

    let database_url = secret_pair(&values, files, DATABASE_URL, DATABASE_URL_FILE)?;
    validation::database_url(DATABASE_URL, database_url.expose_secret())?;

    let endpoint = validation::endpoint_url(S3_ENDPOINT, required(&values, S3_ENDPOINT)?)?;
    let region = validation::region(S3_REGION, required(&values, S3_REGION)?)?;
    let bucket = validation::bucket(S3_BUCKET, required(&values, S3_BUCKET)?)?;
    let path_style = optional(&values, S3_PATH_STYLE, "false")
        .and_then(|value| validation::boolean(S3_PATH_STYLE, value))?;
    let access_key_id = secret_pair(&values, files, S3_ACCESS_KEY_ID, S3_ACCESS_KEY_ID_FILE)?;
    let secret_access_key = secret_pair(
        &values,
        files,
        S3_SECRET_ACCESS_KEY,
        S3_SECRET_ACCESS_KEY_FILE,
    )?;

    let master_key = secret_file(&values, files, MASTER_KEY_FILE)?;
    validate_key(MASTER_KEY_FILE, &master_key)?;
    let session_key = secret_file(&values, files, SESSION_KEY_FILE)?;
    validate_key(SESSION_KEY_FILE, &session_key)?;
    if master_key == session_key {
        return Err(ConfigError::invalid(
            SESSION_KEY_FILE,
            "must not reuse the master key",
        ));
    }

    Ok(Config {
        server: ServerConfig {
            listen_addr,
            log_format,
            log_level,
        },
        public: PublicConfig {
            external_url,
            preview_base_domain,
        },
        database: DatabaseConfig { url: database_url },
        object_storage: ObjectStorageConfig {
            endpoint,
            region,
            bucket,
            path_style,
            access_key_id,
            secret_access_key,
        },
        crypto: CryptoConfig {
            master_key,
            session_key,
        },
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

fn reject_unknown_names(values: &Values) -> Result<(), ConfigError> {
    let known: BTreeSet<&str> = CONFIG_FIELDS.iter().map(|field| field.name).collect();
    let names: Vec<String> = values
        .0
        .keys()
        .filter(|name| !known.contains(name.as_str()))
        .cloned()
        .collect();
    if names.is_empty() {
        Ok(())
    } else {
        Err(ConfigError::Unknown { names })
    }
}

fn optional<'a>(
    values: &'a Values,
    name: &'static str,
    default: &'a str,
) -> Result<&'a str, ConfigError> {
    let value = values.get(name).unwrap_or(default).trim();
    if value.is_empty() {
        Err(ConfigError::Empty { name })
    } else {
        Ok(value)
    }
}

fn required<'a>(values: &'a Values, name: &'static str) -> Result<&'a str, ConfigError> {
    values
        .get(name)
        .ok_or(ConfigError::Missing { name })
        .and_then(|value| {
            let value = value.trim();
            if value.is_empty() {
                Err(ConfigError::Empty { name })
            } else {
                Ok(value)
            }
        })
}

fn secret_pair(
    values: &Values,
    files: &impl FileReader,
    direct_name: &'static str,
    file_name: &'static str,
) -> Result<SecretString, ConfigError> {
    match (values.get(direct_name), values.get(file_name)) {
        (Some(_), Some(_)) => Err(ConfigError::ConflictingSources {
            name: direct_name,
            file_name,
        }),
        (Some(""), None) => Err(ConfigError::Empty { name: direct_name }),
        (Some(value), None) => Ok(SecretString::new(value.to_owned())),
        (None, Some(_)) => secret_file(values, files, file_name),
        (None, None) => Err(ConfigError::Missing { name: direct_name }),
    }
}

fn secret_file(
    values: &Values,
    files: &impl FileReader,
    name: &'static str,
) -> Result<SecretString, ConfigError> {
    let path = required(values, name)?;
    let value =
        files
            .read_to_string(Path::new(path))
            .map_err(|source| ConfigError::ReadSecret {
                name,
                kind: source.kind(),
            })?;
    let value = value.trim_end_matches(['\r', '\n']);
    if value.is_empty() {
        Err(ConfigError::EmptySecretFile { name })
    } else {
        Ok(SecretString::new(value.to_owned()))
    }
}

fn validate_key(name: &'static str, key: &SecretString) -> Result<(), ConfigError> {
    if key.expose_secret().len() < 32 {
        Err(ConfigError::invalid(name, "must contain at least 32 bytes"))
    } else {
        Ok(())
    }
}
