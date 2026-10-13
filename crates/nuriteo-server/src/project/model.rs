use serde::{Deserialize, Serialize};

use crate::identity::Timestamp;
use crate::workspace::StorageScopeId;

use super::{
    ProjectError, ProjectId, ProjectName, ProjectOwner, ProjectSlug, ProjectState, ProjectVersion,
};

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
pub(crate) struct ProjectFields {
    pub(crate) id: ProjectId,
    pub(crate) owner: ProjectOwner,
    pub(crate) storage_scope_id: StorageScopeId,
    pub(crate) slug: ProjectSlug,
    pub(crate) name: ProjectName,
    pub(crate) state: ProjectState,
    pub(crate) created_at: Timestamp,
    pub(crate) updated_at: Timestamp,
    pub(crate) archived_at: Option<Timestamp>,
    pub(crate) lock_version: ProjectVersion,
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(try_from = "ProjectFields")]
pub struct Project {
    id: ProjectId,
    owner: ProjectOwner,
    storage_scope_id: StorageScopeId,
    slug: ProjectSlug,
    name: ProjectName,
    state: ProjectState,
    created_at: Timestamp,
    updated_at: Timestamp,
    archived_at: Option<Timestamp>,
    lock_version: ProjectVersion,
}

impl Project {
    #[allow(
        clippy::too_many_arguments,
        reason = "persistence reconstruction is an explicit complete-row validation boundary"
    )]
    pub fn reconstruct(
        id: ProjectId,
        owner: ProjectOwner,
        storage_scope_id: StorageScopeId,
        slug: ProjectSlug,
        name: ProjectName,
        state: ProjectState,
        created_at: Timestamp,
        updated_at: Timestamp,
        archived_at: Option<Timestamp>,
        lock_version: ProjectVersion,
    ) -> Result<Self, ProjectError> {
        Self::new(ProjectFields {
            id,
            owner,
            storage_scope_id,
            slug,
            name,
            state,
            created_at,
            updated_at,
            archived_at,
            lock_version,
        })
    }

    pub(crate) fn new(fields: ProjectFields) -> Result<Self, ProjectError> {
        match (fields.state, fields.archived_at) {
            (ProjectState::Active, None) | (ProjectState::Archived, Some(_)) => {}
            _ => return Err(ProjectError::InvalidLifecycle),
        }
        if fields.updated_at < fields.created_at
            || fields.archived_at.is_some_and(|archived_at| {
                archived_at < fields.created_at || fields.updated_at < archived_at
            })
        {
            return Err(ProjectError::InvalidTimestampOrder);
        }

        Ok(Self {
            id: fields.id,
            owner: fields.owner,
            storage_scope_id: fields.storage_scope_id,
            slug: fields.slug,
            name: fields.name,
            state: fields.state,
            created_at: fields.created_at,
            updated_at: fields.updated_at,
            archived_at: fields.archived_at,
            lock_version: fields.lock_version,
        })
    }

    #[must_use]
    pub const fn id(&self) -> ProjectId {
        self.id
    }

    #[must_use]
    pub const fn owner(&self) -> ProjectOwner {
        self.owner
    }

    #[must_use]
    pub const fn storage_scope_id(&self) -> StorageScopeId {
        self.storage_scope_id
    }

    #[must_use]
    pub fn slug(&self) -> &ProjectSlug {
        &self.slug
    }

    #[must_use]
    pub fn name(&self) -> &ProjectName {
        &self.name
    }

    #[must_use]
    pub const fn state(&self) -> ProjectState {
        self.state
    }

    #[must_use]
    pub const fn created_at(&self) -> Timestamp {
        self.created_at
    }

    #[must_use]
    pub const fn updated_at(&self) -> Timestamp {
        self.updated_at
    }

    #[must_use]
    pub const fn archived_at(&self) -> Option<Timestamp> {
        self.archived_at
    }

    #[must_use]
    pub const fn lock_version(&self) -> ProjectVersion {
        self.lock_version
    }

    #[cfg(test)]
    #[must_use]
    pub(crate) fn into_fields(self) -> ProjectFields {
        ProjectFields {
            id: self.id,
            owner: self.owner,
            storage_scope_id: self.storage_scope_id,
            slug: self.slug,
            name: self.name,
            state: self.state,
            created_at: self.created_at,
            updated_at: self.updated_at,
            archived_at: self.archived_at,
            lock_version: self.lock_version,
        }
    }
}

impl TryFrom<ProjectFields> for Project {
    type Error = ProjectError;

    fn try_from(value: ProjectFields) -> Result<Self, Self::Error> {
        Self::new(value)
    }
}
