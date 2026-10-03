mod personal;
mod repository;
mod routes;
mod service;

pub use personal::{
    OrganizationStorageScope, OrganizationWorkspace, PersonalStorageScope, PersonalWorkspace,
    StorageScopeId, Workspace, WorkspaceDomainError, WorkspaceOwnerType,
};
pub use repository::{
    OrganizationStorageScopeRepository, PersonalStorageScopeRepository, StorageScopeRepositoryError,
};
pub(crate) use routes::openapi_router;
pub(crate) use service::{WorkspaceQueryError, WorkspaceQueryService};

#[cfg(test)]
mod tests;
