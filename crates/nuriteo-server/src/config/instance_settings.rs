use std::fmt;

use serde_json::Value;

/// Version of the allowlisted Instance setting registry persisted beside setting values.
pub const INSTANCE_SETTING_REGISTRY_VERSION: u16 = 1;

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
}

/// One allowlisted PostgreSQL-backed Instance setting.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub struct InstanceSettingDefinition {
    pub key: &'static str,
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
        }
    }
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

const fn unsigned(
    key: &'static str,
    default_json: &'static str,
    minimum: u64,
    maximum: u64,
    apply_mode: SettingApplyMode,
) -> InstanceSettingDefinition {
    InstanceSettingDefinition {
        key,
        introduced_in: INSTANCE_SETTING_REGISTRY_VERSION,
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
        "168",
        1,
        720,
        SettingApplyMode::Live,
    ),
    unsigned(
        "notifications.general_retention_days",
        "90",
        30,
        365,
        SettingApplyMode::Live,
    ),
    InstanceSettingDefinition {
        key: "notifications.security_retention_days",
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
        "7",
        0,
        30,
        SettingApplyMode::Live,
    ),
    unsigned(
        "security.reauthentication_window_minutes",
        "30",
        15,
        120,
        SettingApplyMode::Live,
    ),
    unsigned(
        "tokens.default_expiry_days",
        "90",
        1,
        365,
        SettingApplyMode::Live,
    ),
    unsigned(
        "tokens.maximum_expiry_days",
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

#[cfg(test)]
mod tests {
    use std::collections::BTreeSet;

    use serde_json::json;

    use super::*;

    #[test]
    fn registry_is_sorted_unique_versioned_and_complete() {
        let mut keys = BTreeSet::new();
        let mut previous = None;

        for definition in INSTANCE_SETTING_DEFINITIONS {
            assert!(keys.insert(definition.key));
            if let Some(previous) = previous {
                assert!(previous < definition.key, "registry must remain sorted");
            }
            previous = Some(definition.key);
            assert!(definition.key.is_ascii());
            assert!(definition.introduced_in > 0);
            assert!(definition.introduced_in <= INSTANCE_SETTING_REGISTRY_VERSION);
            if definition.sensitivity == SettingSensitivity::Secret {
                assert_eq!(definition.default_json, None);
                assert_eq!(definition.apply_mode, SettingApplyMode::ServerRestart);
            }
            definition.validated_default().unwrap();
        }

        assert_eq!(keys.len(), 10);
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
}
