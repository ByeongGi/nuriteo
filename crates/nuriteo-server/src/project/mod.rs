mod model;
mod repository;
mod types;

use std::fmt;

pub use model::Project;
#[cfg(test)]
pub(crate) use model::ProjectFields;
pub use repository::{
    DEFAULT_PROJECT_PAGE_SIZE, MAX_PROJECT_PAGE_SIZE, NewProject, ProjectConflict, ProjectPage,
    ProjectPageKey, ProjectPageLimit, ProjectRepository, ProjectRepositoryError,
};
pub use types::{ProjectId, ProjectName, ProjectOwner, ProjectSlug, ProjectState, ProjectVersion};

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
#[non_exhaustive]
pub enum ProjectError {
    InvalidIdentifier,
    NilIdentifier,
    IdentifierMustBeVersion7,
    InvalidOwner,
    InvalidSlug,
    InvalidName,
    InvalidLifecycle,
    InvalidTimestampOrder,
    InvalidLockVersion,
    LockVersionExhausted,
}

impl fmt::Display for ProjectError {
    fn fmt(&self, formatter: &mut fmt::Formatter<'_>) -> fmt::Result {
        formatter.write_str(match self {
            Self::InvalidIdentifier => "project identifier is invalid",
            Self::NilIdentifier => "project identifier must not be nil",
            Self::IdentifierMustBeVersion7 => "project identifier must be UUID version 7",
            Self::InvalidOwner => "project must have exactly one owner",
            Self::InvalidSlug => "project slug is not canonical",
            Self::InvalidName => "project name is invalid",
            Self::InvalidLifecycle => "project lifecycle state is invalid",
            Self::InvalidTimestampOrder => "project timestamps are out of order",
            Self::InvalidLockVersion => "project lock version is invalid",
            Self::LockVersionExhausted => "project lock version is exhausted",
        })
    }
}

impl std::error::Error for ProjectError {}

#[cfg(test)]
mod tests;
