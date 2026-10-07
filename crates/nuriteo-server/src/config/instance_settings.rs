use std::collections::BTreeMap;
use std::fmt;

use serde_json::Value;

/// Version of the allowlisted Instance setting registry persisted beside setting values.
pub const INSTANCE_SETTING_REGISTRY_VERSION: u16 = 2;

/// How a validated setting becomes effective.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum SettingApplyMode {
    /// New requests observe the value without restarting a process or Runtime.
    Live,
    /// Existing browser Runtime sessions keep their policy until restarted.
    NewRuntime,
    /// A controlled Server rollout is required before the value is effective.
    ServerRestart,
}

/// Whether a setting value may be returned by an administrator read API.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum SettingSensitivity {
    Public,
    Secret,
}

/// Machine-readable validation for a setting value.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum SettingConstraint {
    Boolean,
    UnsignedInteger {
        minimum: u64,
        maximum: u64,
    },
    Enumeration {
        allowed: &'static [&'static str],
    },
    RetentionDays {
        minimum: u64,
        maximum: u64,
        allow_unlimited: bool,
    },
    AsciiHostname,
    EmailAddress,
    Text {
        minimum_bytes: usize,
        maximum_bytes: usize,
    },
}

/// One allowlisted PostgreSQL-backed Instance setting.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub struct InstanceSettingDefinition {
    pub key: &'static str,
    pub bootstrap_environment: &'static str,
    pub introduced_in: u16,
    pub default_json: Option<&'static str>,
    pub sensitivity: SettingSensitivity,
    pub apply_mode: SettingApplyMode,
    pub constraint: SettingConstraint,
}

impl InstanceSettingDefinition {
    /// Validates decoded JSON without ever rendering the supplied value in an error.
    pub fn validate(&self, value: &Value) -> Result<(), InstanceSettingValidationError> {
        let valid = match self.constraint {
            SettingConstraint::Boolean => value.is_boolean(),
            SettingConstraint::UnsignedInteger { minimum, maximum } => value
                .as_u64()
                .is_some_and(|number| (minimum..=maximum).contains(&number)),
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
    const fn reason(self) -> &'static str {
        match self {
            Self::Boolean => "must be a boolean",
            Self::UnsignedInteger { .. } => "must be an unsigned integer inside the allowed range",
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

fn valid_ascii_hostname(value: &str) -> bool {
    value.len() <= 253
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

fn valid_email_address(value: &str) -> bool {
    let Some((local, domain)) = value.rsplit_once('@') else {
        return false;
    };
    !local.is_empty()
        && local.len() <= 64
        && value.len() <= 320
        && !local.chars().any(char::is_control)
        && !local.chars().any(char::is_whitespace)
        && valid_ascii_hostname(domain)
}

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub struct InstanceSettingValidationError {
    pub key: &'static str,
    pub reason: &'static str,
}

impl fmt::Display for InstanceSettingValidationError {
    fn fmt(&self, formatter: &mut fmt::Formatter<'_>) -> fmt::Result {
        write!(formatter, "Instance setting {} {}", self.key, self.reason)
    }
}

impl std::error::Error for InstanceSettingValidationError {}

const MFA_ENFORCEMENT: &[&str] = &["off", "administrators", "all_local_users"];
const RUNTIME_NETWORK: &[&str] = &["browser_direct", "runtime_offline"];
const SMTP_SECURITY: &[&str] = &["implicit-tls", "starttls"];

const fn unsigned(
    key: &'static str,
    bootstrap_environment: &'static str,
    default_json: &'static str,
    minimum: u64,
    maximum: u64,
    apply_mode: SettingApplyMode,
) -> InstanceSettingDefinition {
    InstanceSettingDefinition {
        key,
        bootstrap_environment,
        introduced_in: 1,
        default_json: Some(default_json),
        sensitivity: SettingSensitivity::Public,
        apply_mode,
        constraint: SettingConstraint::UnsignedInteger { minimum, maximum },
    }
}

/// Sorted allowlist consumed by persistence, admin API and documentation generation.
pub const INSTANCE_SETTING_DEFINITIONS: &[InstanceSettingDefinition] = &[
    InstanceSettingDefinition {
        key: "audit.retention_days",
        bootstrap_environment: "NURITEO_AUDIT_RETENTION_DAYS",
        introduced_in: 1,
        default_json: Some("365"),
        sensitivity: SettingSensitivity::Public,
        apply_mode: SettingApplyMode::Live,
        constraint: SettingConstraint::RetentionDays {
            minimum: 30,
            maximum: 3_650,
            allow_unlimited: true,
        },
    },
    unsigned(
        "invitations.default_expiry_hours",
        "NURITEO_INVITATION_DEFAULT_EXPIRY_HOURS",
        "168",
        1,
        720,
        SettingApplyMode::Live,
    ),
    unsigned(
        "notifications.general_retention_days",
        "NURITEO_NOTIFICATION_GENERAL_RETENTION_DAYS",
        "90",
        30,
        365,
        SettingApplyMode::Live,
    ),
    InstanceSettingDefinition {
        key: "notifications.security_retention_days",
        bootstrap_environment: "NURITEO_NOTIFICATION_SECURITY_RETENTION_DAYS",
        introduced_in: 1,
        default_json: Some("365"),
        sensitivity: SettingSensitivity::Public,
        apply_mode: SettingApplyMode::Live,
        constraint: SettingConstraint::RetentionDays {
            minimum: 90,
            maximum: 1_825,
            allow_unlimited: true,
        },
    },
    InstanceSettingDefinition {
        key: "runtime.network.default",
        bootstrap_environment: "NURITEO_RUNTIME_NETWORK_DEFAULT",
        introduced_in: 1,
        default_json: Some("\"browser_direct\""),
        sensitivity: SettingSensitivity::Public,
        apply_mode: SettingApplyMode::NewRuntime,
        constraint: SettingConstraint::Enumeration {
            allowed: RUNTIME_NETWORK,
        },
    },
    InstanceSettingDefinition {
        key: "security.mfa_enforcement",
        bootstrap_environment: "NURITEO_MFA_ENFORCEMENT",
        introduced_in: 1,
        default_json: Some("\"off\""),
        sensitivity: SettingSensitivity::Public,
        apply_mode: SettingApplyMode::Live,
        constraint: SettingConstraint::Enumeration {
            allowed: MFA_ENFORCEMENT,
        },
    },
    unsigned(
        "security.mfa_grace_period_days",
        "NURITEO_MFA_GRACE_PERIOD_DAYS",
        "7",
        0,
        30,
        SettingApplyMode::Live,
    ),
    unsigned(
        "security.reauthentication_window_minutes",
        "NURITEO_REAUTHENTICATION_WINDOW_MINUTES",
        "30",
        15,
        120,
        SettingApplyMode::Live,
    ),
    InstanceSettingDefinition {
        key: "smtp.enabled",
        bootstrap_environment: "NURITEO_SMTP_ENABLED",
        introduced_in: 2,
        default_json: Some("false"),
        sensitivity: SettingSensitivity::Public,
        apply_mode: SettingApplyMode::ServerRestart,
        constraint: SettingConstraint::Boolean,
    },
    InstanceSettingDefinition {
        key: "smtp.from_address",
        bootstrap_environment: "NURITEO_SMTP_FROM_ADDRESS",
        introduced_in: 2,
        default_json: Some("\"noreply@localhost\""),
        sensitivity: SettingSensitivity::Public,
        apply_mode: SettingApplyMode::ServerRestart,
        constraint: SettingConstraint::EmailAddress,
    },
    InstanceSettingDefinition {
        key: "smtp.from_name",
        bootstrap_environment: "NURITEO_SMTP_FROM_NAME",
        introduced_in: 2,
        default_json: Some("\"NURITEO\""),
        sensitivity: SettingSensitivity::Public,
        apply_mode: SettingApplyMode::ServerRestart,
        constraint: SettingConstraint::Text {
            minimum_bytes: 1,
            maximum_bytes: 120,
        },
    },
    InstanceSettingDefinition {
        key: "smtp.host",
        bootstrap_environment: "NURITEO_SMTP_HOST",
        introduced_in: 2,
        default_json: Some("\"localhost\""),
        sensitivity: SettingSensitivity::Public,
        apply_mode: SettingApplyMode::ServerRestart,
        constraint: SettingConstraint::AsciiHostname,
    },
    InstanceSettingDefinition {
        key: "smtp.port",
        bootstrap_environment: "NURITEO_SMTP_PORT",
        introduced_in: 2,
        default_json: Some("587"),
        sensitivity: SettingSensitivity::Public,
        apply_mode: SettingApplyMode::ServerRestart,
        constraint: SettingConstraint::UnsignedInteger {
            minimum: 1,
            maximum: 65_535,
        },
    },
    InstanceSettingDefinition {
        key: "smtp.preflight_timeout_ms",
        bootstrap_environment: "NURITEO_SMTP_PREFLIGHT_TIMEOUT_MS",
        introduced_in: 2,
        default_json: Some("5000"),
        sensitivity: SettingSensitivity::Public,
        apply_mode: SettingApplyMode::ServerRestart,
        constraint: SettingConstraint::UnsignedInteger {
            minimum: 100,
            maximum: 30_000,
        },
    },
    InstanceSettingDefinition {
        key: "smtp.security",
        bootstrap_environment: "NURITEO_SMTP_SECURITY",
        introduced_in: 2,
        default_json: Some("\"starttls\""),
        sensitivity: SettingSensitivity::Public,
        apply_mode: SettingApplyMode::ServerRestart,
        constraint: SettingConstraint::Enumeration {
            allowed: SMTP_SECURITY,
        },
    },
    unsigned(
        "tokens.default_expiry_days",
        "NURITEO_TOKEN_DEFAULT_EXPIRY_DAYS",
        "90",
        1,
        365,
        SettingApplyMode::Live,
    ),
    unsigned(
        "tokens.maximum_expiry_days",
        "NURITEO_TOKEN_MAXIMUM_EXPIRY_DAYS",
        "365",
        1,
        365,
        SettingApplyMode::Live,
    ),
];

/// Returns an allowlisted definition. Unknown keys fail closed at the caller.
#[must_use]
pub fn instance_setting_definition(key: &str) -> Option<&'static InstanceSettingDefinition> {
    INSTANCE_SETTING_DEFINITIONS
        .binary_search_by_key(&key, |definition| definition.key)
        .ok()
        .map(|index| &INSTANCE_SETTING_DEFINITIONS[index])
}

/// Origin used only while materializing the first complete PostgreSQL setting set.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum BootstrapSettingOrigin {
    Default,
    File,
    Environment,
}

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

/// Validated first-install inputs. PostgreSQL supersedes this object after materialization.
#[derive(Clone, PartialEq, Eq)]
pub struct InstanceSettingBootstrap {
    file: BTreeMap<&'static str, Value>,
    environment: BTreeMap<&'static str, Value>,
}

impl InstanceSettingBootstrap {
    pub fn new(
        file: BTreeMap<String, Value>,
        environment: BTreeMap<String, Value>,
    ) -> Result<Self, InstanceSettingBootstrapError> {
        Ok(Self {
            file: validate_bootstrap_map(file)?,
            environment: validate_bootstrap_map(environment)?,
        })
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
            return Ok((value.clone(), BootstrapSettingOrigin::Environment));
        }
        if let Some(value) = self.file.get(definition.key) {
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

    pub fn file_keys(&self) -> impl Iterator<Item = &'static str> + '_ {
        self.file.keys().copied()
    }

    pub fn environment_keys(&self) -> impl Iterator<Item = &'static str> + '_ {
        self.environment.keys().copied()
    }
}

impl fmt::Debug for InstanceSettingBootstrap {
    fn fmt(&self, formatter: &mut fmt::Formatter<'_>) -> fmt::Result {
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

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum InstanceSettingBootstrapError {
    UnknownKey,
    SecretSource { key: &'static str },
    MissingDefault { key: &'static str },
    Invalid(InstanceSettingValidationError),
}

impl fmt::Display for InstanceSettingBootstrapError {
    fn fmt(&self, formatter: &mut fmt::Formatter<'_>) -> fmt::Result {
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

fn validate_bootstrap_map(
    values: BTreeMap<String, Value>,
) -> Result<BTreeMap<&'static str, Value>, InstanceSettingBootstrapError> {
    let mut validated = BTreeMap::new();
    for (key, value) in values {
        let definition =
            instance_setting_definition(&key).ok_or(InstanceSettingBootstrapError::UnknownKey)?;
        if definition.sensitivity == SettingSensitivity::Secret {
            return Err(InstanceSettingBootstrapError::SecretSource {
                key: definition.key,
            });
        }
        definition
            .validate(&value)
            .map_err(InstanceSettingBootstrapError::Invalid)?;
        validated.insert(definition.key, value);
    }
    Ok(validated)
}

#[cfg(test)]
mod tests {
    use std::collections::BTreeSet;

    use serde_json::json;

    use super::*;

    #[test]
    fn registry_is_sorted_unique_versioned_and_complete() {
        let mut keys = BTreeSet::new();
        let mut environment_names = BTreeSet::new();
        let mut previous = None;

        for definition in INSTANCE_SETTING_DEFINITIONS {
            assert!(keys.insert(definition.key));
            if let Some(previous) = previous {
                assert!(previous < definition.key, "registry must remain sorted");
            }
            previous = Some(definition.key);
            assert!(definition.key.is_ascii());
            assert!(environment_names.insert(definition.bootstrap_environment));
            assert!(definition.bootstrap_environment.starts_with("NURITEO_"));
            assert!(definition.introduced_in > 0);
            assert!(definition.introduced_in <= INSTANCE_SETTING_REGISTRY_VERSION);
            if definition.sensitivity == SettingSensitivity::Secret {
                assert_eq!(definition.default_json, None);
                assert_eq!(definition.apply_mode, SettingApplyMode::ServerRestart);
            }
            definition.validated_default().unwrap();
        }

        assert_eq!(keys.len(), 17);
    }

    #[test]
    fn registry_lookup_fails_closed_for_unknown_keys() {
        assert!(instance_setting_definition("security.mfa_enforcement").is_some());
        assert!(instance_setting_definition("security.disable_tls_validation").is_none());
        assert!(instance_setting_definition("").is_none());
    }

    #[test]
    fn policy_bounds_and_enums_are_enforced_without_echoing_values() {
        let cases = [
            ("invitations.default_expiry_hours", json!(0)),
            ("security.reauthentication_window_minutes", json!(121)),
            ("security.mfa_enforcement", json!("selected_users")),
            ("runtime.network.default", json!("server_proxy")),
            ("notifications.security_retention_days", json!(89)),
            ("tokens.maximum_expiry_days", json!(366)),
        ];

        for (key, value) in cases {
            let error = instance_setting_definition(key)
                .unwrap()
                .validate(&value)
                .unwrap_err();
            assert_eq!(error.key, key);
            assert!(!error.to_string().contains(&value.to_string()));
        }

        assert!(
            instance_setting_definition("audit.retention_days")
                .unwrap()
                .validate(&Value::Null)
                .is_ok()
        );
    }

    #[test]
    fn integer_constraints_reject_fractional_negative_and_string_values() {
        let definition = instance_setting_definition("tokens.default_expiry_days").unwrap();
        for value in [json!(90.5), json!(-1), json!("90"), json!(true)] {
            assert!(definition.validate(&value).is_err());
        }
    }

    #[test]
    fn bootstrap_precedence_is_environment_then_file_then_default() {
        let bootstrap = InstanceSettingBootstrap::new(
            BTreeMap::from([
                ("security.mfa_grace_period_days".to_owned(), json!(14)),
                ("tokens.default_expiry_days".to_owned(), json!(120)),
            ]),
            BTreeMap::from([("security.mfa_grace_period_days".to_owned(), json!(3))]),
        )
        .unwrap();

        assert_eq!(
            bootstrap
                .resolve(instance_setting_definition("security.mfa_grace_period_days").unwrap())
                .unwrap(),
            (json!(3), BootstrapSettingOrigin::Environment)
        );
        assert_eq!(
            bootstrap
                .resolve(instance_setting_definition("tokens.default_expiry_days").unwrap())
                .unwrap(),
            (json!(120), BootstrapSettingOrigin::File)
        );
        assert_eq!(
            bootstrap
                .resolve(instance_setting_definition("audit.retention_days").unwrap())
                .unwrap(),
            (json!(365), BootstrapSettingOrigin::Default)
        );
    }

    #[test]
    fn bootstrap_rejects_unknown_or_invalid_values_without_echoing_them() {
        assert_eq!(
            InstanceSettingBootstrap::new(
                BTreeMap::from([("security.unknown".to_owned(), json!("do-not-echo"))]),
                BTreeMap::new(),
            )
            .unwrap_err(),
            InstanceSettingBootstrapError::UnknownKey
        );

        let error = InstanceSettingBootstrap::new(
            BTreeMap::new(),
            BTreeMap::from([("security.mfa_enforcement".to_owned(), json!("do-not-echo"))]),
        )
        .unwrap_err();
        assert!(!error.to_string().contains("do-not-echo"));
    }
}
