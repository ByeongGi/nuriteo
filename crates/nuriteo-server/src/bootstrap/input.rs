use std::collections::BTreeMap;
use std::ffi::OsString;
use std::fmt;
use std::io;
use std::path::{Path, PathBuf};

use crate::config::{Environment, FileReader};

pub(super) const EMAIL: &str = "NURITEO_BOOTSTRAP_ADMIN_EMAIL";
pub(super) const NAME: &str = "NURITEO_BOOTSTRAP_ADMIN_NAME";
pub(super) const PASSWORD: &str = "NURITEO_BOOTSTRAP_ADMIN_PASSWORD";
pub(super) const PASSWORD_FILE: &str = "NURITEO_BOOTSTRAP_ADMIN_PASSWORD_FILE";

const MAX_EMAIL_CHARS: usize = 320;
const MAX_NAME_CHARS: usize = 200;
const MAX_PASSWORD_BYTES: usize = 1024;
const MAX_PASSWORD_FILE_BYTES: usize = MAX_PASSWORD_BYTES + 2;
const MAX_PATH_BYTES: usize = 4096;

pub struct BootstrapAdminInput {
    pub(super) email: String,
    pub(super) normalized_email: String,
    pub(super) display_name: String,
    password: PasswordSource,
}

impl BootstrapAdminInput {
    pub fn load(environment: &impl Environment) -> Result<Self, BootstrapInputError> {
        let values = Values::new(environment.entries())?;
        let email = values.required(EMAIL)?.to_owned();
        let display_name = values.required(NAME)?.to_owned();
        let normalized_email = validate_email(&email)?;
        validate_display_name(&display_name)?;

        let password = match (values.optional(PASSWORD), values.optional(PASSWORD_FILE)) {
            (Some(_), Some(_)) => return Err(BootstrapInputError::AmbiguousPasswordSource),
            (Some(value), None) => {
                if value.is_empty() {
                    return Err(BootstrapInputError::InvalidPassword);
                }
                PasswordSource::Direct(DirectPassword(value.as_bytes().to_vec()))
            }
            (None, Some(path)) => PasswordSource::File(validate_path(path)?),
            (None, None) => return Err(BootstrapInputError::MissingPassword),
        };

        Ok(Self {
            email,
            normalized_email,
            display_name,
            password,
        })
    }

    pub(super) fn load_password(
        &self,
        files: &impl FileReader,
    ) -> Result<PasswordMaterial, BootstrapInputError> {
        let bytes = match &self.password {
            PasswordSource::Direct(value) => value.as_bytes().to_vec(),
            PasswordSource::File(path) => {
                let bytes = files
                    .read(path, MAX_PASSWORD_FILE_BYTES)
                    .map_err(|error| BootstrapInputError::PasswordFile(error.kind()))?;
                if bytes.len() > MAX_PASSWORD_FILE_BYTES {
                    return Err(BootstrapInputError::InvalidPassword);
                }
                remove_one_line_ending(bytes)
            }
        };
        if bytes.is_empty() || bytes.len() > MAX_PASSWORD_BYTES {
            return Err(BootstrapInputError::InvalidPassword);
        }
        Ok(PasswordMaterial(bytes))
    }
}

impl fmt::Debug for BootstrapAdminInput {
    fn fmt(&self, formatter: &mut fmt::Formatter<'_>) -> fmt::Result {
        formatter
            .debug_struct("BootstrapAdminInput")
            .field("email", &"[REDACTED]")
            .field("normalized_email", &"[REDACTED]")
            .field("display_name", &"[REDACTED]")
            .field("password", &"[REDACTED]")
            .finish()
    }
}

enum PasswordSource {
    Direct(DirectPassword),
    File(PathBuf),
}

struct DirectPassword(Vec<u8>);

impl DirectPassword {
    fn as_bytes(&self) -> &[u8] {
        &self.0
    }
}

impl Drop for DirectPassword {
    fn drop(&mut self) {
        self.0.fill(0);
    }
}

pub(super) struct PasswordMaterial(Vec<u8>);

impl PasswordMaterial {
    pub(super) fn as_bytes(&self) -> &[u8] {
        &self.0
    }
}

impl Drop for PasswordMaterial {
    fn drop(&mut self) {
        self.0.fill(0);
    }
}

impl fmt::Debug for PasswordMaterial {
    fn fmt(&self, formatter: &mut fmt::Formatter<'_>) -> fmt::Result {
        formatter.write_str("PasswordMaterial([REDACTED])")
    }
}

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum BootstrapInputError {
    MissingField,
    DuplicateField,
    UnknownField,
    NonUnicode,
    InvalidEmail,
    InvalidDisplayName,
    MissingPassword,
    AmbiguousPasswordSource,
    InvalidPassword,
    PasswordFile(io::ErrorKind),
}

impl fmt::Display for BootstrapInputError {
    fn fmt(&self, formatter: &mut fmt::Formatter<'_>) -> fmt::Result {
        formatter.write_str(match self {
            Self::MissingField => "bootstrap identity input is missing",
            Self::DuplicateField => "bootstrap input is duplicated",
            Self::UnknownField => "bootstrap input contains an unknown field",
            Self::NonUnicode => "bootstrap input is not valid Unicode",
            Self::InvalidEmail => "bootstrap email is invalid",
            Self::InvalidDisplayName => "bootstrap display name is invalid",
            Self::MissingPassword => "bootstrap password source is missing",
            Self::AmbiguousPasswordSource => "bootstrap password source is ambiguous",
            Self::InvalidPassword => "bootstrap password is invalid",
            Self::PasswordFile(_) => "bootstrap password file is unavailable",
        })
    }
}

impl std::error::Error for BootstrapInputError {}

struct Values(BTreeMap<String, String>);

impl Values {
    fn new(entries: Vec<(OsString, OsString)>) -> Result<Self, BootstrapInputError> {
        let mut values = BTreeMap::new();
        for (raw_name, raw_value) in entries {
            let Some(name) = raw_name.to_str() else {
                if raw_name
                    .as_encoded_bytes()
                    .starts_with(b"NURITEO_BOOTSTRAP_")
                {
                    return Err(BootstrapInputError::NonUnicode);
                }
                continue;
            };
            if !name.starts_with("NURITEO_BOOTSTRAP_") {
                continue;
            }
            if ![EMAIL, NAME, PASSWORD, PASSWORD_FILE].contains(&name) {
                return Err(BootstrapInputError::UnknownField);
            }
            let value = raw_value
                .into_string()
                .map_err(|_| BootstrapInputError::NonUnicode)?;
            if values.insert(name.to_owned(), value).is_some() {
                return Err(BootstrapInputError::DuplicateField);
            }
        }
        Ok(Self(values))
    }

    fn required(&self, name: &str) -> Result<&str, BootstrapInputError> {
        self.optional(name)
            .filter(|value| !value.is_empty())
            .ok_or(BootstrapInputError::MissingField)
    }

    fn optional(&self, name: &str) -> Option<&str> {
        self.0.get(name).map(String::as_str)
    }
}

fn validate_email(value: &str) -> Result<String, BootstrapInputError> {
    let count = value.chars().count();
    if value != value.trim_matches(' ')
        || !(3..=MAX_EMAIL_CHARS).contains(&count)
        || value.chars().any(char::is_control)
    {
        return Err(BootstrapInputError::InvalidEmail);
    }
    let normalized = value.to_lowercase();
    if !(3..=MAX_EMAIL_CHARS).contains(&normalized.chars().count()) {
        return Err(BootstrapInputError::InvalidEmail);
    }
    Ok(normalized)
}

fn validate_display_name(value: &str) -> Result<(), BootstrapInputError> {
    let count = value.trim_matches(' ').chars().count();
    if value != value.trim_matches(' ')
        || !(1..=MAX_NAME_CHARS).contains(&count)
        || value.chars().any(char::is_control)
    {
        Err(BootstrapInputError::InvalidDisplayName)
    } else {
        Ok(())
    }
}

fn validate_path(value: &str) -> Result<PathBuf, BootstrapInputError> {
    if value.is_empty()
        || value.len() > MAX_PATH_BYTES
        || value.chars().any(char::is_control)
        || value.as_bytes().contains(&0)
    {
        Err(BootstrapInputError::InvalidPassword)
    } else {
        Ok(Path::new(value).to_owned())
    }
}

fn remove_one_line_ending(mut bytes: Vec<u8>) -> Vec<u8> {
    if bytes.ends_with(b"\r\n") {
        bytes.truncate(bytes.len() - 2);
    } else if bytes.ends_with(b"\n") {
        bytes.truncate(bytes.len() - 1);
    }
    bytes
}
