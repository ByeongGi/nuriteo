use serde::Serialize;
use utoipa::ToSchema;

use crate::identity::BrowserRequestHeaders;

use super::super::{Organization, OrganizationId, OrganizationPrincipal, OrganizationVersion};
use super::{OrganizationHttpError, OrganizationHttpService, map_organization_error};

#[derive(Debug, Clone, Serialize, ToSchema)]
#[serde(rename_all = "camelCase")]
pub(crate) struct OrganizationView {
    pub(crate) id: String,
    pub(crate) slug: String,
    pub(crate) display_name: String,
    pub(crate) status: String,
    pub(crate) created_at: String,
    pub(crate) updated_at: String,
    pub(crate) archived_at: Option<String>,
    pub(crate) version: i64,
}

impl From<Organization> for OrganizationView {
    fn from(value: Organization) -> Self {
        let fields = value.into_fields();
        Self {
            id: fields.id.to_string(),
            slug: fields.slug,
            display_name: fields.display_name,
            status: match fields.status {
                super::super::OrganizationStatus::Active => "active",
                super::super::OrganizationStatus::Archived => "archived",
            }
            .into(),
            created_at: fields.created_at.to_string(),
            updated_at: fields.updated_at.to_string(),
            archived_at: fields.archived_at.map(|value| value.to_string()),
            version: fields.lock_version.get(),
        }
    }
}

impl OrganizationHttpService {
    pub(crate) async fn create(
        &self,
        request: BrowserRequestHeaders<'_>,
        slug: String,
        display_name: String,
        correlation_id: &str,
    ) -> Result<OrganizationView, OrganizationHttpError> {
        let runtime = self.runtime()?;
        let identity = runtime.authenticate(request).await?;
        runtime
            .organizations
            .create(
                identity.user_id,
                slug,
                display_name,
                &identity.organization_audit(correlation_id),
            )
            .await
            .map(OrganizationView::from)
            .map_err(map_organization_error)
    }

    pub(crate) async fn get(
        &self,
        request: BrowserRequestHeaders<'_>,
        organization_id: OrganizationId,
    ) -> Result<OrganizationView, OrganizationHttpError> {
        let runtime = self.runtime()?;
        let identity = runtime.authenticate(request).await?;
        runtime
            .organizations
            .get(identity.read_principal(), organization_id)
            .await
            .map(OrganizationView::from)
            .map_err(map_organization_error)
    }

    pub(crate) async fn update(
        &self,
        request: BrowserRequestHeaders<'_>,
        organization_id: OrganizationId,
        version: OrganizationVersion,
        display_name: String,
        correlation_id: &str,
    ) -> Result<OrganizationView, OrganizationHttpError> {
        let runtime = self.runtime()?;
        let identity = runtime.authenticate(request).await?;
        runtime
            .organizations
            .update_display_name(
                OrganizationPrincipal::Owner(identity.user_id),
                organization_id,
                version,
                display_name,
                &identity.organization_audit(correlation_id),
            )
            .await
            .map(OrganizationView::from)
            .map_err(map_organization_error)
    }

    pub(crate) async fn archive(
        &self,
        request: BrowserRequestHeaders<'_>,
        organization_id: OrganizationId,
        version: OrganizationVersion,
        correlation_id: &str,
    ) -> Result<OrganizationView, OrganizationHttpError> {
        let runtime = self.runtime()?;
        let identity = runtime.authenticate(request).await?;
        runtime
            .organizations
            .archive(
                OrganizationPrincipal::Owner(identity.user_id),
                organization_id,
                version,
                &identity.organization_audit(correlation_id),
            )
            .await
            .map(OrganizationView::from)
            .map_err(map_organization_error)
    }
}
