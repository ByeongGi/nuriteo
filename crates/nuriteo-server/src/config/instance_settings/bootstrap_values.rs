#![allow(unused_imports)]
use super::*;
use std::collections::BTreeMap;

use std::fmt;


use serde_json::Value;
use super::{INSTANCE_SETTING_REGISTRY_VERSION, SettingApplyMode, SettingSensitivity, SettingConstraint, InstanceSettingDefinition, InstanceSettingValidationError, MFA_ENFORCEMENT, RUNTIME_NETWORK, SMTP_SECURITY, unsigned, policy_unsigned, policy_boolean, INSTANCE_SETTING_DEFINITIONS, instance_setting_definition, BootstrapSettingOrigin, InstanceSettingBootstrap, BootstrapEnvironmentValue, InstanceSettingBootstrapError};



impl super::InstanceSettingDefinition {
    /// Validates decoded JSON without ever rendering the supplied value in an error.
    pub fn validate(&self, value: &Value) -> Result<(), InstanceSettingValidationError> {
        let valid = match self.constraint {
            SettingConstraint::Boolean => value.is_boolean(),
            SettingConstraint::UnsignedInteger { minimum, maximum } => value
                .as_u64()
                .is_some_and(|number| (minimum..=maximum).contains(&number)),
            SettingConstraint::OptionalUnsignedInteger { minimum, maximum } => {
                value.is_null()
                    || value
                        .as_u64()
                        .is_some_and(|number| (minimum..=maximum).contains(&number))
            }
            SettingConstraint::Enumeration { allowed } => value
                .as_str()
                .is_some_and(|candidate| allowed.contains(&candidate)),
            SettingConstraint::RetentionDays {
                minimum,
                maximum,
                allow_unlimited,
            } => {
                (allow_unlimited && value.is_null())
                    || value
                        .as_u64()
                        .is_some_and(|days| (minimum..=maximum).contains(&days))
            }
            SettingConstraint::AsciiHostname => value.as_str().is_some_and(valid_ascii_hostname),
            SettingConstraint::EmailAddress => value.as_str().is_some_and(valid_email_address),
            SettingConstraint::Text {
                minimum_bytes,
                maximum_bytes,
            } => value.as_str().is_some_and(|text| {
                (minimum_bytes..=maximum_bytes).contains(&text.len())
                    && !text.chars().any(char::is_control)
            }),
        };

        if valid {
            Ok(())
        } else {
            Err(InstanceSettingValidationError {
                key: self.key,
                reason: self.constraint.reason(),
            })
        }
    }

    /// Parses and validates the registry-owned default.
    pub fn validated_default(&self) -> Result<Option<Value>, InstanceSettingValidationError> {
        let Some(default_json) = self.default_json else {
            return Ok(None);
        };
        let value =
            serde_json::from_str(default_json).map_err(|_| InstanceSettingValidationError {
                key: self.key,
                reason: "registry default is not valid JSON",
            })?;
        self.validate(&value)?;
        Ok(Some(value))
    }
}


impl SettingConstraint {
    pub(crate) const fn reason(self) -> &'static str {
        match self {
            Self::Boolean => "must be a boolean",
            Self::UnsignedInteger { .. } => "must be an unsigned integer inside the allowed range",
            Self::OptionalUnsignedInteger { .. } => {
                "must be null or an unsigned integer inside the allowed range"
            }
            Self::Enumeration { .. } => "must be one of the allowed values",
            Self::RetentionDays {
                allow_unlimited: true,
                ..
            } => "must be null for unlimited retention or days inside the allowed range",
            Self::RetentionDays {
                allow_unlimited: false,
                ..
            } => "must be retention days inside the allowed range",
            Self::AsciiHostname => "must be a valid ASCII DNS hostname",
            Self::EmailAddress => "must be a valid email address",
            Self::Text { .. } => "must be bounded text without control characters",
        }
    }
}


pub(crate) fn valid_ascii_hostname(value: &str) -> bool {    value.len() <= 253
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
        })
}


pub(crate) fn valid_email_address(value: &str) -> bool {    let Some((local, domain)) = value.rsplit_once('@') else {
        return false;
    };
    !local.is_empty()
        && local.len() <= 64
        && value.len() <= 320
        && !local.chars().any(char::is_control)
        && !local.chars().any(char::is_whitespace)
        && valid_ascii_hostname(domain)
}


impl fmt::Display for InstanceSettingValidationError { fn fmt(&self, formatter: &mut fmt::Formatter<'_>) -> fmt::Result {
        write!(formatter, "Instance setting {} {}", self.key, self.reason)
    }
}


impl std::error::Error for InstanceSettingValidationError {}


impl BootstrapSettingOrigin {
    #[must_use]
    pub const fn as_str(self) -> &'static str {
        match self {
            Self::Default => "default",
            Self::File => "file",
            Self::Environment => "environment",
        }
    }
}


impl InstanceSettingBootstrap {
    pub fn new(
        file: BTreeMap<String, Value>,
        environment: BTreeMap<String, Value>,
    ) -> Result<Self, InstanceSettingBootstrapError> {
        validate_bootstrap_map(&file)?;
        validate_bootstrap_map(&environment)?;
        Ok(Self {
            file,
            environment: environment
                .into_iter()
                .map(|(key, value)| (key, BootstrapEnvironmentValue::Parsed(value)))
                .collect(),
        })
    }

    /// Captures bounded startup inputs without interpreting them. The repository
    /// validates these only if PostgreSQL has no materialized setting set.
    pub(crate) fn from_raw_sources(
        file: BTreeMap<String, Value>,
        environment: BTreeMap<String, String>,
    ) -> Self {
        Self {
            file,
            environment: environment
                .into_iter()
                .map(|(key, value)| (key, BootstrapEnvironmentValue::Raw(value)))
                .collect(),
        }
    }

    #[must_use]
    pub fn empty() -> Self {
        Self {
            file: BTreeMap::new(),
            environment: BTreeMap::new(),
        }
    }

    pub fn resolve(
        &self,
        definition: &'static InstanceSettingDefinition,
    ) -> Result<(Value, BootstrapSettingOrigin), InstanceSettingBootstrapError> {
        if let Some(value) = self.environment.get(definition.key) {
            let value = match value {
                BootstrapEnvironmentValue::Parsed(value) => value.clone(),
                BootstrapEnvironmentValue::Raw(raw) => parse_environment_value(definition, raw)?,
            };
            definition
                .validate(&value)
                .map_err(InstanceSettingBootstrapError::Invalid)?;
            return Ok((value, BootstrapSettingOrigin::Environment));
        }
        if let Some(value) = self.file.get(definition.key) {
            definition
                .validate(value)
                .map_err(InstanceSettingBootstrapError::Invalid)?;
            return Ok((value.clone(), BootstrapSettingOrigin::File));
        }
        let value = definition
            .validated_default()
            .map_err(InstanceSettingBootstrapError::Invalid)?
            .ok_or(InstanceSettingBootstrapError::MissingDefault {
                key: definition.key,
            })?;
        Ok((value, BootstrapSettingOrigin::Default))
    }

    pub fn file_keys(&self) -> impl Iterator<Item = &str> + '_ {
        self.file.keys().map(String::as_str)
    }

    pub fn environment_keys(&self) -> impl Iterator<Item = &str> + '_ {
        self.environment.keys().map(String::as_str)
    }

    pub(crate) fn validate(&self) -> Result<(), InstanceSettingBootstrapError> {
        validate_bootstrap_map(&self.file)?;
        for (key, value) in &self.environment {
            let definition = instance_setting_definition(key)
                .ok_or(InstanceSettingBootstrapError::UnknownKey)?;
            if definition.sensitivity == SettingSensitivity::Secret {
                return Err(InstanceSettingBootstrapError::SecretSource {
                    key: definition.key,
                });
            }
            let value = match value {
                BootstrapEnvironmentValue::Parsed(value) => value.clone(),
                BootstrapEnvironmentValue::Raw(raw) => parse_environment_value(definition, raw)?,
            };
            definition
                .validate(&value)
                .map_err(InstanceSettingBootstrapError::Invalid)?;
        }
        Ok(())
    }
}


impl fmt::Debug for InstanceSettingBootstrap { fn fmt(&self, formatter: &mut fmt::Formatter<'_>) -> fmt::Result {
        formatter
            .debug_struct("InstanceSettingBootstrap")
            .field("file_keys", &self.file.keys().collect::<Vec<_>>())
            .field(
                "environment_keys",
                &self.environment.keys().collect::<Vec<_>>(),
            )
            .finish()
    }
}


impl fmt::Display for InstanceSettingBootstrapError { fn fmt(&self, formatter: &mut fmt::Formatter<'_>) -> fmt::Result {
        match self {
            Self::UnknownKey => formatter.write_str("unknown Instance setting key"),
            Self::SecretSource { key } => {
                write!(
                    formatter,
                    "secret Instance setting {key} cannot use bootstrap JSON"
                )
            }
            Self::MissingDefault { key } => {
                write!(formatter, "Instance setting {key} has no bootstrap value")
            }
            Self::Invalid(error) => error.fmt(formatter),
        }
    }
}


impl std::error::Error for InstanceSettingBootstrapError {}


pub(crate) fn validate_bootstrap_map(    values: &BTreeMap<String, Value>,
) -> Result<(), InstanceSettingBootstrapError> {
    for (key, value) in values {
        let definition =
            instance_setting_definition(key).ok_or(InstanceSettingBootstrapError::UnknownKey)?;
        if definition.sensitivity == SettingSensitivity::Secret {
            return Err(InstanceSettingBootstrapError::SecretSource {
                key: definition.key,
            });
        }
        definition
            .validate(value)
            .map_err(InstanceSettingBootstrapError::Invalid)?;
    }
    Ok(())
}


pub(crate) fn parse_environment_value(    definition: &'static InstanceSettingDefinition,
    raw: &str,
) -> Result<Value, InstanceSettingBootstrapError> {
    let invalid = || {
        InstanceSettingBootstrapError::Invalid(InstanceSettingValidationError {
            key: definition.key,
            reason: "bootstrap environment value has invalid syntax",
        })
    };
    match definition.constraint {
        SettingConstraint::Enumeration { .. }
        | SettingConstraint::AsciiHostname
        | SettingConstraint::EmailAddress
        | SettingConstraint::Text { .. } => Ok(Value::String(raw.to_owned())),
        SettingConstraint::Boolean => raw.parse::<bool>().map(Value::from).map_err(|_| invalid()),
        SettingConstraint::UnsignedInteger { .. } => {
            raw.parse::<u64>().map(Value::from).map_err(|_| invalid())
        }
        SettingConstraint::OptionalUnsignedInteger { .. } if raw == "unlimited" => Ok(Value::Null),
        SettingConstraint::OptionalUnsignedInteger { .. } => {
            raw.parse::<u64>().map(Value::from).map_err(|_| invalid())
        }
        SettingConstraint::RetentionDays {
            allow_unlimited: true,
            ..
        } if raw == "unlimited" => Ok(Value::Null),
        SettingConstraint::RetentionDays { .. } => {
            raw.parse::<u64>().map(Value::from).map_err(|_| invalid())
        }
    }
}
