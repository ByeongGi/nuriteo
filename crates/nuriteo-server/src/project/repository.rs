use std::fmt;

use sqlx::{Postgres, Transaction};
use time::OffsetDateTime;

use crate::identity::Timestamp;
use crate::workspace::StorageScopeId;

use super::{
    Project, ProjectId, ProjectName, ProjectOwner, ProjectSlug, ProjectState, ProjectVersion,
};

type ProjectRow = (
    String,
    Option<String>,
    Option<String>,
    String,
    String,
    String,
    String,
    OffsetDateTime,
    OffsetDateTime,
    Option<OffsetDateTime>,
    i64,
);

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum ProjectConflict {
    IdentifierExists,
    NamespaceUnavailable,
    OwnerScopeMismatch,
}

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
#[non_exhaustive]
pub enum ProjectRepositoryError {
    Conflict(ProjectConflict),
    InvalidPersistedState,
    PersistenceUnavailable,
}

impl fmt::Display for ProjectRepositoryError {
    fn fmt(&self, formatter: &mut fmt::Formatter<'_>) -> fmt::Result {
        formatter.write_str(match self {
            Self::Conflict(ProjectConflict::IdentifierExists) => {
                "project identifier already exists"
            }
            Self::Conflict(ProjectConflict::NamespaceUnavailable) => {
                "project namespace is unavailable"
            }
            Self::Conflict(ProjectConflict::OwnerScopeMismatch) => {
                "project owner and storage scope do not match"
            }
            Self::InvalidPersistedState => "persisted project state is invalid",
            Self::PersistenceUnavailable => "project persistence is unavailable",
        })
    }
}

impl std::error::Error for ProjectRepositoryError {}

#[derive(Debug, Clone, PartialEq, Eq)]
pub struct NewProject {
    id: ProjectId,
    owner: ProjectOwner,
    storage_scope_id: StorageScopeId,
    slug: ProjectSlug,
    name: ProjectName,
    created_at: Timestamp,
}

impl NewProject {
    #[must_use]
    pub const fn new(
        id: ProjectId,
        owner: ProjectOwner,
        storage_scope_id: StorageScopeId,
        slug: ProjectSlug,
        name: ProjectName,
        created_at: Timestamp,
    ) -> Self {
        Self {
            id,
            owner,
            storage_scope_id,
            slug,
            name,
            created_at,
        }
    }
}

pub struct ProjectRepository;

impl ProjectRepository {
    /// Inserts one active Project without committing the caller-owned
    /// transaction. Owner authorization is deliberately outside this boundary.
    pub async fn create(
        transaction: &mut Transaction<'_, Postgres>,
        candidate: &NewProject,
    ) -> Result<Project, ProjectRepositoryError> {
        let (owner_user_id, owner_organization_id) = owner_columns(candidate.owner);
        let row = sqlx::query_as::<_, ProjectRow>(
            "INSERT INTO projects \
             (id, owner_user_id, owner_organization_id, storage_scope_id, slug, name, \
              state, created_at, updated_at, archived_at, lock_version) \
             VALUES ($1::uuid, $2::uuid, $3::uuid, $4::uuid, $5, $6, \
                     'active', $7::timestamptz, $7::timestamptz, NULL, 1) \
             RETURNING id::text, owner_user_id::text, owner_organization_id::text, \
                       storage_scope_id::text, slug, name, state, created_at, updated_at, \
                       archived_at, lock_version",
        )
        .bind(candidate.id.to_string())
        .bind(owner_user_id)
        .bind(owner_organization_id)
        .bind(candidate.storage_scope_id.to_string())
        .bind(candidate.slug.as_str())
        .bind(candidate.name.as_str())
        .bind(candidate.created_at.to_string())
        .fetch_one(&mut **transaction)
        .await
        .map_err(map_insert_error)?;
        decode_project(row)
    }

    /// Fetches a Project only inside the specified owner namespace.
    pub async fn get_by_id(
        transaction: &mut Transaction<'_, Postgres>,
        owner: ProjectOwner,
        project_id: ProjectId,
    ) -> Result<Option<Project>, ProjectRepositoryError> {
        let row = match owner {
            ProjectOwner::User(owner_id) => {
                sqlx::query_as::<_, ProjectRow>(
                    "SELECT id::text, owner_user_id::text, owner_organization_id::text, \
                            storage_scope_id::text, slug, name, state, created_at, updated_at, \
                            archived_at, lock_version FROM projects \
                     WHERE id = $1::uuid AND owner_user_id = $2::uuid \
                       AND owner_organization_id IS NULL",
                )
                .bind(project_id.to_string())
                .bind(owner_id.to_string())
                .fetch_optional(&mut **transaction)
                .await
            }
            ProjectOwner::Organization(owner_id) => {
                sqlx::query_as::<_, ProjectRow>(
                    "SELECT id::text, owner_user_id::text, owner_organization_id::text, \
                            storage_scope_id::text, slug, name, state, created_at, updated_at, \
                            archived_at, lock_version FROM projects \
                     WHERE id = $1::uuid AND owner_organization_id = $2::uuid \
                       AND owner_user_id IS NULL",
                )
                .bind(project_id.to_string())
                .bind(owner_id.to_string())
                .fetch_optional(&mut **transaction)
                .await
            }
        }
        .map_err(|_| ProjectRepositoryError::PersistenceUnavailable)?;
        row.map(decode_project).transpose()
    }

    /// Lists one owner's Projects in canonical `(slug, id)` order.
    pub async fn list_by_owner(
        transaction: &mut Transaction<'_, Postgres>,
        owner: ProjectOwner,
    ) -> Result<Vec<Project>, ProjectRepositoryError> {
        let rows = match owner {
            ProjectOwner::User(owner_id) => {
                sqlx::query_as::<_, ProjectRow>(
                    "SELECT id::text, owner_user_id::text, owner_organization_id::text, \
                            storage_scope_id::text, slug, name, state, created_at, updated_at, \
                            archived_at, lock_version FROM projects \
                     WHERE owner_user_id = $1::uuid AND owner_organization_id IS NULL \
                     ORDER BY slug ASC, id ASC",
                )
                .bind(owner_id.to_string())
                .fetch_all(&mut **transaction)
                .await
            }
            ProjectOwner::Organization(owner_id) => {
                sqlx::query_as::<_, ProjectRow>(
                    "SELECT id::text, owner_user_id::text, owner_organization_id::text, \
                            storage_scope_id::text, slug, name, state, created_at, updated_at, \
                            archived_at, lock_version FROM projects \
                     WHERE owner_organization_id = $1::uuid AND owner_user_id IS NULL \
                     ORDER BY slug ASC, id ASC",
                )
                .bind(owner_id.to_string())
                .fetch_all(&mut **transaction)
                .await
            }
        }
        .map_err(|_| ProjectRepositoryError::PersistenceUnavailable)?;
        rows.into_iter().map(decode_project).collect()
    }

    /// Locks one Project for a caller that will perform authorization and audit
    /// orchestration in the same transaction. This method grants no authority.
    pub async fn lock_by_id(
        transaction: &mut Transaction<'_, Postgres>,
        project_id: ProjectId,
    ) -> Result<Option<Project>, ProjectRepositoryError> {
        let row = sqlx::query_as::<_, ProjectRow>(
            "SELECT id::text, owner_user_id::text, owner_organization_id::text, \
                    storage_scope_id::text, slug, name, state, created_at, updated_at, \
                    archived_at, lock_version FROM projects \
             WHERE id = $1::uuid FOR UPDATE",
        )
        .bind(project_id.to_string())
        .fetch_optional(&mut **transaction)
        .await
        .map_err(|_| ProjectRepositoryError::PersistenceUnavailable)?;
        row.map(decode_project).transpose()
    }
}

fn owner_columns(owner: ProjectOwner) -> (Option<String>, Option<String>) {
    match owner {
        ProjectOwner::User(id) => (Some(id.to_string()), None),
        ProjectOwner::Organization(id) => (None, Some(id.to_string())),
    }
}

fn decode_project(row: ProjectRow) -> Result<Project, ProjectRepositoryError> {
    let id = row
        .0
        .parse()
        .map_err(|_| ProjectRepositoryError::InvalidPersistedState)?;
    let owner_user_id = row
        .1
        .map(|value| value.parse())
        .transpose()
        .map_err(|_| ProjectRepositoryError::InvalidPersistedState)?;
    let owner_organization_id = row
        .2
        .map(|value| value.parse())
        .transpose()
        .map_err(|_| ProjectRepositoryError::InvalidPersistedState)?;
    let owner = ProjectOwner::from_nullable_ids(owner_user_id, owner_organization_id)
        .map_err(|_| ProjectRepositoryError::InvalidPersistedState)?;
    let storage_scope_id = row
        .3
        .parse()
        .map_err(|_| ProjectRepositoryError::InvalidPersistedState)?;
    let slug =
        ProjectSlug::new(row.4).map_err(|_| ProjectRepositoryError::InvalidPersistedState)?;
    let name =
        ProjectName::new(row.5).map_err(|_| ProjectRepositoryError::InvalidPersistedState)?;
    let state = match row.6.as_str() {
        "active" => ProjectState::Active,
        "archived" => ProjectState::Archived,
        _ => return Err(ProjectRepositoryError::InvalidPersistedState),
    };
    let created_at = Timestamp::from_datetime(row.7)
        .map_err(|_| ProjectRepositoryError::InvalidPersistedState)?;
    let updated_at = Timestamp::from_datetime(row.8)
        .map_err(|_| ProjectRepositoryError::InvalidPersistedState)?;
    let archived_at = row
        .9
        .map(Timestamp::from_datetime)
        .transpose()
        .map_err(|_| ProjectRepositoryError::InvalidPersistedState)?;
    let lock_version =
        ProjectVersion::new(row.10).map_err(|_| ProjectRepositoryError::InvalidPersistedState)?;
    Project::reconstruct(
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
    )
    .map_err(|_| ProjectRepositoryError::InvalidPersistedState)
}

fn map_insert_error(error: sqlx::Error) -> ProjectRepositoryError {
    let sqlx::Error::Database(database) = &error else {
        return ProjectRepositoryError::PersistenceUnavailable;
    };
    match (database.code().as_deref(), database.constraint()) {
        (Some("23505"), Some("projects_pkey")) => {
            ProjectRepositoryError::Conflict(ProjectConflict::IdentifierExists)
        }
        (Some("23505"), _) => {
            ProjectRepositoryError::Conflict(ProjectConflict::NamespaceUnavailable)
        }
        (Some("23503"), _) => ProjectRepositoryError::Conflict(ProjectConflict::OwnerScopeMismatch),
        _ => ProjectRepositoryError::PersistenceUnavailable,
    }
}
