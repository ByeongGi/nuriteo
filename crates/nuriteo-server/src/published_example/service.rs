use std::{fmt, str::FromStr, time::Duration};

use ::time::OffsetDateTime;
use sqlx::{Acquire, Postgres, Transaction};
use tokio::time;
use uuid::Uuid;

use crate::{
    database::{DatabaseError, DatabasePool},
    identity::{Timestamp, UserId},
    project::{EffectiveProjectRole, ProjectAccessError, ProjectAccessRepository, ProjectId},
    save::ProjectVersionId,
};

use super::{
    CreatePublishedExample, PublicPublishedExample, PublishedExample,
    PublishedExampleDeleteConfirmation, PublishedExampleError, PublishedExampleId,
    PublishedExampleName, PublishedExamplePublicId, PublishedExampleState, PublishedExampleVersion,
    PublishedExampleVersionId, PublishedExampleVisibility,
};

const MIN_TIMEOUT: Duration = Duration::from_millis(100);
const MAX_TIMEOUT: Duration = Duration::from_secs(30);
const DEFAULT_TIMEOUT: Duration = Duration::from_secs(5);
pub const MAX_PUBLIC_EXAMPLE_PAGE_SIZE: u16 = 100;

type ExampleRow = (
    String,
    String,
    String,
    String,
    String,
    String,
    String,
    String,
    i64,
    OffsetDateTime,
    OffsetDateTime,
    Option<OffsetDateTime>,
);

type VersionRow = (String, String, i64, String, OffsetDateTime);
type PublicRow = (String, String, String, i64, String, String, OffsetDateTime);

#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub struct PublishedExampleServicePolicy {
    operation_timeout: Duration,
}

impl PublishedExampleServicePolicy {
    pub fn new(operation_timeout: Duration) -> Result<Self, PublishedExampleError> {
        if !(MIN_TIMEOUT..=MAX_TIMEOUT).contains(&operation_timeout) {
            return Err(PublishedExampleError::InvalidInput);
        }
        Ok(Self { operation_timeout })
    }
}

impl Default for PublishedExampleServicePolicy {
    fn default() -> Self {
        Self {
            operation_timeout: DEFAULT_TIMEOUT,
        }
    }
}

#[derive(Clone)]
pub struct PublishedExampleService {
    pool: DatabasePool,
    policy: PublishedExampleServicePolicy,
}

impl fmt::Debug for PublishedExampleService {
    fn fmt(&self, formatter: &mut fmt::Formatter<'_>) -> fmt::Result {
        formatter
            .debug_struct("PublishedExampleService")
            .field("policy", &self.policy)
            .finish_non_exhaustive()
    }
}

impl PublishedExampleService {
    #[must_use]
    pub const fn new(pool: DatabasePool, policy: PublishedExampleServicePolicy) -> Self {
        Self { pool, policy }
    }

    pub async fn create(
        &self,
        request: CreatePublishedExample,
    ) -> Result<(PublishedExample, PublishedExampleVersion), PublishedExampleError> {
        let public_id = PublishedExamplePublicId::generate()?;
        self.run(self.create_inner(request, public_id)).await
    }

    async fn create_inner(
        &self,
        request: CreatePublishedExample,
        public_id: PublishedExamplePublicId,
    ) -> Result<(PublishedExample, PublishedExampleVersion), PublishedExampleError> {
        let mut connection = self.pool.acquire().await.map_err(map_database_error)?;
        let mut transaction = connection.begin().await.map_err(map_sql_error)?;
        authorize_project(
            &mut transaction,
            request.project_id,
            request.actor_user_id,
            EffectiveProjectRole::Write,
        )
        .await?;
        require_active_project(&mut transaction, request.project_id).await?;
        require_project_version(
            &mut transaction,
            request.project_id,
            request.project_version_id,
        )
        .await?;

        let example_id = PublishedExampleId::new();
        let version_id = PublishedExampleVersionId::new();
        sqlx::query(
            "INSERT INTO published_examples \
             (id,public_id,project_id,publisher_user_id,name,visibility,state,generation) \
             VALUES ($1::uuid,$2,$3::uuid,$4::uuid,$5,$6,'draft',0)",
        )
        .bind(example_id.to_string())
        .bind(public_id.as_str())
        .bind(request.project_id.to_string())
        .bind(request.actor_user_id.to_string())
        .bind(request.name.as_str())
        .bind(request.visibility.as_str())
        .execute(&mut *transaction)
        .await
        .map_err(map_insert_error)?;
        let version_row = sqlx::query_as::<_, VersionRow>(
            "INSERT INTO published_example_versions \
             (id,example_id,project_id,project_version_id,version_number,created_by_user_id) \
             VALUES ($1::uuid,$2::uuid,$3::uuid,$4::uuid,1,$5::uuid) \
             RETURNING id::text,project_version_id::text,version_number,created_by_user_id::text,created_at",
        )
        .bind(version_id.to_string())
        .bind(example_id.to_string())
        .bind(request.project_id.to_string())
        .bind(request.project_version_id.to_string())
        .bind(request.actor_user_id.to_string())
        .fetch_one(&mut *transaction)
        .await
        .map_err(map_insert_error)?;
        let row = sqlx::query_as::<_, ExampleRow>(
            "UPDATE published_examples SET state='published',active_version_id=$2::uuid,\
                    generation=1,updated_at=transaction_timestamp() WHERE id=$1::uuid \
             RETURNING id::text,public_id,project_id::text,publisher_user_id::text,name,visibility,\
                       state,active_version_id::text,generation,created_at,updated_at,unpublished_at",
        )
        .bind(example_id.to_string())
        .bind(version_id.to_string())
        .fetch_one(&mut *transaction)
        .await
        .map_err(map_sql_error)?;
        let example = decode_example(row)?;
        let version = decode_version(version_row)?;
        transaction.commit().await.map_err(map_commit_error)?;
        Ok((example, version))
    }

    pub async fn add_version(
        &self,
        actor_user_id: UserId,
        example_id: PublishedExampleId,
        project_version_id: ProjectVersionId,
        expected_generation: i64,
    ) -> Result<PublishedExampleVersion, PublishedExampleError> {
        self.run(self.add_version_inner(
            actor_user_id,
            example_id,
            project_version_id,
            expected_generation,
        ))
        .await
    }

    async fn add_version_inner(
        &self,
        actor_user_id: UserId,
        example_id: PublishedExampleId,
        project_version_id: ProjectVersionId,
        expected_generation: i64,
    ) -> Result<PublishedExampleVersion, PublishedExampleError> {
        let mut connection = self.pool.acquire().await.map_err(map_database_error)?;
        let mut transaction = connection.begin().await.map_err(map_sql_error)?;
        let (project_id, generation) = lock_example_identity(&mut transaction, example_id).await?;
        require_expected_generation(generation, expected_generation)?;
        authorize_project(
            &mut transaction,
            project_id,
            actor_user_id,
            EffectiveProjectRole::Write,
        )
        .await?;
        require_active_project(&mut transaction, project_id).await?;
        require_project_version(&mut transaction, project_id, project_version_id).await?;
        let next_number: i64 = sqlx::query_scalar(
            "SELECT COALESCE(MAX(version_number),0)+1 FROM published_example_versions \
             WHERE example_id=$1::uuid",
        )
        .bind(example_id.to_string())
        .fetch_one(&mut *transaction)
        .await
        .map_err(map_sql_error)?;
        let version_id = PublishedExampleVersionId::new();
        let row = sqlx::query_as::<_, VersionRow>(
            "INSERT INTO published_example_versions \
             (id,example_id,project_id,project_version_id,version_number,created_by_user_id) \
             VALUES ($1::uuid,$2::uuid,$3::uuid,$4::uuid,$5,$6::uuid) \
             RETURNING id::text,project_version_id::text,version_number,created_by_user_id::text,created_at",
        )
        .bind(version_id.to_string())
        .bind(example_id.to_string())
        .bind(project_id.to_string())
        .bind(project_version_id.to_string())
        .bind(next_number)
        .bind(actor_user_id.to_string())
        .fetch_one(&mut *transaction)
        .await
        .map_err(map_insert_error)?;
        advance_generation(&mut transaction, example_id, expected_generation).await?;
        let version = decode_version(row)?;
        transaction.commit().await.map_err(map_commit_error)?;
        Ok(version)
    }

    pub async fn select_active_version(
        &self,
        actor_user_id: UserId,
        example_id: PublishedExampleId,
        version_id: PublishedExampleVersionId,
        expected_generation: i64,
    ) -> Result<PublishedExample, PublishedExampleError> {
        self.run(self.mutate_inner(
            actor_user_id,
            example_id,
            expected_generation,
            Mutation::SelectVersion(version_id),
        ))
        .await
    }

    pub async fn set_visibility(
        &self,
        actor_user_id: UserId,
        example_id: PublishedExampleId,
        visibility: PublishedExampleVisibility,
        expected_generation: i64,
    ) -> Result<PublishedExample, PublishedExampleError> {
        self.run(self.mutate_inner(
            actor_user_id,
            example_id,
            expected_generation,
            Mutation::SetVisibility(visibility),
        ))
        .await
    }

    pub async fn unpublish(
        &self,
        actor_user_id: UserId,
        example_id: PublishedExampleId,
        expected_generation: i64,
    ) -> Result<PublishedExample, PublishedExampleError> {
        self.run(self.mutate_inner(
            actor_user_id,
            example_id,
            expected_generation,
            Mutation::Unpublish,
        ))
        .await
    }

    pub async fn republish(
        &self,
        actor_user_id: UserId,
        example_id: PublishedExampleId,
        expected_generation: i64,
    ) -> Result<PublishedExample, PublishedExampleError> {
        self.run(self.mutate_inner(
            actor_user_id,
            example_id,
            expected_generation,
            Mutation::Republish,
        ))
        .await
    }

    async fn mutate_inner(
        &self,
        actor_user_id: UserId,
        example_id: PublishedExampleId,
        expected_generation: i64,
        mutation: Mutation,
    ) -> Result<PublishedExample, PublishedExampleError> {
        let mut connection = self.pool.acquire().await.map_err(map_database_error)?;
        let mut transaction = connection.begin().await.map_err(map_sql_error)?;
        let (project_id, generation) = lock_example_identity(&mut transaction, example_id).await?;
        require_expected_generation(generation, expected_generation)?;
        authorize_project(
            &mut transaction,
            project_id,
            actor_user_id,
            EffectiveProjectRole::Write,
        )
        .await?;
        let row = match mutation {
            Mutation::SelectVersion(version_id) => {
                let belongs: bool = sqlx::query_scalar(
                    "SELECT EXISTS(SELECT 1 FROM published_example_versions \
                     WHERE example_id=$1::uuid AND id=$2::uuid)",
                )
                .bind(example_id.to_string())
                .bind(version_id.to_string())
                .fetch_one(&mut *transaction)
                .await
                .map_err(map_sql_error)?;
                if !belongs {
                    return Err(PublishedExampleError::NotFound);
                }
                update_active_version(
                    &mut transaction,
                    example_id,
                    version_id,
                    expected_generation,
                )
                .await?
            }
            Mutation::SetVisibility(visibility) => {
                update_visibility(
                    &mut transaction,
                    example_id,
                    visibility,
                    expected_generation,
                )
                .await?
            }
            Mutation::Unpublish => {
                update_publication_state(
                    &mut transaction,
                    example_id,
                    PublishedExampleState::Unpublished,
                    expected_generation,
                )
                .await?
            }
            Mutation::Republish => {
                update_publication_state(
                    &mut transaction,
                    example_id,
                    PublishedExampleState::Published,
                    expected_generation,
                )
                .await?
            }
        };
        let example = decode_example(row)?;
        transaction.commit().await.map_err(map_commit_error)?;
        Ok(example)
    }

    pub async fn delete(
        &self,
        actor_user_id: UserId,
        example_id: PublishedExampleId,
        expected_generation: i64,
        confirmation: &PublishedExampleDeleteConfirmation,
    ) -> Result<(), PublishedExampleError> {
        self.run(self.delete_inner(actor_user_id, example_id, expected_generation, confirmation))
            .await
    }

    async fn delete_inner(
        &self,
        actor_user_id: UserId,
        example_id: PublishedExampleId,
        expected_generation: i64,
        confirmation: &PublishedExampleDeleteConfirmation,
    ) -> Result<(), PublishedExampleError> {
        let mut connection = self.pool.acquire().await.map_err(map_database_error)?;
        let mut transaction = connection.begin().await.map_err(map_sql_error)?;
        let row: Option<(String, i64, String)> = sqlx::query_as(
            "SELECT project_id::text,generation,name FROM published_examples \
             WHERE id=$1::uuid FOR UPDATE",
        )
        .bind(example_id.to_string())
        .fetch_optional(&mut *transaction)
        .await
        .map_err(map_sql_error)?;
        let (project_id, generation, name) = row.ok_or(PublishedExampleError::NotFound)?;
        require_expected_generation(generation, expected_generation)?;
        let project_id = project_id
            .parse()
            .map_err(|_| PublishedExampleError::InvariantViolation)?;
        authorize_project(
            &mut transaction,
            project_id,
            actor_user_id,
            EffectiveProjectRole::Admin,
        )
        .await?;
        if !confirmation.recently_reauthenticated || confirmation.name.as_str() != name {
            return Err(PublishedExampleError::ConfirmationRequired);
        }
        let result =
            sqlx::query("DELETE FROM published_examples WHERE id=$1::uuid AND generation=$2")
                .bind(example_id.to_string())
                .bind(expected_generation)
                .execute(&mut *transaction)
                .await
                .map_err(map_sql_error)?;
        require_one_row(result.rows_affected())?;
        transaction.commit().await.map_err(map_commit_error)
    }

    /// Resolves a stable representative URL or a fixed numeric Version URL.
    /// Unpublished/deleted Examples deliberately collapse to `NotFound`.
    pub async fn resolve_public(
        &self,
        public_id: &PublishedExamplePublicId,
        version_number: Option<i64>,
    ) -> Result<PublicPublishedExample, PublishedExampleError> {
        if version_number.is_some_and(|value| value < 1) {
            return Err(PublishedExampleError::InvalidInput);
        }
        self.run(self.resolve_public_inner(public_id, version_number))
            .await
    }

    async fn resolve_public_inner(
        &self,
        public_id: &PublishedExamplePublicId,
        version_number: Option<i64>,
    ) -> Result<PublicPublishedExample, PublishedExampleError> {
        let mut connection = self.pool.acquire().await.map_err(map_database_error)?;
        let row = sqlx::query_as::<_, PublicRow>(
            "SELECT example.public_id,example.name,example.visibility,version.version_number,\
                    version.project_version_id::text,reference.bundle_id::text,version.created_at \
             FROM published_examples example \
             JOIN published_example_versions version ON version.example_id=example.id \
             JOIN project_bundle_refs reference ON reference.id=version.project_version_id \
                  AND reference.project_id=version.project_id AND reference.kind='version' \
             WHERE example.public_id=$1 AND example.state='published' \
               AND (($2::bigint IS NULL AND version.id=example.active_version_id) \
                    OR version.version_number=$2)",
        )
        .bind(public_id.as_str())
        .bind(version_number)
        .fetch_optional(&mut *connection)
        .await
        .map_err(map_sql_error)?
        .ok_or(PublishedExampleError::NotFound)?;
        decode_public(row)
    }

    /// Returns only catalog-visible Examples and always applies a hard upper bound.
    pub async fn list_public(
        &self,
        limit: u16,
    ) -> Result<Vec<PublicPublishedExample>, PublishedExampleError> {
        if !(1..=MAX_PUBLIC_EXAMPLE_PAGE_SIZE).contains(&limit) {
            return Err(PublishedExampleError::InvalidInput);
        }
        self.run(self.list_public_inner(limit)).await
    }

    async fn list_public_inner(
        &self,
        limit: u16,
    ) -> Result<Vec<PublicPublishedExample>, PublishedExampleError> {
        let mut connection = self.pool.acquire().await.map_err(map_database_error)?;
        let rows = sqlx::query_as::<_, PublicRow>(
            "SELECT example.public_id,example.name,example.visibility,version.version_number,\
                    version.project_version_id::text,reference.bundle_id::text,version.created_at \
             FROM published_examples example \
             JOIN published_example_versions version ON version.id=example.active_version_id \
             JOIN project_bundle_refs reference ON reference.id=version.project_version_id \
                  AND reference.project_id=version.project_id AND reference.kind='version' \
             WHERE example.state='published' AND example.visibility='public' \
             ORDER BY example.created_at DESC,example.id DESC LIMIT $1",
        )
        .bind(i64::from(limit))
        .fetch_all(&mut *connection)
        .await
        .map_err(map_sql_error)?;
        rows.into_iter().map(decode_public).collect()
    }

    async fn run<T>(
        &self,
        future: impl std::future::Future<Output = Result<T, PublishedExampleError>>,
    ) -> Result<T, PublishedExampleError> {
        time::timeout(self.policy.operation_timeout, future)
            .await
            .map_err(|_| PublishedExampleError::OperationTimeout)?
    }
}

enum Mutation {
    SelectVersion(PublishedExampleVersionId),
    SetVisibility(PublishedExampleVisibility),
    Unpublish,
    Republish,
}

async fn authorize_project(
    transaction: &mut Transaction<'_, Postgres>,
    project_id: ProjectId,
    actor_user_id: UserId,
    minimum: EffectiveProjectRole,
) -> Result<(), PublishedExampleError> {
    let role = ProjectAccessRepository::resolve_effective_role_for_update(
        transaction,
        project_id,
        actor_user_id,
    )
    .await
    .map_err(map_access_error)?;
    if role == EffectiveProjectRole::None {
        return Err(PublishedExampleError::NotFound);
    }
    if role < minimum {
        return Err(PublishedExampleError::Forbidden);
    }
    Ok(())
}

async fn require_active_project(
    transaction: &mut Transaction<'_, Postgres>,
    project_id: ProjectId,
) -> Result<(), PublishedExampleError> {
    let state: Option<String> =
        sqlx::query_scalar("SELECT state FROM projects WHERE id=$1::uuid FOR SHARE")
            .bind(project_id.to_string())
            .fetch_optional(&mut **transaction)
            .await
            .map_err(map_sql_error)?;
    match state.as_deref() {
        Some("active") => Ok(()),
        Some("archived") => Err(PublishedExampleError::ProjectUnavailable),
        Some(_) => Err(PublishedExampleError::InvariantViolation),
        None => Err(PublishedExampleError::NotFound),
    }
}

async fn require_project_version(
    transaction: &mut Transaction<'_, Postgres>,
    project_id: ProjectId,
    project_version_id: ProjectVersionId,
) -> Result<(), PublishedExampleError> {
    let exists: bool = sqlx::query_scalar(
        "SELECT EXISTS(SELECT 1 FROM project_bundle_refs \
         WHERE id=$1::uuid AND project_id=$2::uuid AND kind='version')",
    )
    .bind(project_version_id.to_string())
    .bind(project_id.to_string())
    .fetch_one(&mut **transaction)
    .await
    .map_err(map_sql_error)?;
    if exists {
        Ok(())
    } else {
        Err(PublishedExampleError::VersionUnavailable)
    }
}

async fn lock_example_identity(
    transaction: &mut Transaction<'_, Postgres>,
    example_id: PublishedExampleId,
) -> Result<(ProjectId, i64), PublishedExampleError> {
    let row: Option<(String, i64)> = sqlx::query_as(
        "SELECT project_id::text,generation FROM published_examples \
         WHERE id=$1::uuid FOR UPDATE",
    )
    .bind(example_id.to_string())
    .fetch_optional(&mut **transaction)
    .await
    .map_err(map_sql_error)?;
    let (project_id, generation) = row.ok_or(PublishedExampleError::NotFound)?;
    Ok((
        project_id
            .parse()
            .map_err(|_| PublishedExampleError::InvariantViolation)?,
        generation,
    ))
}

fn require_expected_generation(actual: i64, expected: i64) -> Result<(), PublishedExampleError> {
    if expected < 1 {
        return Err(PublishedExampleError::InvalidInput);
    }
    if actual != expected {
        return Err(PublishedExampleError::StaleGeneration);
    }
    Ok(())
}

async fn advance_generation(
    transaction: &mut Transaction<'_, Postgres>,
    example_id: PublishedExampleId,
    expected_generation: i64,
) -> Result<(), PublishedExampleError> {
    let result = sqlx::query(
        "UPDATE published_examples SET generation=generation+1,updated_at=transaction_timestamp() \
         WHERE id=$1::uuid AND generation=$2",
    )
    .bind(example_id.to_string())
    .bind(expected_generation)
    .execute(&mut **transaction)
    .await
    .map_err(map_sql_error)?;
    require_one_row(result.rows_affected())
}

async fn update_active_version(
    transaction: &mut Transaction<'_, Postgres>,
    example_id: PublishedExampleId,
    version_id: PublishedExampleVersionId,
    expected_generation: i64,
) -> Result<ExampleRow, PublishedExampleError> {
    sqlx::query_as::<_, ExampleRow>(
        "UPDATE published_examples SET active_version_id=$3::uuid,generation=generation+1,\
         updated_at=transaction_timestamp() WHERE id=$1::uuid AND generation=$2 \
         RETURNING id::text,public_id,project_id::text,publisher_user_id::text,name,visibility,\
                   state,active_version_id::text,generation,created_at,updated_at,unpublished_at",
    )
    .bind(example_id.to_string())
    .bind(expected_generation)
    .bind(version_id.to_string())
    .fetch_optional(&mut **transaction)
    .await
    .map_err(map_sql_error)?
    .ok_or(PublishedExampleError::StaleGeneration)
}

async fn update_visibility(
    transaction: &mut Transaction<'_, Postgres>,
    example_id: PublishedExampleId,
    visibility: PublishedExampleVisibility,
    expected_generation: i64,
) -> Result<ExampleRow, PublishedExampleError> {
    sqlx::query_as::<_, ExampleRow>(
        "UPDATE published_examples SET visibility=$3,generation=generation+1,\
         updated_at=transaction_timestamp() WHERE id=$1::uuid AND generation=$2 \
         RETURNING id::text,public_id,project_id::text,publisher_user_id::text,name,visibility,\
                   state,active_version_id::text,generation,created_at,updated_at,unpublished_at",
    )
    .bind(example_id.to_string())
    .bind(expected_generation)
    .bind(visibility.as_str())
    .fetch_optional(&mut **transaction)
    .await
    .map_err(map_sql_error)?
    .ok_or(PublishedExampleError::StaleGeneration)
}

async fn update_publication_state(
    transaction: &mut Transaction<'_, Postgres>,
    example_id: PublishedExampleId,
    state: PublishedExampleState,
    expected_generation: i64,
) -> Result<ExampleRow, PublishedExampleError> {
    let query = match state {
        PublishedExampleState::Published => sqlx::query_as::<_, ExampleRow>(
            "UPDATE published_examples SET state='published',unpublished_at=NULL,\
             generation=generation+1,updated_at=transaction_timestamp() \
             WHERE id=$1::uuid AND generation=$2 AND state='unpublished' \
             RETURNING id::text,public_id,project_id::text,publisher_user_id::text,name,visibility,\
                       state,active_version_id::text,generation,created_at,updated_at,unpublished_at",
        ),
        PublishedExampleState::Unpublished => sqlx::query_as::<_, ExampleRow>(
            "UPDATE published_examples SET state='unpublished',unpublished_at=transaction_timestamp(),\
             generation=generation+1,updated_at=transaction_timestamp() \
             WHERE id=$1::uuid AND generation=$2 AND state='published' \
             RETURNING id::text,public_id,project_id::text,publisher_user_id::text,name,visibility,\
                       state,active_version_id::text,generation,created_at,updated_at,unpublished_at",
        ),
    };
    query
        .bind(example_id.to_string())
        .bind(expected_generation)
        .fetch_optional(&mut **transaction)
        .await
        .map_err(map_sql_error)?
        .ok_or(PublishedExampleError::InvalidLifecycle)
}

fn require_one_row(rows: u64) -> Result<(), PublishedExampleError> {
    match rows {
        1 => Ok(()),
        0 => Err(PublishedExampleError::StaleGeneration),
        _ => Err(PublishedExampleError::InvariantViolation),
    }
}

fn decode_example(row: ExampleRow) -> Result<PublishedExample, PublishedExampleError> {
    let state = PublishedExampleState::parse(&row.6)?;
    let unpublished_at = row
        .11
        .map(Timestamp::from_datetime)
        .transpose()
        .map_err(|_| PublishedExampleError::InvariantViolation)?;
    if row.8 < 1
        || (state == PublishedExampleState::Published && unpublished_at.is_some())
        || (state == PublishedExampleState::Unpublished && unpublished_at.is_none())
    {
        return Err(PublishedExampleError::InvariantViolation);
    }
    Ok(PublishedExample {
        id: row.0.parse()?,
        public_id: row.1.parse()?,
        project_id: row
            .2
            .parse()
            .map_err(|_| PublishedExampleError::InvariantViolation)?,
        publisher_user_id: row
            .3
            .parse()
            .map_err(|_| PublishedExampleError::InvariantViolation)?,
        name: PublishedExampleName::new(row.4)?,
        visibility: PublishedExampleVisibility::parse(&row.5)?,
        state,
        active_version_id: row.7.parse()?,
        generation: row.8,
        created_at: Timestamp::from_datetime(row.9)
            .map_err(|_| PublishedExampleError::InvariantViolation)?,
        updated_at: Timestamp::from_datetime(row.10)
            .map_err(|_| PublishedExampleError::InvariantViolation)?,
        unpublished_at,
    })
}

fn decode_version(row: VersionRow) -> Result<PublishedExampleVersion, PublishedExampleError> {
    if row.2 < 1 {
        return Err(PublishedExampleError::InvariantViolation);
    }
    Ok(PublishedExampleVersion {
        id: row.0.parse()?,
        project_version_id: ProjectVersionId::from_str(&row.1)
            .map_err(|_| PublishedExampleError::InvariantViolation)?,
        version_number: row.2,
        created_by_user_id: row
            .3
            .parse()
            .map_err(|_| PublishedExampleError::InvariantViolation)?,
        created_at: Timestamp::from_datetime(row.4)
            .map_err(|_| PublishedExampleError::InvariantViolation)?,
    })
}

fn decode_public(row: PublicRow) -> Result<PublicPublishedExample, PublishedExampleError> {
    if row.3 < 1 {
        return Err(PublishedExampleError::InvariantViolation);
    }
    Ok(PublicPublishedExample {
        public_id: row.0.parse()?,
        name: PublishedExampleName::new(row.1)?,
        visibility: PublishedExampleVisibility::parse(&row.2)?,
        version_number: row.3,
        project_version_id: ProjectVersionId::from_str(&row.4)
            .map_err(|_| PublishedExampleError::InvariantViolation)?,
        bundle_id: Uuid::parse_str(&row.5)
            .map_err(|_| PublishedExampleError::InvariantViolation)?,
        published_at: Timestamp::from_datetime(row.6)
            .map_err(|_| PublishedExampleError::InvariantViolation)?,
    })
}

fn map_database_error(error: DatabaseError) -> PublishedExampleError {
    match error {
        DatabaseError::AcquireTimeout => PublishedExampleError::OperationTimeout,
        _ => PublishedExampleError::DatabaseUnavailable,
    }
}

fn map_access_error(error: ProjectAccessError) -> PublishedExampleError {
    match error {
        ProjectAccessError::OperationTimeout => PublishedExampleError::OperationTimeout,
        ProjectAccessError::PersistenceUnavailable => PublishedExampleError::DatabaseUnavailable,
        ProjectAccessError::InvalidPersistedState => PublishedExampleError::InvariantViolation,
        _ => PublishedExampleError::NotFound,
    }
}

fn map_insert_error(error: sqlx::Error) -> PublishedExampleError {
    if let Some(database) = error.as_database_error()
        && matches!(
            database.constraint(),
            Some("published_examples_public_id_key")
        )
    {
        return PublishedExampleError::PublicIdConflict;
    }
    map_sql_error(error)
}

fn map_sql_error(error: sqlx::Error) -> PublishedExampleError {
    match error
        .as_database_error()
        .and_then(|database| database.code())
        .as_deref()
    {
        Some("57014" | "55P03") => PublishedExampleError::OperationTimeout,
        Some("23503" | "23514") => PublishedExampleError::InvariantViolation,
        _ => PublishedExampleError::DatabaseUnavailable,
    }
}

fn map_commit_error(error: sqlx::Error) -> PublishedExampleError {
    if error.as_database_error().is_some() {
        map_sql_error(error)
    } else {
        PublishedExampleError::CommitOutcomeUnknown
    }
}
