mod personal;
mod repository;

pub use personal::{
    PersonalStorageScope, PersonalWorkspace, StorageScopeId, WorkspaceDomainError,
    WorkspaceOwnerType,
};
pub use repository::{PersonalStorageScopeRepository, StorageScopeRepositoryError};

#[cfg(test)]
mod tests;
