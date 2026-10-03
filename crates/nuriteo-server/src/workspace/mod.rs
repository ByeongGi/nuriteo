mod personal;
mod repository;
mod routes;
mod service;

pub use personal::{
    PersonalStorageScope, PersonalWorkspace, StorageScopeId, WorkspaceDomainError,
    WorkspaceOwnerType,
};
pub use repository::{PersonalStorageScopeRepository, StorageScopeRepositoryError};
pub(crate) use routes::openapi_router;
pub(crate) use service::{WorkspaceQueryError, WorkspaceQueryService};

#[cfg(test)]
mod tests;
