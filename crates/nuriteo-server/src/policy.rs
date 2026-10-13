//! Typed V1 policy catalog and product-owned safety floors.
//!
//! Persistence remains owned by the Instance setting registry. This module is
//! the exhaustive policy view consumed by admin surfaces and POL-002 engines;
//! immutable entries deliberately have no Instance setting key.

use std::collections::BTreeMap;
use std::fmt;

use serde_json::Value;

use crate::config::{InstanceSettingDefinition, instance_setting_definition};

mod engine;
mod maintenance;

pub(crate) use engine::requires_recent_reauthentication;
pub use engine::{
    EffectivePolicyEngine, EffectivePolicyError, EffectivePolicySnapshot, PolicyApplyScope,
    PolicyChangeDirection, PolicyCleanupPreview, PolicyImpactPreview,
};
pub use maintenance::{
    ObjectDeleteOutcome, ObjectGcBackend, PolicyMaintenanceError, PolicyMaintenanceReport,
    PolicyMaintenanceWorker,
};

const MIB: u64 = 1024 * 1024;

#[derive(Debug, Clone, Copy, PartialEq, Eq, PartialOrd, Ord)]
pub struct PolicyField(&'static str);

impl PolicyField {
    #[must_use]
    pub const fn key(self) -> &'static str {
        self.0
    }
}

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum PolicyCategory {
    Audit,
    Identity,
    Notification,
    ObjectStorage,
    Project,
    Runtime,
    Security,
    Token,
    Workspace,
}

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub struct PolicyDefinition {
    pub field: PolicyField,
    pub category: PolicyCategory,
}

impl PolicyDefinition {
    #[must_use]
    pub fn setting(self) -> &'static InstanceSettingDefinition {
        instance_setting_definition(self.field.key())
            .expect("policy catalog keys must exist in the Instance setting registry")
    }
}

const fn policy(key: &'static str, category: PolicyCategory) -> PolicyDefinition {
    PolicyDefinition {
        field: PolicyField(key),
        category,
    }
}

/// Exhaustive mutable policy catalog for V1. Sorted by persistent key.
pub const POLICY_DEFINITIONS: &[PolicyDefinition] = &[
    policy("audit.retention_days", PolicyCategory::Audit),
    policy("invitations.default_expiry_hours", PolicyCategory::Identity),
    policy(
        "notifications.general_retention_days",
        PolicyCategory::Notification,
    ),
    policy(
        "notifications.security_retention_days",
        PolicyCategory::Notification,
    ),
    policy(
        "object_storage.gc.batch_size",
        PolicyCategory::ObjectStorage,
    ),
    policy("object_storage.gc.enabled", PolicyCategory::ObjectStorage),
    policy(
        "object_storage.gc.grace_period_hours",
        PolicyCategory::ObjectStorage,
    ),
    policy(
        "object_storage.gc.interval_hours",
        PolicyCategory::ObjectStorage,
    ),
    policy(
        "object_storage.multipart.browser_concurrency",
        PolicyCategory::ObjectStorage,
    ),
    policy(
        "object_storage.multipart.incomplete_cleanup_hours",
        PolicyCategory::ObjectStorage,
    ),
    policy(
        "object_storage.multipart.part_size_bytes",
        PolicyCategory::ObjectStorage,
    ),
    policy(
        "object_storage.payload_max_bytes",
        PolicyCategory::ObjectStorage,
    ),
    policy(
        "object_storage.presign_download_expiry_minutes",
        PolicyCategory::ObjectStorage,
    ),
    policy(
        "object_storage.presign_upload_expiry_minutes",
        PolicyCategory::ObjectStorage,
    ),
    policy(
        "object_storage.single_put_max_bytes",
        PolicyCategory::ObjectStorage,
    ),
    policy("projects.file_count_max", PolicyCategory::Project),
    policy("projects.path_depth_max", PolicyCategory::Project),
    policy("projects.path_length_max_bytes", PolicyCategory::Project),
    policy("projects.single_file_max_bytes", PolicyCategory::Project),
    policy("projects.source_max_bytes", PolicyCategory::Project),
    policy("runtime.network.default", PolicyCategory::Runtime),
    policy("security.mfa_enforcement", PolicyCategory::Security),
    policy("security.mfa_grace_period_days", PolicyCategory::Security),
    policy(
        "security.reauthentication_window_minutes",
        PolicyCategory::Security,
    ),
    policy(
        "sessions.absolute_timeout_minutes",
        PolicyCategory::Identity,
    ),
    policy("sessions.idle_timeout_minutes", PolicyCategory::Identity),
    policy("tokens.default_expiry_days", PolicyCategory::Token),
    policy("tokens.maximum_expiry_days", PolicyCategory::Token),
    policy(
        "workspace.organization_default_quota_bytes",
        PolicyCategory::Workspace,
    ),
    policy(
        "workspace.personal_default_quota_bytes",
        PolicyCategory::Workspace,
    ),
    policy(
        "workspace.quota_critical_percent",
        PolicyCategory::Workspace,
    ),
    policy("workspace.quota_limit_percent", PolicyCategory::Workspace),
    policy("workspace.quota_warning_percent", PolicyCategory::Workspace),
];

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum ImmutablePolicyValue {
    Boolean(bool),
    Unsigned(u64),
}

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub struct ImmutablePolicyMinimum {
    pub key: &'static str,
    pub value: ImmutablePolicyValue,
}

/// Product-owned floors and ceilings which no admin setting may weaken.
pub const IMMUTABLE_POLICY_MINIMA: &[ImmutablePolicyMinimum] = &[
    ImmutablePolicyMinimum {
        key: "invitations.unlimited_expiry_allowed",
        value: ImmutablePolicyValue::Boolean(false),
    },
    ImmutablePolicyMinimum {
        key: "notifications.user_soft_limit",
        value: ImmutablePolicyValue::Unsigned(5_000),
    },
    ImmutablePolicyMinimum {
        key: "projects.editor_text_file_max_bytes",
        value: ImmutablePolicyValue::Unsigned(5 * MIB),
    },
    ImmutablePolicyMinimum {
        key: "projects.path_segment_max_bytes",
        value: ImmutablePolicyValue::Unsigned(255),
    },
    ImmutablePolicyMinimum {
        key: "projects.recovery_checkpoint_count",
        value: ImmutablePolicyValue::Unsigned(3),
    },
    ImmutablePolicyMinimum {
        key: "security.credentials_exposed_to_runtime",
        value: ImmutablePolicyValue::Boolean(false),
    },
    ImmutablePolicyMinimum {
        key: "security.integration_endpoint_fallback",
        value: ImmutablePolicyValue::Boolean(false),
    },
    ImmutablePolicyMinimum {
        key: "security.tls_verification_required",
        value: ImmutablePolicyValue::Boolean(true),
    },
    ImmutablePolicyMinimum {
        key: "sessions.unlimited_expiry_allowed",
        value: ImmutablePolicyValue::Boolean(false),
    },
    ImmutablePolicyMinimum {
        key: "storage.browser_upload_buffer_max_bytes",
        value: ImmutablePolicyValue::Unsigned(128 * MIB),
    },
    ImmutablePolicyMinimum {
        key: "storage.multipart_part_count_max",
        value: ImmutablePolicyValue::Unsigned(128),
    },
    ImmutablePolicyMinimum {
        key: "storage.payload_absolute_max_bytes",
        value: ImmutablePolicyValue::Unsigned(2 * 1024 * MIB),
    },
    ImmutablePolicyMinimum {
        key: "tokens.absolute_expiry_days",
        value: ImmutablePolicyValue::Unsigned(365),
    },
];

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum PolicyLookup {
    Mutable(&'static PolicyDefinition),
    Immutable(&'static ImmutablePolicyMinimum),
    Unknown,
}

#[must_use]
pub fn policy_lookup(key: &str) -> PolicyLookup {
    if let Ok(index) = POLICY_DEFINITIONS.binary_search_by_key(&key, |entry| entry.field.key()) {
        return PolicyLookup::Mutable(&POLICY_DEFINITIONS[index]);
    }
    if let Ok(index) = IMMUTABLE_POLICY_MINIMA.binary_search_by_key(&key, |entry| entry.key) {
        return PolicyLookup::Immutable(&IMMUTABLE_POLICY_MINIMA[index]);
    }
    PolicyLookup::Unknown
}

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum CrossFieldRule {
    SessionAbsoluteAfterIdle,
    TokenDefaultWithinMaximum,
    QuotaThresholdsOrdered,
    SinglePutWithinPayload,
    MultipartPartCountBounded,
    BrowserUploadBufferBounded,
    ProjectFileWithinSource,
}

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum PolicyValidationError {
    IncompleteCatalog,
    InvalidField,
    CrossField(CrossFieldRule),
}

impl fmt::Display for PolicyValidationError {
    fn fmt(&self, formatter: &mut fmt::Formatter<'_>) -> fmt::Result {
        match self {
            Self::IncompleteCatalog => {
                formatter.write_str("effective policy catalog is incomplete")
            }
            Self::InvalidField => formatter.write_str("effective policy field is invalid"),
            Self::CrossField(rule) => write!(formatter, "effective policy violates {rule:?}"),
        }
    }
}

impl std::error::Error for PolicyValidationError {}

/// Validates one complete current-registry policy snapshot without rendering values.
pub fn validate_policy_values<'a>(
    values: impl IntoIterator<Item = (&'a str, &'a Value)>,
) -> Result<(), PolicyValidationError> {
    let values: BTreeMap<_, _> = values.into_iter().collect();
    for policy in POLICY_DEFINITIONS {
        let value = values
            .get(policy.field.key())
            .ok_or(PolicyValidationError::IncompleteCatalog)?;
        policy
            .setting()
            .validate(value)
            .map_err(|_| PolicyValidationError::InvalidField)?;
    }

    require(
        number(&values, "sessions.absolute_timeout_minutes")?
            > number(&values, "sessions.idle_timeout_minutes")?,
        CrossFieldRule::SessionAbsoluteAfterIdle,
    )?;
    require(
        number(&values, "tokens.default_expiry_days")?
            <= number(&values, "tokens.maximum_expiry_days")?,
        CrossFieldRule::TokenDefaultWithinMaximum,
    )?;
    let warning = number(&values, "workspace.quota_warning_percent")?;
    let critical = number(&values, "workspace.quota_critical_percent")?;
    let limit = number(&values, "workspace.quota_limit_percent")?;
    require(
        warning < critical && critical <= limit,
        CrossFieldRule::QuotaThresholdsOrdered,
    )?;
    let single_put = number(&values, "object_storage.single_put_max_bytes")?;
    let payload = number(&values, "object_storage.payload_max_bytes")?;
    require(
        single_put <= payload,
        CrossFieldRule::SinglePutWithinPayload,
    )?;
    let part_size = number(&values, "object_storage.multipart.part_size_bytes")?;
    require(
        payload.div_ceil(part_size) <= 128,
        CrossFieldRule::MultipartPartCountBounded,
    )?;
    let concurrency = number(&values, "object_storage.multipart.browser_concurrency")?;
    require(
        part_size.saturating_mul(concurrency) <= 128 * MIB,
        CrossFieldRule::BrowserUploadBufferBounded,
    )?;
    require(
        number(&values, "projects.single_file_max_bytes")?
            <= number(&values, "projects.source_max_bytes")?,
        CrossFieldRule::ProjectFileWithinSource,
    )
}

fn number(values: &BTreeMap<&str, &Value>, key: &str) -> Result<u64, PolicyValidationError> {
    values
        .get(key)
        .and_then(|value| value.as_u64())
        .ok_or(PolicyValidationError::InvalidField)
}

fn require(valid: bool, rule: CrossFieldRule) -> Result<(), PolicyValidationError> {
    if valid {
        Ok(())
    } else {
        Err(PolicyValidationError::CrossField(rule))
    }
}

#[cfg(test)]
mod tests {
    use std::collections::BTreeSet;

    use super::*;
    use crate::config::INSTANCE_SETTING_DEFINITIONS;

    #[test]
    fn catalog_is_sorted_complete_and_has_valid_defaults() {
        let smtp_keys = INSTANCE_SETTING_DEFINITIONS
            .iter()
            .filter(|definition| definition.key.starts_with("smtp."))
            .count();
        let mut previous = None;
        let mut defaults = BTreeMap::new();
        for entry in POLICY_DEFINITIONS {
            if let Some(previous) = previous {
                assert!(previous < entry.field.key());
            }
            previous = Some(entry.field.key());
            let setting = entry.setting();
            defaults.insert(setting.key, setting.validated_default().unwrap().unwrap());
        }
        assert_eq!(
            POLICY_DEFINITIONS.len() + smtp_keys,
            INSTANCE_SETTING_DEFINITIONS.len()
        );
        validate_policy_values(defaults.iter().map(|(key, value)| (*key, value))).unwrap();
    }

    #[test]
    fn immutable_minima_are_sorted_unique_and_not_mutable_settings() {
        let mut keys = BTreeSet::new();
        let mut previous = None;
        for minimum in IMMUTABLE_POLICY_MINIMA {
            assert!(keys.insert(minimum.key));
            if let Some(previous) = previous {
                assert!(previous < minimum.key);
            }
            previous = Some(minimum.key);
            assert!(instance_setting_definition(minimum.key).is_none());
            assert!(matches!(
                policy_lookup(minimum.key),
                PolicyLookup::Immutable(_)
            ));
        }
        assert!(matches!(
            policy_lookup("security.disable_tls_validation"),
            PolicyLookup::Unknown
        ));
    }

    #[test]
    fn cross_field_rules_fail_closed_without_echoing_values() {
        fn defaults() -> BTreeMap<&'static str, Value> {
            POLICY_DEFINITIONS
                .iter()
                .map(|entry| {
                    let setting = entry.setting();
                    (setting.key, setting.validated_default().unwrap().unwrap())
                })
                .collect()
        }

        fn assert_rule(
            mut values: BTreeMap<&'static str, Value>,
            changes: &[(&'static str, Value)],
            rule: CrossFieldRule,
        ) {
            values.extend(changes.iter().cloned());
            let error = validate_policy_values(values.iter().map(|(key, value)| (*key, value)))
                .unwrap_err();
            assert_eq!(error, PolicyValidationError::CrossField(rule));
        }

        assert_rule(
            defaults(),
            &[("sessions.absolute_timeout_minutes", Value::from(10_080))],
            CrossFieldRule::SessionAbsoluteAfterIdle,
        );
        assert_rule(
            defaults(),
            &[
                ("tokens.default_expiry_days", Value::from(365)),
                ("tokens.maximum_expiry_days", Value::from(30)),
            ],
            CrossFieldRule::TokenDefaultWithinMaximum,
        );
        assert_rule(
            defaults(),
            &[("workspace.quota_warning_percent", Value::from(90))],
            CrossFieldRule::QuotaThresholdsOrdered,
        );
        assert_rule(
            defaults(),
            &[
                (
                    "object_storage.single_put_max_bytes",
                    Value::from(256 * MIB),
                ),
                ("object_storage.payload_max_bytes", Value::from(64 * MIB)),
            ],
            CrossFieldRule::SinglePutWithinPayload,
        );
        assert_rule(
            defaults(),
            &[(
                "object_storage.multipart.part_size_bytes",
                Value::from(8 * MIB),
            )],
            CrossFieldRule::MultipartPartCountBounded,
        );
        assert_rule(
            defaults(),
            &[
                (
                    "object_storage.multipart.part_size_bytes",
                    Value::from(64 * MIB),
                ),
                (
                    "object_storage.multipart.browser_concurrency",
                    Value::from(8),
                ),
                ("object_storage.payload_max_bytes", Value::from(128 * MIB)),
            ],
            CrossFieldRule::BrowserUploadBufferBounded,
        );

        let incomplete: BTreeMap<_, _> = POLICY_DEFINITIONS
            .iter()
            .skip(1)
            .map(|entry| {
                let setting = entry.setting();
                (setting.key, setting.validated_default().unwrap().unwrap())
            })
            .collect();
        assert_eq!(
            validate_policy_values(incomplete.iter().map(|(key, value)| (*key, value))),
            Err(PolicyValidationError::IncompleteCatalog)
        );
    }
}
