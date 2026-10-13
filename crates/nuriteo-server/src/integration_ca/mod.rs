//! Administrator-facing custom CA lifecycle for outbound integrations.

mod http_routes;
mod http_service;

pub(crate) use http_routes::openapi_router;
pub use http_service::IntegrationCaHttpService;
pub(crate) use http_service::{IntegrationCaCollectionView, IntegrationCaView};
