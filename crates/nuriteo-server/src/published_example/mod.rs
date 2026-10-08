mod content;
mod fork;
mod http_routes;
mod http_service;
mod service;
mod types;

use std::fmt;

pub(crate) use content::{
    PublishedContentDownload, PublishedContentError, PublishedContentService,
};
pub use fork::{
    ForkPublishedExample, PublishedExampleForkError, PublishedExampleForkKey,
    PublishedExampleForkPolicy, PublishedExampleForkResult, PublishedExampleForkService,
};
pub use service::{
    MAX_PUBLIC_EXAMPLE_PAGE_SIZE, PublishedExampleService, PublishedExampleServicePolicy,
};
pub use types::{
    CreatePublishedExample, PublicPublishedExample, PublishedExample,
    PublishedExampleDeleteConfirmation, PublishedExampleId, PublishedExampleName,
    PublishedExamplePublicId, PublishedExampleState, PublishedExampleVersion,
    PublishedExampleVersionId, PublishedExampleVisibility,
};

#[derive(Clone, Copy, Debug, PartialEq, Eq)]
#[non_exhaustive]
pub enum PublishedExampleError {
    InvalidInput,
    EntropyUnavailable,
    NotFound,
    Forbidden,
    ProjectUnavailable,
    VersionUnavailable,
    InvalidLifecycle,
    StaleGeneration,
    ConfirmationRequired,
    PublicIdConflict,
    OperationTimeout,
    DatabaseUnavailable,
    CommitOutcomeUnknown,
    InvariantViolation,
}

impl fmt::Display for PublishedExampleError {
    fn fmt(&self, formatter: &mut fmt::Formatter<'_>) -> fmt::Result {
        formatter.write_str(match self {
            Self::InvalidInput => "Published Example input is invalid",
            Self::EntropyUnavailable => "Published Example identifier entropy is unavailable",
            Self::NotFound => "Published Example was not found",
            Self::Forbidden => "Published Example operation is forbidden",
            Self::ProjectUnavailable => "Project cannot be published in its current state",
            Self::VersionUnavailable => "Project Version is unavailable",
            Self::InvalidLifecycle => "Published Example lifecycle transition is invalid",
            Self::StaleGeneration => "Published Example generation is stale",
            Self::ConfirmationRequired => "Published Example deletion confirmation is required",
            Self::PublicIdConflict => "Published Example public identifier conflicts",
            Self::OperationTimeout => "Published Example operation timed out",
            Self::DatabaseUnavailable => "Published Example persistence is unavailable",
            Self::CommitOutcomeUnknown => "Published Example commit outcome is unknown",
            Self::InvariantViolation => "Published Example persistence state is invalid",
        })
    }
}

impl std::error::Error for PublishedExampleError {}

#[cfg(test)]
mod tests;
pub(crate) use http_routes::openapi_router;
pub use http_service::{
    ForkedProjectView, PublicPreviewAdmissionKey, PublicPublishedExampleListView,
    PublicPublishedExampleView, PublishedExampleCreateView, PublishedExampleForkView,
    PublishedExampleHttpError, PublishedExampleHttpService, PublishedExampleVersionMutationView,
    PublishedExampleVersionView, PublishedExampleView,
};
