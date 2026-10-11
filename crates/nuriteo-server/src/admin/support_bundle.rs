use serde::Serialize;
use sha2::{Digest, Sha256};
use sqlx::Row;
use time::OffsetDateTime;
use utoipa::ToSchema;

use crate::VERSION;
use crate::database::{SchemaReadiness, check_schema_readiness};
use crate::identity::{BrowserRequestHeaders, Timestamp};
use crate::instance_settings::InstanceSettingsRepository;

use super::{AdminHttpService, AdminHttpServiceError, AdminOperationsView};

#[derive(Debug, Clone, Serialize, ToSchema)]
#[serde(rename_all = "camelCase")]
pub struct AdminSupportBundleReleaseView {
    pub version: String,
    pub operating_system: &'static str,
    pub architecture: &'static str,
}

#[derive(Debug, Clone, Serialize, ToSchema)]
#[serde(rename_all = "camelCase")]
pub struct AdminSupportBundleConfigurationView {
    pub database_schema_version: i64,
    pub setting_registry_version: u16,
    pub setting_count: usize,
    pub fingerprint: String,
}

#[derive(Debug, Clone, Serialize, ToSchema)]
#[serde(rename_all = "camelCase")]
pub struct AdminSupportBundleIntegrationView {
    pub kind: &'static str,
    pub active_count: u64,
    pub disabled_count: u64,
}

#[derive(Debug, Clone, Serialize, ToSchema)]
#[serde(rename_all = "camelCase")]
pub struct AdminSupportBundleDiagnosticView {
    pub sequence: u64,
    pub occurred_at_unix_ms: u64,
    pub event_name: String,
    pub level: String,
    pub operation_id: Option<String>,
    pub code: Option<String>,
    pub status_code: Option<u16>,
}

#[derive(Debug, Clone, Serialize, ToSchema)]
#[serde(rename_all = "camelCase")]
pub struct AdminSupportBundleView {
    pub schema_version: u8,
    pub format: &'static str,
    pub generated_at: String,
    pub retained_until: Option<String>,
    pub release: AdminSupportBundleReleaseView,
    pub configuration: AdminSupportBundleConfigurationView,
    pub operations: AdminOperationsView,
    pub integrations: Vec<AdminSupportBundleIntegrationView>,
    pub diagnostics: Vec<AdminSupportBundleDiagnosticView>,
    pub exclusions: Vec<&'static str>,
}

impl AdminHttpService {
    pub(crate) async fn support_bundle(
        &self,
        request: BrowserRequestHeaders<'_>,
        operation_id: &str,
    ) -> Result<AdminSupportBundleView, AdminHttpServiceError> {
        let operations = self.operations(request).await?;
        let runtime = self.runtime()?;
        let (configuration, integrations) = runtime
            .within_timeout(async {
                let schema = check_schema_readiness(&runtime.pool)
                    .await
                    .map_err(|_| AdminHttpServiceError::Unavailable)?;
                let SchemaReadiness::Ready {
                    version: schema_version,
                } = schema
                else {
                    return Err(AdminHttpServiceError::Unavailable);
                };
                let settings = InstanceSettingsRepository::new(
                    runtime.pool.clone(),
                    runtime.policy.operation_timeout,
                )
                .map_err(|_| AdminHttpServiceError::Configuration)?
                .load()
                .await
                .map_err(|_| AdminHttpServiceError::Unavailable)?;
                let fingerprint_input = format!(
                    "schema={schema_version};registry={};count={}",
                    settings.registry_version(),
                    settings.len()
                );
                let fingerprint = Sha256::digest(fingerprint_input.as_bytes())
                    .iter()
                    .map(|byte| format!("{byte:02x}"))
                    .collect::<String>();
                let configuration = AdminSupportBundleConfigurationView {
                    database_schema_version: schema_version,
                    setting_registry_version: settings.registry_version(),
                    setting_count: settings.len(),
                    fingerprint,
                };
                Ok((configuration, load_integrations(runtime).await?))
            })
            .await?;

        let now = OffsetDateTime::now_utc();
        let generated_at = Timestamp::from_datetime(now)
            .map_err(|_| AdminHttpServiceError::Internal)?
            .to_string();
        let mut diagnostics = crate::observability::diagnostic_snapshot(63)
            .into_iter()
            .map(|event| AdminSupportBundleDiagnosticView {
                sequence: event.sequence,
                occurred_at_unix_ms: event.occurred_at_unix_ms,
                event_name: event.event_name.into(),
                level: event.level.into(),
                operation_id: event.operation_id,
                code: event.code.map(str::to_owned),
                status_code: event.status_code,
            })
            .collect::<Vec<_>>();
        diagnostics.push(AdminSupportBundleDiagnosticView {
            sequence: diagnostics
                .last()
                .map_or(0, |event| event.sequence.saturating_add(1)),
            occurred_at_unix_ms: u64::try_from(now.unix_timestamp_nanos() / 1_000_000)
                .map_err(|_| AdminHttpServiceError::Internal)?,
            event_name: "support_bundle.snapshot".into(),
            level: "INFO".into(),
            operation_id: Some(operation_id.to_owned()),
            code: operations.dependencies.category.clone(),
            status_code: None,
        });
        let preview = super::operations_service::support_bundle_preview();
        Ok(AdminSupportBundleView {
            schema_version: 1,
            format: preview.format,
            generated_at,
            retained_until: None,
            release: AdminSupportBundleReleaseView {
                version: VERSION.into(),
                operating_system: std::env::consts::OS,
                architecture: std::env::consts::ARCH,
            },
            configuration,
            operations,
            integrations,
            diagnostics,
            exclusions: preview.excludes,
        })
    }
}

async fn load_integrations(
    runtime: &super::http_service::AdminRuntime,
) -> Result<Vec<AdminSupportBundleIntegrationView>, AdminHttpServiceError> {
    let mut connection = runtime
        .pool
        .acquire()
        .await
        .map_err(|_| AdminHttpServiceError::Unavailable)?;
    let row = sqlx::query(
        "SELECT \
           (SELECT COUNT(*)::bigint FROM oidc_providers WHERE status='active') AS oidc_active, \
           (SELECT COUNT(*)::bigint FROM oidc_providers WHERE status='disabled') AS oidc_disabled, \
           (SELECT COUNT(*)::bigint FROM git_providers WHERE status='active') AS git_active, \
           (SELECT COUNT(*)::bigint FROM git_providers WHERE status='disabled') AS git_disabled, \
           (SELECT COUNT(*)::bigint FROM registry_connections WHERE status='active') AS registry_active, \
           (SELECT COUNT(*)::bigint FROM registry_connections WHERE status='disabled') AS registry_disabled",
    )
    .fetch_one(&mut *connection)
    .await
    .map_err(|_| AdminHttpServiceError::Unavailable)?;
    let count = |name: &str| -> Result<u64, AdminHttpServiceError> {
        let value: i64 = row
            .try_get(name)
            .map_err(|_| AdminHttpServiceError::Internal)?;
        u64::try_from(value).map_err(|_| AdminHttpServiceError::Internal)
    };
    Ok(vec![
        AdminSupportBundleIntegrationView {
            kind: "oidc",
            active_count: count("oidc_active")?,
            disabled_count: count("oidc_disabled")?,
        },
        AdminSupportBundleIntegrationView {
            kind: "git",
            active_count: count("git_active")?,
            disabled_count: count("git_disabled")?,
        },
        AdminSupportBundleIntegrationView {
            kind: "package_registry",
            active_count: count("registry_active")?,
            disabled_count: count("registry_disabled")?,
        },
    ])
}

#[cfg(test)]
mod tests {
    #[test]
    fn support_bundle_contract_is_bounded_and_secret_free() {
        let preview = super::super::operations_service::support_bundle_preview();
        assert_eq!(preview.maximum_bytes, 65_536);
        assert_eq!(preview.includes.len(), 5);
        assert_eq!(preview.excludes.len(), 5);
        for forbidden in ["cookie", "token", "authorization", "private key", "source"] {
            assert!(
                preview
                    .excludes
                    .iter()
                    .any(|value| value.to_ascii_lowercase().contains(forbidden))
            );
        }
    }
}
