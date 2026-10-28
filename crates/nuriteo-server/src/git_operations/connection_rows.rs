#![allow(unused_imports)]
use super::materialization::*;
use super::remotes::*;
use super::*;

use std::any::Any;

use std::fmt;

use std::future::Future;

use std::pin::Pin;

use std::str::FromStr;

use std::sync::Arc;

use std::time::Duration;

use ::time::OffsetDateTime;

use sqlx::{Acquire, PgConnection, Postgres, Row, Transaction};

use tokio::time;

use uuid::Uuid;

use crate::database::DatabasePool;

use crate::git_provider::{
    GitProviderError, GitProviderMetadata, GitProviderService, GitProviderState,
};

use crate::identity::{SessionId, UserId};

use crate::integration::{
    CredentialIdentity, IntegrationError, IntegrationRepository, MasterKeyring, SecretValue,
};

use crate::object_storage::S3ObjectStore;

use crate::project::{EffectiveProjectRole, ProjectAccessRepository, ProjectId};

use crate::quota::EffectiveQuota;

use crate::workspace::StorageScopeId;

pub(crate) use http_routes::openapi_router;

use super::{
    CREDENTIAL_KIND, DEFAULT_OPERATION_TIMEOUT, GitCredential, GitCredentialConnection,
    GitExecution, GitExecutionFuture, GitExecutorError, GitOperationError, GitOperationOutcome,
    GitOperationService, GitPushExecution, GitRemoteBinding, GitRemoteExecutor, GitUpdateExecution,
    GitWorkingHeadFuture, GitWorkingHeadPreparation, GitWorkingHeadPrepare, GitWorkingHeadStore,
    INSTANCE_ID, INTEGRATION_TYPE, MAX_BRANCH_BYTES, MAX_CHANGED_OBJECTS, MAX_COMMIT_MESSAGE_BYTES,
    MAX_OPERATION_TIMEOUT, MAX_TRANSFER_BYTES, MIN_OPERATION_TIMEOUT, UnavailableGitExecutor,
    UnavailableGitWorkingHeadStore, map_executor_error, map_integration_error, map_provider_error,
};
pub use http_service::{GitHttpError, GitHttpService};

pub(crate) async fn project_storage_scope(
    tx: &mut Transaction<'_, Postgres>,
    project_id: ProjectId,
) -> Result<StorageScopeId, GitOperationError> {
    let value: String = sqlx::query_scalar(
        "SELECT storage_scope_id::text FROM projects WHERE id=$1::uuid AND state='active'",
    )
    .bind(project_id.to_string())
    .fetch_optional(&mut **tx)
    .await
    .map_err(|_| GitOperationError::Unavailable)?
    .ok_or(GitOperationError::NotFound)?;
    StorageScopeId::from_str(&value).map_err(|_| GitOperationError::Unavailable)
}

pub(crate) async fn lock_provider(
    tx: &mut Transaction<'_, Postgres>,
    id: Uuid,
) -> Result<GitProviderMetadata, GitOperationError> {
    lock_provider_by_id(tx, id).await
}

pub(crate) async fn lock_provider_by_id(
    tx: &mut Transaction<'_, Postgres>,
    id: Uuid,
) -> Result<GitProviderMetadata, GitOperationError> {
    let row = sqlx::query(
        "SELECT id::text,display_name,provider_kind,canonical_host,canonical_port,api_base_url,
         oauth_authorization_url,oauth_token_url,oauth_client_id,status,allows_read,allows_write,
         config_version,validated_at,created_at,updated_at FROM git_providers
         WHERE id=$1::uuid FOR SHARE",
    )
    .bind(id.to_string())
    .fetch_optional(&mut **tx)
    .await
    .map_err(|_| GitOperationError::Unavailable)?
    .ok_or(GitOperationError::ProviderUnavailable)?;
    decode_provider(&row)
}

pub(crate) async fn lock_provider_generation(
    tx: &mut Transaction<'_, Postgres>,
    expected: &GitProviderMetadata,
    write: bool,
) -> Result<(), GitOperationError> {
    let actual = lock_provider_by_id(tx, expected.id).await?;
    if actual.state != GitProviderState::Active
        || actual.config_version != expected.config_version
        || !actual.allows_read
        || (write && !actual.allows_write)
    {
        return Err(GitOperationError::ProviderUnavailable);
    }
    Ok(())
}

pub(crate) async fn load_user_credential(
    integrations: &IntegrationRepository,
    tx: &mut Transaction<'_, Postgres>,
    user_id: UserId,
    provider_id: Uuid,
) -> Result<GitCredential, GitOperationError> {
    let row = sqlx::query(
        "SELECT id::text,credential_id::text,credential_version FROM user_git_credentials
         WHERE user_id=$1::uuid AND provider_id=$2::uuid FOR SHARE",
    )
    .bind(user_id.to_string())
    .bind(provider_id.to_string())
    .fetch_optional(&mut **tx)
    .await
    .map_err(|_| GitOperationError::Unavailable)?
    .ok_or(GitOperationError::CredentialUnavailable)?;
    let id = parse_uuid(row.get::<&str, _>("id"))?;
    let credential_id = parse_uuid(row.get::<&str, _>("credential_id"))?;
    let version = parse_version(row.get("credential_version"))?;
    let (identity, stored_version, secret) = integrations
        .read_credential_by_id_in_transaction(tx, credential_id)
        .await
        .map_err(map_integration_error)?;
    if identity != credential_identity(id)? || stored_version != version {
        return Err(GitOperationError::CredentialUnavailable);
    }
    Ok(GitCredential(secret))
}

pub(crate) async fn lock_connection(
    tx: &mut Transaction<'_, Postgres>,
    user_id: UserId,
    id: Uuid,
    expected_version: u64,
) -> Result<GitCredentialConnection, GitOperationError> {
    let row = sqlx::query(
        "SELECT id::text,user_id::text,provider_id::text,credential_version,connection_version,
         created_at,updated_at FROM user_git_credentials WHERE id=$1::uuid AND user_id=$2::uuid FOR UPDATE",
    ).bind(id.to_string()).bind(user_id.to_string()).fetch_optional(&mut **tx).await
        .map_err(|_| GitOperationError::Unavailable)?.ok_or(GitOperationError::NotFound)?;
    let current = connection_from_row(&row)?;
    if current.connection_version != expected_version {
        return Err(GitOperationError::Conflict);
    }
    Ok(current)
}

pub(crate) async fn remote_exists(
    tx: &mut Transaction<'_, Postgres>,
    project_id: ProjectId,
) -> Result<bool, GitOperationError> {
    sqlx::query_scalar("SELECT EXISTS(SELECT 1 FROM project_git_remotes WHERE project_id=$1::uuid)")
        .bind(project_id.to_string())
        .fetch_one(&mut **tx)
        .await
        .map_err(|_| GitOperationError::Unavailable)
}

pub(crate) async fn lock_remote(
    tx: &mut Transaction<'_, Postgres>,
    project_id: ProjectId,
) -> Result<GitRemoteBinding, GitOperationError> {
    let row = sqlx::query(
        "SELECT project_id::text,provider_id::text,repository_url,branch,remote_head_sha,
         remote_version,created_at,updated_at FROM project_git_remotes WHERE project_id=$1::uuid FOR UPDATE",
    ).bind(project_id.to_string()).fetch_optional(&mut **tx).await
        .map_err(|_| GitOperationError::Unavailable)?.ok_or(GitOperationError::NotFound)?;
    remote_from_row(&row)
}

pub(crate) async fn load_remote(
    tx: &mut Transaction<'_, Postgres>,
    project_id: ProjectId,
) -> Result<GitRemoteBinding, GitOperationError> {
    let row = sqlx::query(
        "SELECT project_id::text,provider_id::text,repository_url,branch,remote_head_sha,\
         remote_version,created_at,updated_at FROM project_git_remotes WHERE project_id=$1::uuid",
    )
    .bind(project_id.to_string())
    .fetch_optional(&mut **tx)
    .await
    .map_err(|_| GitOperationError::Unavailable)?
    .ok_or(GitOperationError::NotFound)?;
    remote_from_row(&row)
}

pub(crate) fn connection_from_row(
    row: &sqlx::postgres::PgRow,
) -> Result<GitCredentialConnection, GitOperationError> {
    Ok(GitCredentialConnection {
        id: parse_uuid(row.get::<&str, _>("id"))?,
        user_id: UserId::from_uuid(parse_uuid(row.get::<&str, _>("user_id"))?)
            .map_err(|_| GitOperationError::Unavailable)?,
        provider_id: parse_uuid(row.get::<&str, _>("provider_id"))?,
        credential_version: parse_version(row.get("credential_version"))?,
        connection_version: parse_version(row.get("connection_version"))?,
        created_at: row.get("created_at"),
        updated_at: row.get("updated_at"),
    })
}

pub(crate) fn remote_from_row(
    row: &sqlx::postgres::PgRow,
) -> Result<GitRemoteBinding, GitOperationError> {
    let project_id = ProjectId::from_uuid(parse_uuid(row.get::<&str, _>("project_id"))?)
        .map_err(|_| GitOperationError::Unavailable)?;
    let value = GitRemoteBinding {
        project_id,
        provider_id: parse_uuid(row.get::<&str, _>("provider_id"))?,
        repository_url: row.get("repository_url"),
        branch: row.get("branch"),
        remote_head_sha: row.get("remote_head_sha"),
        remote_version: parse_version(row.get("remote_version"))?,
        created_at: row.get("created_at"),
        updated_at: row.get("updated_at"),
    };
    validate_branch(&value.branch)?;
    validate_expected_sha(&value.remote_head_sha)?;
    Ok(value)
}

pub(crate) fn decode_provider(
    row: &sqlx::postgres::PgRow,
) -> Result<GitProviderMetadata, GitOperationError> {
    crate::git_provider::metadata_from_database_row(row).map_err(map_provider_error)
}

pub(crate) fn credential_identity(id: Uuid) -> Result<CredentialIdentity, GitOperationError> {
    CredentialIdentity::new(
        INSTANCE_ID,
        INTEGRATION_TYPE,
        id.to_string(),
        CREDENTIAL_KIND,
    )
    .map_err(map_integration_error)
}

pub(crate) fn validate_import_outcome(
    outcome: &GitOperationOutcome,
) -> Result<(), GitOperationError> {
    if outcome.previous_head_sha.is_some()
        || !valid_sha(&outcome.head_sha)
        || outcome.changed_objects > MAX_CHANGED_OBJECTS
        || outcome.transferred_bytes > MAX_TRANSFER_BYTES
    {
        Err(GitOperationError::InvalidInput)
    } else {
        Ok(())
    }
}

pub(crate) fn validate_update_outcome(
    outcome: &GitOperationOutcome,
    expected_head: &str,
) -> Result<(), GitOperationError> {
    if outcome.previous_head_sha.as_deref() != Some(expected_head) {
        return Err(GitOperationError::NonFastForward);
    }
    if !valid_sha(&outcome.head_sha)
        || outcome.changed_objects > MAX_CHANGED_OBJECTS
        || outcome.transferred_bytes > MAX_TRANSFER_BYTES
    {
        return Err(GitOperationError::InvalidInput);
    }
    Ok(())
}

pub(crate) fn validate_expected_sha(value: &str) -> Result<(), GitOperationError> {
    if valid_sha(value) {
        Ok(())
    } else {
        Err(GitOperationError::InvalidInput)
    }
}

pub(crate) fn valid_sha(value: &str) -> bool {
    matches!(value.len(), 40 | 64)
        && value
            .bytes()
            .all(|byte| byte.is_ascii_hexdigit() && !byte.is_ascii_uppercase())
}

pub(crate) fn validate_branch(value: &str) -> Result<(), GitOperationError> {
    let invalid = value.is_empty()
        || value.len() > MAX_BRANCH_BYTES
        || value.starts_with('/')
        || value.ends_with('/')
        || value.starts_with('.')
        || value.ends_with('.')
        || value.ends_with(".lock")
        || value.contains("..")
        || value.contains("@{")
        || value.bytes().any(|byte| {
            byte.is_ascii_control()
                || byte.is_ascii_whitespace()
                || matches!(byte, b'~' | b'^' | b':' | b'?' | b'*' | b'[' | b'\\')
        });
    if invalid {
        Err(GitOperationError::InvalidInput)
    } else {
        Ok(())
    }
}

pub(crate) fn validate_commit_message(value: &str) -> Result<(), GitOperationError> {
    if value.is_empty() || value.len() > MAX_COMMIT_MESSAGE_BYTES || value.contains('\0') {
        Err(GitOperationError::InvalidInput)
    } else {
        Ok(())
    }
}

pub(crate) fn validate_correlation(value: &str) -> Result<(), GitOperationError> {
    if (1..=128).contains(&value.len())
        && value
            .bytes()
            .all(|byte| byte.is_ascii_alphanumeric() || matches!(byte, b'.' | b'_' | b':' | b'-'))
    {
        Ok(())
    } else {
        Err(GitOperationError::InvalidInput)
    }
}

pub(crate) fn parse_uuid(value: &str) -> Result<Uuid, GitOperationError> {
    Uuid::from_str(value).map_err(|_| GitOperationError::Unavailable)
}

pub(crate) fn parse_version(value: i64) -> Result<u64, GitOperationError> {
    u64::try_from(value)
        .ok()
        .filter(|value| *value > 0)
        .ok_or(GitOperationError::Unavailable)
}

pub(crate) async fn append_audit(
    tx: &mut Transaction<'_, Postgres>,
    actor: UserId,
    action: &str,
    scope_type: &str,
    scope_id: &str,
    correlation_id: &str,
) -> Result<(), GitOperationError> {
    sqlx::query(
        "INSERT INTO audit_events(id,actor_type,actor_id,actor_user_id,action_code,target_type,
         target_id,scope_type,scope_id,result,correlation_id,changed_fields,metadata)
         VALUES($1::uuid,'user',$2,$2::uuid,$3,'git_operation',$4,$5,$4,'succeeded',$6,$7,'{}'::jsonb)",
    ).bind(Uuid::now_v7().to_string()).bind(actor.to_string()).bind(action).bind(scope_id)
        .bind(scope_type).bind(correlation_id).bind(vec!["git_state".to_owned()])
        .execute(&mut **tx).await.map_err(|_| GitOperationError::Unavailable)?;
    Ok(())
}

pub(crate) fn map_database_error(error: sqlx::Error) -> GitOperationError {
    match error
        .as_database_error()
        .and_then(|value| value.code())
        .as_deref()
    {
        Some("23505") => GitOperationError::AlreadyConnected,
        Some("23503") => GitOperationError::NotFound,
        Some("23514" | "P0001") => GitOperationError::Conflict,
        _ => GitOperationError::Unavailable,
    }
}
