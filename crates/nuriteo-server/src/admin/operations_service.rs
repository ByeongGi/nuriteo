use serde::Serialize;
use sqlx::Row;
use time::OffsetDateTime;
use utoipa::ToSchema;

use crate::health::{ReadinessState, UnavailableCategory};
use crate::identity::{BrowserRequestHeaders, Timestamp};
use crate::save::{CleanupOperationsSnapshot, CleanupOperatorState};

use super::{AdminHttpService, AdminHttpServiceError};

#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, ToSchema)]
#[serde(rename_all = "snake_case")]
pub enum AdminOperationsState {
    Nominal,
    Degraded,
    Unavailable,
}

#[derive(Debug, Clone, Serialize, ToSchema)]
#[serde(rename_all = "camelCase")]
pub struct AdminDependencyStatusView {
    pub state: AdminOperationsState,
    pub category: Option<String>,
}

#[derive(Debug, Clone, Serialize, ToSchema)]
#[serde(rename_all = "camelCase")]
pub struct AdminCleanupQueueView {
    pub state: AdminOperationsState,
    pub queue_depth: Option<u64>,
    pub oldest_eligible_age_seconds: Option<u64>,
    pub running_count: Option<u64>,
    pub retry_count: Option<u64>,
    pub failed_count: Option<u64>,
}

#[derive(Debug, Clone, Serialize, ToSchema)]
#[serde(rename_all = "camelCase")]
pub struct AdminUsageView {
    pub state: AdminOperationsState,
    pub active_users: Option<u64>,
    pub active_organizations: Option<u64>,
    pub active_projects: Option<u64>,
    pub verified_bundles: Option<u64>,
    pub tracked_physical_bytes: Option<String>,
    pub reserved_bytes: Option<String>,
}

#[derive(Debug, Clone, Serialize, ToSchema)]
#[serde(rename_all = "camelCase")]
pub struct AdminOperationsView {
    pub generated_at: String,
    pub overall_state: AdminOperationsState,
    pub dependencies: AdminDependencyStatusView,
    pub cleanup: AdminCleanupQueueView,
    pub usage: AdminUsageView,
    pub support_bundle: AdminSupportBundlePreviewView,
}

#[derive(Debug, Clone, Serialize, ToSchema)]
#[serde(rename_all = "camelCase")]
pub struct AdminSupportBundlePreviewView {
    pub format: &'static str,
    pub maximum_bytes: u32,
    pub includes: Vec<&'static str>,
    pub excludes: Vec<&'static str>,
}

pub(super) fn support_bundle_preview() -> AdminSupportBundlePreviewView {
    AdminSupportBundlePreviewView {
        format: "nuriteo-support-bundle-v1+json",
        maximum_bytes: 65_536,
        includes: vec![
            "release and non-sensitive runtime identity",
            "database schema and configuration fingerprint",
            "dependency, cleanup, and aggregate usage state",
            "integration kind and active/disabled counts",
            "bounded diagnostic codes and operation ID",
        ],
        excludes: vec![
            "Project source, Bundles, and object payloads",
            "terminal output and runtime console text",
            "environment values, cookies, tokens, and authorization headers",
            "OIDC claims, private keys, CA PEM, and integration authentication material",
            "request bodies, response bodies, and database application records",
        ],
    }
}

impl AdminHttpService {
    pub(crate) async fn operations(
        &self,
        request: BrowserRequestHeaders<'_>,
    ) -> Result<AdminOperationsView, AdminHttpServiceError> {
        let runtime = self.runtime()?;
        runtime.authenticate(request).await?;
        runtime
            .within_timeout(async {
                let (dependency, cleanup, usage) = tokio::join!(
                    runtime.health.readiness(),
                    runtime.cleanup.snapshot(),
                    load_usage(runtime)
                );
                let dependencies = dependency_view(dependency);
                let cleanup = cleanup_view(cleanup.ok());
                let usage = usage.unwrap_or_else(|_| unavailable_usage());
                let overall_state = if dependencies.state == AdminOperationsState::Nominal
                    && cleanup.state == AdminOperationsState::Nominal
                    && usage.state == AdminOperationsState::Nominal
                {
                    AdminOperationsState::Nominal
                } else {
                    AdminOperationsState::Degraded
                };
                let generated_at = Timestamp::from_datetime(OffsetDateTime::now_utc())
                    .map_err(|_| AdminHttpServiceError::Internal)?
                    .to_string();
                Ok(AdminOperationsView {
                    generated_at,
                    overall_state,
                    dependencies,
                    cleanup,
                    usage,
                    support_bundle: support_bundle_preview(),
                })
            })
            .await
    }
}

fn dependency_view(state: ReadinessState) -> AdminDependencyStatusView {
    match state {
        ReadinessState::Ready => AdminDependencyStatusView {
            state: AdminOperationsState::Nominal,
            category: None,
        },
        ReadinessState::Unavailable(category) => AdminDependencyStatusView {
            state: AdminOperationsState::Degraded,
            category: Some(dependency_category(category).into()),
        },
    }
}

const fn dependency_category(category: UnavailableCategory) -> &'static str {
    match category {
        UnavailableCategory::Configuration => "configuration",
        UnavailableCategory::Capacity => "capacity",
        UnavailableCategory::Deadline => "deadline",
        UnavailableCategory::DatabaseTimeout => "database_timeout",
        UnavailableCategory::Database => "database",
        UnavailableCategory::SchemaPending => "schema_pending",
        UnavailableCategory::SchemaDirty => "schema_dirty",
        UnavailableCategory::SchemaChecksumMismatch => "schema_checksum_mismatch",
        UnavailableCategory::SchemaUnsupported => "schema_unsupported",
        UnavailableCategory::StorageTimeout => "object_storage_timeout",
        UnavailableCategory::Storage => "object_storage",
    }
}

fn cleanup_view(snapshot: Option<CleanupOperationsSnapshot>) -> AdminCleanupQueueView {
    let Some(snapshot) = snapshot else {
        return AdminCleanupQueueView {
            state: AdminOperationsState::Unavailable,
            queue_depth: None,
            oldest_eligible_age_seconds: None,
            running_count: None,
            retry_count: None,
            failed_count: None,
        };
    };
    AdminCleanupQueueView {
        state: match snapshot.state {
            CleanupOperatorState::Nominal => AdminOperationsState::Nominal,
            CleanupOperatorState::Degraded => AdminOperationsState::Degraded,
        },
        queue_depth: Some(snapshot.queue_depth),
        oldest_eligible_age_seconds: snapshot.oldest_eligible_age_seconds,
        running_count: Some(snapshot.running_count),
        retry_count: Some(snapshot.retry_count),
        failed_count: Some(snapshot.failed_count),
    }
}

async fn load_usage(
    runtime: &super::http_service::AdminRuntime,
) -> Result<AdminUsageView, AdminHttpServiceError> {
    let mut connection = runtime
        .pool
        .acquire()
        .await
        .map_err(|_| AdminHttpServiceError::Unavailable)?;
    let row = sqlx::query(
        "SELECT \
           (SELECT COUNT(*)::bigint FROM users WHERE status = 'active') AS active_users, \
           (SELECT COUNT(*)::bigint FROM organizations WHERE status = 'active') AS active_organizations, \
           (SELECT COUNT(*)::bigint FROM projects WHERE state = 'active') AS active_projects, \
           (SELECT COUNT(*)::bigint FROM bundles) AS verified_bundles, \
           (SELECT COALESCE(SUM(physical_bytes), 0)::text FROM bundles) AS tracked_physical_bytes, \
           (SELECT COALESCE(SUM(reserved_bytes), 0)::text FROM storage_reservations) AS reserved_bytes",
    )
    .fetch_one(&mut *connection)
    .await
    .map_err(|_| AdminHttpServiceError::Unavailable)?;
    Ok(AdminUsageView {
        state: AdminOperationsState::Nominal,
        active_users: Some(non_negative(read_column(&row, "active_users")?)?),
        active_organizations: Some(non_negative(read_column(&row, "active_organizations")?)?),
        active_projects: Some(non_negative(read_column(&row, "active_projects")?)?),
        verified_bundles: Some(non_negative(read_column(&row, "verified_bundles")?)?),
        tracked_physical_bytes: Some(decimal_bytes(read_column(&row, "tracked_physical_bytes")?)?),
        reserved_bytes: Some(decimal_bytes(read_column(&row, "reserved_bytes")?)?),
    })
}

fn read_column<T>(row: &sqlx::postgres::PgRow, name: &str) -> Result<T, AdminHttpServiceError>
where
    for<'row> T: sqlx::Decode<'row, sqlx::Postgres> + sqlx::Type<sqlx::Postgres>,
{
    row.try_get(name)
        .map_err(|_| AdminHttpServiceError::Internal)
}

fn non_negative(value: i64) -> Result<u64, AdminHttpServiceError> {
    u64::try_from(value).map_err(|_| AdminHttpServiceError::Internal)
}

fn decimal_bytes(value: String) -> Result<String, AdminHttpServiceError> {
    if value.is_empty() || value.len() > 20 || !value.bytes().all(|byte| byte.is_ascii_digit()) {
        return Err(AdminHttpServiceError::Internal);
    }
    Ok(value)
}

fn unavailable_usage() -> AdminUsageView {
    AdminUsageView {
        state: AdminOperationsState::Unavailable,
        active_users: None,
        active_organizations: None,
        active_projects: None,
        verified_bundles: None,
        tracked_physical_bytes: None,
        reserved_bytes: None,
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn dependency_categories_are_closed_and_storage_specific() {
        let view = dependency_view(ReadinessState::Unavailable(UnavailableCategory::Storage));
        assert_eq!(view.state, AdminOperationsState::Degraded);
        assert_eq!(view.category.as_deref(), Some("object_storage"));
        assert!(decimal_bytes("18446744073709551615".into()).is_ok());
        assert!(decimal_bytes("-1".into()).is_err());
    }

    #[test]
    fn missing_cleanup_snapshot_is_unavailable_without_identity() {
        let view = cleanup_view(None);
        assert_eq!(view.state, AdminOperationsState::Unavailable);
        assert_eq!(view.queue_depth, None);
    }
}
