use std::collections::BTreeMap;

use std::fmt;


use serde_json::Value;


/// Version of the allowlisted Instance setting registry persisted beside setting values.
pub const INSTANCE_SETTING_REGISTRY_VERSION: u16 = 4;


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
    OptionalUnsignedInteger {
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


#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub struct InstanceSettingValidationError {
    pub key: &'static str,
    pub reason: &'static str,
}


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


const fn policy_unsigned(
    key: &'static str,
    bootstrap_environment: &'static str,
    default_json: &'static str,
    minimum: u64,
    maximum: u64,
    apply_mode: SettingApplyMode,
) -> InstanceSettingDefinition {
    let mut definition = unsigned(
        key,
        bootstrap_environment,
        default_json,
        minimum,
        maximum,
        apply_mode,
    );
    definition.introduced_in = 3;
    definition
}


const fn policy_boolean(
    key: &'static str,
    bootstrap_environment: &'static str,
    default_json: &'static str,
) -> InstanceSettingDefinition {
    InstanceSettingDefinition {
        key,
        bootstrap_environment,
        introduced_in: 3,
        default_json: Some(default_json),
        sensitivity: SettingSensitivity::Public,
        apply_mode: SettingApplyMode::Live,
        constraint: SettingConstraint::Boolean,
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
        key: "object_storage.gc.batch_size",
        bootstrap_environment: "NURITEO_GC_BATCH_SIZE",
        introduced_in: 4,
        default_json: Some("32"),
        sensitivity: SettingSensitivity::Public,
        apply_mode: SettingApplyMode::Live,
        constraint: SettingConstraint::UnsignedInteger {
            minimum: 1,
            maximum: 100,
        },
    },
    policy_boolean("object_storage.gc.enabled", "NURITEO_GC_ENABLED", "true"),
    policy_unsigned(
        "object_storage.gc.grace_period_hours",
        "NURITEO_GC_GRACE_PERIOD_HOURS",
        "24",
        0,
        720,
        SettingApplyMode::Live,
    ),
    policy_unsigned(
        "object_storage.gc.interval_hours",
        "NURITEO_GC_INTERVAL_HOURS",
        "24",
        1,
        168,
        SettingApplyMode::Live,
    ),
    policy_unsigned(
        "object_storage.multipart.browser_concurrency",
        "NURITEO_MULTIPART_BROWSER_CONCURRENCY",
        "4",
        1,
        8,
        SettingApplyMode::ServerRestart,
    ),
    policy_unsigned(
        "object_storage.multipart.incomplete_cleanup_hours",
        "NURITEO_MULTIPART_INCOMPLETE_CLEANUP_HOURS",
        "24",
        1,
        168,
        SettingApplyMode::ServerRestart,
    ),
    policy_unsigned(
        "object_storage.multipart.part_size_bytes",
        "NURITEO_MULTIPART_PART_SIZE_BYTES",
        "16777216",
        8 * 1024 * 1024,
        64 * 1024 * 1024,
        SettingApplyMode::ServerRestart,
    ),
    policy_unsigned(
        "object_storage.payload_max_bytes",
        "NURITEO_PAYLOAD_MAX_BYTES",
        "2147483648",
        64 * 1024 * 1024,
        2 * 1024 * 1024 * 1024,
        SettingApplyMode::ServerRestart,
    ),
    policy_unsigned(
        "object_storage.presign_download_expiry_minutes",
        "NURITEO_PRESIGN_DOWNLOAD_EXPIRY_MINUTES",
        "5",
        1,
        15,
        SettingApplyMode::ServerRestart,
    ),
    policy_unsigned(
        "object_storage.presign_upload_expiry_minutes",
        "NURITEO_PRESIGN_UPLOAD_EXPIRY_MINUTES",
        "15",
        5,
        60,
        SettingApplyMode::ServerRestart,
    ),
    policy_unsigned(
        "object_storage.single_put_max_bytes",
        "NURITEO_SINGLE_PUT_MAX_BYTES",
        "67108864",
        16 * 1024 * 1024,
        256 * 1024 * 1024,
        SettingApplyMode::ServerRestart,
    ),
    policy_unsigned(
        "projects.file_count_max",
        "NURITEO_PROJECT_FILE_COUNT_MAX",
        "2500",
        1,
        2_500,
        SettingApplyMode::ServerRestart,
    ),
    policy_unsigned(
        "projects.path_depth_max",
        "NURITEO_PROJECT_PATH_DEPTH_MAX",
        "32",
        8,
        64,
        SettingApplyMode::ServerRestart,
    ),
    policy_unsigned(
        "projects.path_length_max_bytes",
        "NURITEO_PROJECT_PATH_LENGTH_MAX_BYTES",
        "512",
        256,
        1_024,
        SettingApplyMode::ServerRestart,
    ),
    policy_unsigned(
        "projects.single_file_max_bytes",
        "NURITEO_PROJECT_SINGLE_FILE_MAX_BYTES",
        "16777216",
        1,
        16 * 1024 * 1024,
        SettingApplyMode::ServerRestart,
    ),
    policy_unsigned(
        "projects.source_max_bytes",
        "NURITEO_PROJECT_SOURCE_MAX_BYTES",
        "134217728",
        16 * 1024 * 1024,
        256 * 1024 * 1024,
        SettingApplyMode::ServerRestart,
    ),
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
    policy_unsigned(
        "sessions.absolute_timeout_minutes",
        "NURITEO_SESSION_ABSOLUTE_TIMEOUT_MINUTES",
        "43200",
        60,
        90 * 24 * 60,
        SettingApplyMode::Live,
    ),
    policy_unsigned(
        "sessions.idle_timeout_minutes",
        "NURITEO_SESSION_IDLE_TIMEOUT_MINUTES",
        "10080",
        15,
        30 * 24 * 60,
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
    InstanceSettingDefinition {
        key: "workspace.organization_default_quota_bytes",
        bootstrap_environment: "NURITEO_ORGANIZATION_DEFAULT_QUOTA_BYTES",
        introduced_in: 3,
        default_json: Some("null"),
        sensitivity: SettingSensitivity::Public,
        apply_mode: SettingApplyMode::Live,
        constraint: SettingConstraint::OptionalUnsignedInteger {
            minimum: 1,
            maximum: 9_007_199_254_740_991,
        },
    },
    InstanceSettingDefinition {
        key: "workspace.personal_default_quota_bytes",
        bootstrap_environment: "NURITEO_PERSONAL_DEFAULT_QUOTA_BYTES",
        introduced_in: 3,
        default_json: Some("null"),
        sensitivity: SettingSensitivity::Public,
        apply_mode: SettingApplyMode::Live,
        constraint: SettingConstraint::OptionalUnsignedInteger {
            minimum: 1,
            maximum: 9_007_199_254_740_991,
        },
    },
    policy_unsigned(
        "workspace.quota_critical_percent",
        "NURITEO_WORKSPACE_QUOTA_CRITICAL_PERCENT",
        "90",
        1,
        100,
        SettingApplyMode::ServerRestart,
    ),
    policy_unsigned(
        "workspace.quota_limit_percent",
        "NURITEO_WORKSPACE_QUOTA_LIMIT_PERCENT",
        "100",
        1,
        100,
        SettingApplyMode::ServerRestart,
    ),
    policy_unsigned(
        "workspace.quota_warning_percent",
        "NURITEO_WORKSPACE_QUOTA_WARNING_PERCENT",
        "80",
        1,
        100,
        SettingApplyMode::ServerRestart,
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


/// Validated first-install inputs. PostgreSQL supersedes this object after materialization.
#[derive(Clone, PartialEq, Eq)]
pub struct InstanceSettingBootstrap {
    file: BTreeMap<String, Value>,
    environment: BTreeMap<String, BootstrapEnvironmentValue>,
}


#[derive(Clone, PartialEq, Eq)]
enum BootstrapEnvironmentValue {
    Parsed(Value),
    Raw(String),
}


#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum InstanceSettingBootstrapError {
    UnknownKey,
    SecretSource { key: &'static str },
    MissingDefault { key: &'static str },
    Invalid(InstanceSettingValidationError),
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

        assert_eq!(keys.len(), 40);
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
    fn every_registry_constraint_accepts_its_edges_and_rejects_wrong_types() {
        for definition in INSTANCE_SETTING_DEFINITIONS {
            match definition.constraint {
                SettingConstraint::Boolean => {
                    assert!(definition.validate(&json!(true)).is_ok());
                    assert!(definition.validate(&json!("true")).is_err());
                }
                SettingConstraint::UnsignedInteger { minimum, maximum } => {
                    assert!(definition.validate(&json!(minimum)).is_ok());
                    assert!(definition.validate(&json!(maximum)).is_ok());
                    assert!(definition.validate(&json!("1")).is_err());
                    if let Some(above) = maximum.checked_add(1) {
                        assert!(definition.validate(&json!(above)).is_err());
                    }
                }
                SettingConstraint::OptionalUnsignedInteger { minimum, maximum } => {
                    assert!(definition.validate(&Value::Null).is_ok());
                    assert!(definition.validate(&json!(minimum)).is_ok());
                    assert!(definition.validate(&json!(maximum)).is_ok());
                    assert!(definition.validate(&json!("unlimited")).is_err());
                }
                SettingConstraint::Enumeration { allowed } => {
                    for value in allowed {
                        assert!(definition.validate(&json!(value)).is_ok());
                    }
                    assert!(definition.validate(&json!("not-allowlisted")).is_err());
                }
                SettingConstraint::RetentionDays {
                    minimum,
                    maximum,
                    allow_unlimited,
                } => {
                    assert!(definition.validate(&json!(minimum)).is_ok());
                    assert!(definition.validate(&json!(maximum)).is_ok());
                    assert_eq!(definition.validate(&Value::Null).is_ok(), allow_unlimited);
                }
                SettingConstraint::AsciiHostname => {
                    assert!(definition.validate(&json!("service.internal")).is_ok());
                    assert!(definition.validate(&json!("bad host")).is_err());
                }
                SettingConstraint::EmailAddress => {
                    assert!(definition.validate(&json!("admin@example.test")).is_ok());
                    assert!(definition.validate(&json!("not-an-email")).is_err());
                }
                SettingConstraint::Text { maximum_bytes, .. } => {
                    assert!(definition.validate(&json!("safe")).is_ok());
                    assert!(
                        definition
                            .validate(&json!("x".repeat(maximum_bytes + 1)))
                            .is_err()
                    );
                }
            }
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


mod bootstrap_values;
pub(crate) use bootstrap_values::*;
