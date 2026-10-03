mod repository;
mod service;

pub use repository::SetupStatusRepositoryError;
pub use service::{
    SetupStatus, SetupStatusPolicy, SetupStatusPolicyError, SetupStatusService,
    SetupStatusServiceError,
};

#[cfg(test)]
mod tests;
