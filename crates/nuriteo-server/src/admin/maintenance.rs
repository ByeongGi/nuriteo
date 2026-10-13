use std::time::Duration;

use serde::Serialize;
use serde_json::json;
use sqlx::Acquire;
use utoipa::ToSchema;

use crate::audit::{
    ActorType, AuditActor, AuditEvent, AuditEventFields, AuditEventId, AuditMetadata, AuditResult,
    AuditScope, AuditTarget, AuditWriter, ScopeType,
};
use crate::identity::BrowserRequestHeaders;
use crate::maintenance::{MaintenanceError, MaintenancePhase};

use super::http_service::{AdminHttpService, AdminHttpServiceError, authorize_recent_admin};

const DRAIN_TIMEOUT: Duration = Duration::from_secs(10);

#[derive(Debug, Clone, Serialize, ToSchema)]
#[serde(rename_all = "camelCase")]
pub struct AdminMaintenanceView {
    pub phase: &'static str,
    pub active_writes: usize,
    pub write_admission_open: bool,
}

impl AdminHttpService {
    pub(crate) async fn maintenance_status(
        &self,
        request: BrowserRequestHeaders<'_>,
    ) -> Result<AdminMaintenanceView, AdminHttpServiceError> {
        let runtime = self.runtime()?;
        runtime.authenticate(request).await?;
        self.maintenance_view()
    }

    pub(crate) async fn set_maintenance(
        &self,
        request: BrowserRequestHeaders<'_>,
        enabled: bool,
        correlation_id: &str,
    ) -> Result<AdminMaintenanceView, AdminHttpServiceError> {
        let runtime = self.runtime()?;
        let session = runtime.authenticate(request).await?;
        let actor = runtime
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
                transaction
                    .commit()
                    .await
                    .map_err(|_| AdminHttpServiceError::Unavailable)?;
                Ok(actor)
            })
            .await?;

        let gate = self
            .maintenance
            .as_ref()
            .ok_or(AdminHttpServiceError::Unavailable)?;
        if enabled {
            gate.enter_maintenance(DRAIN_TIMEOUT)
                .await
                .map_err(map_maintenance_error)?;
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
                let event = AuditEvent::new(AuditEventFields {
                    id: AuditEventId::new(),
                    occurred_at: actor.occurred_at,
                    actor: AuditActor {
                        kind: ActorType::User,
                        id: actor.user_id.to_string(),
                        user_id: Some(actor.user_id),
                        display_name: Some(actor.display_name),
                    },
                    action_code: if enabled {
                        "instance.maintenance_enabled".into()
                    } else {
                        "instance.maintenance_disabled".into()
                    },
                    target: AuditTarget {
                        kind: "instance".into(),
                        id: "instance".into(),
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
                    changed_fields: vec!["maintenance_mode".into()],
                    metadata: AuditMetadata::new(json!({
                        "source": "admin-maintenance-api",
                        "enabled": enabled,
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
                    .map_err(|_| AdminHttpServiceError::Unavailable)
            })
            .await?;
        if !enabled {
            gate.resume();
        }
        self.maintenance_view()
    }

    fn maintenance_view(&self) -> Result<AdminMaintenanceView, AdminHttpServiceError> {
        let gate = self
            .maintenance
            .as_ref()
            .ok_or(AdminHttpServiceError::Unavailable)?;
        let phase = gate.phase();
        Ok(AdminMaintenanceView {
            phase: match phase {
                MaintenancePhase::Active => "active",
                MaintenancePhase::Draining => "draining",
                MaintenancePhase::Maintenance => "maintenance",
            },
            active_writes: gate.active_writes(),
            write_admission_open: phase == MaintenancePhase::Active,
        })
    }
}

const fn map_maintenance_error(error: MaintenanceError) -> AdminHttpServiceError {
    match error {
        MaintenanceError::WriteAdmissionClosed => AdminHttpServiceError::Unavailable,
        MaintenanceError::DrainTimedOut => AdminHttpServiceError::OperationTimeout,
    }
}
