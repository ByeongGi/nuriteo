mod repository;
mod routes;
mod service;

pub use repository::SetupStatusRepositoryError;
pub(crate) use routes::openapi_router;
pub use service::{
    SetupStatus, SetupStatusPolicy, SetupStatusPolicyError, SetupStatusService,
    SetupStatusServiceError,
};

#[cfg(test)]
mod tests;
