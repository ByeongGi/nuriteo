use serde::Serialize;
use serde_json::json;
use sqlx::{Acquire, Row};
use time::OffsetDateTime;
use utoipa::ToSchema;

use crate::VERSION;
use crate::audit::{
    ActorType, AuditActor, AuditEvent, AuditEventFields, AuditEventId, AuditMetadata, AuditResult,
    AuditScope, AuditTarget, AuditWriter, ScopeType,
};
use crate::identity::{BrowserRequestHeaders, Timestamp};
use crate::upgrade_preflight::{self, UpgradePreflightError, UpgradeSchemaState};

use super::http_service::{AdminHttpService, AdminHttpServiceError, authorize_recent_admin};

const HISTORY_LIMIT: i64 = 20;
const APPROVAL_ACTION: &str = "instance.update_approved";

#[derive(Debug, Clone, Serialize, ToSchema)]
#[serde(rename_all = "camelCase")]
pub struct AdminUpdateCompatibilityView {
    pub release_lineage: String,
    pub source_migration: i64,
    pub configuration_registry_version: u16,
    pub schema_policy: &'static str,
    pub object_policy: &'static str,
    pub image_policy: &'static str,
    pub failure_policy: &'static str,
}

#[derive(Debug, Clone, Serialize, ToSchema)]
#[serde(rename_all = "camelCase")]
pub struct AdminUpdatePreflightView {
    pub state: &'static str,
    pub schema_state: Option<String>,
    pub current_migration: Option<i64>,
    pub target_migration: Option<i64>,
    pub blocker_code: Option<&'static str>,
}

#[derive(Debug, Clone, Serialize, ToSchema)]
#[serde(rename_all = "camelCase")]
pub struct AdminUpdateBlockerView {
    pub code: &'static str,
    pub summary: &'static str,
    pub operator_action: &'static str,
}

#[derive(Debug, Clone, Serialize, ToSchema)]
#[serde(rename_all = "camelCase")]
pub struct AdminUpdateReadinessView {
    pub generated_at: String,
    pub current_release: &'static str,
    pub target_release: String,
    pub state: &'static str,
    pub approval_allowed: bool,
    pub compatibility: AdminUpdateCompatibilityView,
    pub preflight: AdminUpdatePreflightView,
    pub blockers: Vec<AdminUpdateBlockerView>,
}

#[derive(Debug, Clone, Serialize, ToSchema)]
#[serde(rename_all = "camelCase")]
pub struct AdminUpdateHistoryItemView {
    pub id: String,
    pub occurred_at: String,
    pub action: &'static str,
    pub target_release: String,
    pub result: &'static str,
}

#[derive(Debug, Clone, Serialize, ToSchema)]
#[serde(rename_all = "camelCase")]
pub struct AdminUpdateHistoryView {
    pub items: Vec<AdminUpdateHistoryItemView>,
}

#[derive(Debug, Clone, Serialize, ToSchema)]
#[serde(rename_all = "camelCase")]
pub struct AdminUpdateApprovalView {
    pub id: String,
    pub approved_at: String,
    pub target_release: String,
    pub state: &'static str,
    pub execution_started: bool,
}

impl AdminHttpService {
    pub(crate) async fn update_readiness(
        &self,
        request: BrowserRequestHeaders<'_>,
    ) -> Result<AdminUpdateReadinessView, AdminHttpServiceError> {
        let runtime = self.runtime()?;
        runtime.authenticate(request).await?;
        runtime.within_timeout(build_readiness(&runtime.pool)).await
    }

    pub(crate) async fn update_history(
        &self,
        request: BrowserRequestHeaders<'_>,
    ) -> Result<AdminUpdateHistoryView, AdminHttpServiceError> {
        let runtime = self.runtime()?;
        runtime.authenticate(request).await?;
        runtime
            .within_timeout(async {
                let mut connection = runtime
                    .pool
                    .acquire()
                    .await
                    .map_err(|_| AdminHttpServiceError::Unavailable)?;
                let rows = sqlx::query(
                    "SELECT id::text, occurred_at, target_id FROM audit_events \
                     WHERE action_code = $1 AND target_type = 'update_release' \
                     ORDER BY occurred_at DESC, id DESC LIMIT $2",
                )
                .bind(APPROVAL_ACTION)
                .bind(HISTORY_LIMIT)
                .fetch_all(&mut *connection)
                .await
                .map_err(|_| AdminHttpServiceError::Unavailable)?;
                let items = rows
                    .into_iter()
                    .map(|row| {
                        let occurred_at: OffsetDateTime = row
                            .try_get("occurred_at")
                            .map_err(|_| AdminHttpServiceError::Internal)?;
                        Ok(AdminUpdateHistoryItemView {
                            id: row
                                .try_get("id")
                                .map_err(|_| AdminHttpServiceError::Internal)?,
                            occurred_at: Timestamp::from_datetime(occurred_at)
                                .map_err(|_| AdminHttpServiceError::Internal)?
                                .to_string(),
                            action: "approved",
                            target_release: row
                                .try_get("target_id")
                                .map_err(|_| AdminHttpServiceError::Internal)?,
                            result: "recorded",
                        })
                    })
                    .collect::<Result<Vec<_>, _>>()?;
                Ok(AdminUpdateHistoryView { items })
            })
            .await
    }

    pub(crate) async fn approve_update(
        &self,
        request: BrowserRequestHeaders<'_>,
        target_release: &str,
        acknowledged: bool,
        correlation_id: &str,
    ) -> Result<AdminUpdateApprovalView, AdminHttpServiceError> {
        let compatibility = upgrade_preflight::compatibility_contract()
            .map_err(|_| AdminHttpServiceError::Unavailable)?;
        if target_release != compatibility.target_release || !acknowledged {
            return Err(AdminHttpServiceError::InvalidUpdateApproval);
        }
        let runtime = self.runtime()?;
        let session = runtime.authenticate(request).await?;
        let readiness = runtime
            .within_timeout(build_readiness(&runtime.pool))
            .await?;
        if !readiness.approval_allowed {
            return Err(AdminHttpServiceError::UpdateBlocked);
        }
        runtime
            .within_timeout(async {
                let mut connection = runtime
                    .pool
                    .acquire()
                    .await
                    .map_err(|_| AdminHttpServiceError::Unavailable)?;
                let mut transaction = connection
                    .begin()
                    .await
                    .map_err(|_| AdminHttpServiceError::Unavailable)?;
                let actor = authorize_recent_admin(&mut transaction, session).await?;
                let event_id = AuditEventId::new();
                let event = AuditEvent::new(AuditEventFields {
                    id: event_id,
                    occurred_at: actor.occurred_at,
                    actor: AuditActor {
                        kind: ActorType::User,
                        id: actor.user_id.to_string(),
                        user_id: Some(actor.user_id),
                        display_name: Some(actor.display_name),
                    },
                    action_code: APPROVAL_ACTION.into(),
                    target: AuditTarget {
                        kind: "update_release".into(),
                        id: compatibility.target_release.clone(),
                    },
                    scope: AuditScope {
                        kind: ScopeType::Instance,
                        id: "instance".into(),
                    },
                    result: AuditResult::Succeeded,
                    reason_code: None,
                    correlation_id: correlation_id.into(),
                    source_ip: None,
                    schema_version: 1,
                    changed_fields: vec!["approval".into()],
                    metadata: AuditMetadata::new(json!({
                        "source": "admin-update-api",
                        "executionStarted": false,
                        "preflightState": readiness.preflight.state,
                    }))
                    .map_err(|_| AdminHttpServiceError::Internal)?,
                })
                .map_err(|_| AdminHttpServiceError::Internal)?;
                AuditWriter::append(&mut transaction, &event)
                    .await
                    .map_err(|_| AdminHttpServiceError::AuditUnavailable)?;
                transaction
                    .commit()
                    .await
                    .map_err(|_| AdminHttpServiceError::Unavailable)?;
                Ok(AdminUpdateApprovalView {
                    id: event_id.to_string(),
                    approved_at: actor.occurred_at.to_string(),
                    target_release: compatibility.target_release,
                    state: "approved",
                    execution_started: false,
                })
            })
            .await
    }
}

async fn build_readiness(
    pool: &crate::database::DatabasePool,
) -> Result<AdminUpdateReadinessView, AdminHttpServiceError> {
    let generated_at = Timestamp::from_datetime(OffsetDateTime::now_utc())
        .map_err(|_| AdminHttpServiceError::Internal)?
        .to_string();
    let compatibility = upgrade_preflight::compatibility_contract()
        .map_err(|_| AdminHttpServiceError::Unavailable)?;
    let (preflight, blockers) = match upgrade_preflight::execute(pool).await {
        Ok(report) => {
            let schema_state = schema_state_name(report.schema_state()).to_owned();
            (
                AdminUpdatePreflightView {
                    state: "passed",
                    schema_state: Some(schema_state),
                    current_migration: Some(report.current_migration()),
                    target_migration: Some(report.target_migration()),
                    blocker_code: None,
                },
                Vec::new(),
            )
        }
        Err(error) => {
            let code = error.category();
            (
                AdminUpdatePreflightView {
                    state: "blocked",
                    schema_state: None,
                    current_migration: None,
                    target_migration: None,
                    blocker_code: Some(code),
                },
                vec![blocker(error)],
            )
        }
    };
    let approval_allowed =
        blockers.is_empty() && preflight.schema_state.as_deref() != Some("already-current");
    let state = if !blockers.is_empty() {
        "blocked"
    } else if approval_allowed {
        "ready"
    } else {
        "current"
    };
    Ok(AdminUpdateReadinessView {
        generated_at,
        current_release: VERSION,
        target_release: compatibility.target_release,
        state,
        approval_allowed,
        compatibility: AdminUpdateCompatibilityView {
            release_lineage: compatibility.release_lineage,
            source_migration: compatibility.source_migration,
            configuration_registry_version: compatibility.configuration_registry_version,
            schema_policy: "forward-only exact-prefix",
            object_policy: "read-in-place; rewrite forbidden",
            image_policy: "complete digest-pinned release set",
            failure_policy: "stop-before-mutation",
        },
        preflight,
        blockers,
    })
}

const fn schema_state_name(state: UpgradeSchemaState) -> &'static str {
    match state {
        UpgradeSchemaState::UpgradeRequired => "upgrade-required",
        UpgradeSchemaState::PartiallyApplied => "partially-applied",
        UpgradeSchemaState::AlreadyCurrent => "already-current",
    }
}

fn blocker(error: UpgradePreflightError) -> AdminUpdateBlockerView {
    let (summary, operator_action) = match error {
        UpgradePreflightError::Manifest => (
            "The embedded compatibility contract is invalid.",
            "Install an intact, supported Server release before retrying.",
        ),
        UpgradePreflightError::Database => (
            "The database preflight could not be completed.",
            "Restore database availability, then run readiness again.",
        ),
        UpgradePreflightError::FreshDatabase => (
            "This database has no supported source migration history.",
            "Complete a supported installation instead of using the upgrade path.",
        ),
        UpgradePreflightError::SchemaDirty => (
            "The migration history contains an incomplete migration.",
            "Resolve the interrupted migration before approving an update.",
        ),
        UpgradePreflightError::SchemaChecksumMismatch => (
            "A migration checksum differs from the supported release history.",
            "Restore the supported migration history; do not bypass this check.",
        ),
        UpgradePreflightError::SchemaUnsupported => (
            "The database schema is newer than this release supports.",
            "Use a compatible application release or perform a documented full restore.",
        ),
        UpgradePreflightError::SchemaSourceUnsupported => (
            "The database is not at a supported update starting point.",
            "Follow each required update stop before retrying.",
        ),
        UpgradePreflightError::ConfigurationRegistry => (
            "Persisted settings do not match the required configuration registry.",
            "Repair the supported settings registry before approving an update.",
        ),
    };
    AdminUpdateBlockerView {
        code: error.category(),
        summary,
        operator_action,
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn blocker_messages_are_actionable_and_do_not_expose_runtime_details() {
        for error in [
            UpgradePreflightError::Manifest,
            UpgradePreflightError::Database,
            UpgradePreflightError::FreshDatabase,
            UpgradePreflightError::SchemaDirty,
            UpgradePreflightError::SchemaChecksumMismatch,
            UpgradePreflightError::SchemaUnsupported,
            UpgradePreflightError::SchemaSourceUnsupported,
            UpgradePreflightError::ConfigurationRegistry,
        ] {
            let view = blocker(error);
            assert!(!view.summary.is_empty());
            assert!(!view.operator_action.is_empty());
            let rendered = format!("{} {} {}", view.code, view.summary, view.operator_action);
            assert!(!rendered.contains("postgres://"));
            assert!(!rendered.contains("password"));
        }
    }

    #[test]
    fn compatibility_view_contains_no_digests_or_secret_material() {
        let contract = upgrade_preflight::compatibility_contract().unwrap();
        let view = AdminUpdateCompatibilityView {
            release_lineage: contract.release_lineage,
            source_migration: contract.source_migration,
            configuration_registry_version: contract.configuration_registry_version,
            schema_policy: "forward-only exact-prefix",
            object_policy: "read-in-place; rewrite forbidden",
            image_policy: "complete digest-pinned release set",
            failure_policy: "stop-before-mutation",
        };
        let rendered = serde_json::to_string(&view).unwrap();
        assert!(!rendered.contains("sha256:"));
        assert!(!rendered.contains("credential"));
    }
}
