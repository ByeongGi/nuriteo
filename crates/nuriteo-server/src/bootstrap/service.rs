use std::fmt;

use serde_json::json;
use sqlx::Acquire;
use time::OffsetDateTime;

use crate::audit::{
    ActorType, AuditActor, AuditEvent, AuditEventFields, AuditEventId, AuditMetadata, AuditResult,
    AuditScope, AuditTarget, AuditWriter, ScopeType,
};
use crate::config::FileReader;
use crate::database::{DatabasePool, SchemaReadiness, check_schema_readiness};
use crate::identity::{
    PasswordService, Timestamp, User, UserFields, UserId, UserStatus, acquire_mfa_population_lock,
};
use crate::workspace::PersonalStorageScopeRepository;

use super::input::{BootstrapAdminInput, BootstrapInputError};

const BOOTSTRAP_LOCK_KEY: i64 = 22_037_266_433_348_943;

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum BootstrapOutcome {
    Created,
    AlreadyInitialized,
}

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum BootstrapErrorCategory {
    Input,
    SchemaNotReady,
    DatabaseOperation,
    PasswordHashing,
    Audit,
}

impl BootstrapErrorCategory {
    const fn as_str(self) -> &'static str {
        match self {
            Self::Input => "input",
            Self::SchemaNotReady => "schema-not-ready",
            Self::DatabaseOperation => "database-operation",
            Self::PasswordHashing => "password-hashing",
            Self::Audit => "audit",
        }
    }
}

#[derive(Clone, Copy, PartialEq, Eq)]
pub struct BootstrapError {
    category: BootstrapErrorCategory,
}

impl BootstrapError {
    #[must_use]
    pub const fn category(self) -> BootstrapErrorCategory {
        self.category
    }

    const fn new(category: BootstrapErrorCategory) -> Self {
        Self { category }
    }
}

impl From<BootstrapInputError> for BootstrapError {
    fn from(_: BootstrapInputError) -> Self {
        Self::new(BootstrapErrorCategory::Input)
    }
}

impl fmt::Debug for BootstrapError {
    fn fmt(&self, formatter: &mut fmt::Formatter<'_>) -> fmt::Result {
        formatter
            .debug_struct("BootstrapError")
            .field("category", &self.category)
            .finish()
    }
}

impl fmt::Display for BootstrapError {
    fn fmt(&self, formatter: &mut fmt::Formatter<'_>) -> fmt::Result {
        write!(
            formatter,
            "bootstrap administrator failed ({})",
            self.category.as_str()
        )
    }
}

impl std::error::Error for BootstrapError {}

pub async fn bootstrap_administrator(
    pool: &DatabasePool,
    input: BootstrapAdminInput,
    files: &impl FileReader,
) -> Result<BootstrapOutcome, BootstrapError> {
    match check_schema_readiness(pool)
        .await
        .map_err(|_| BootstrapError::new(BootstrapErrorCategory::DatabaseOperation))?
    {
        SchemaReadiness::Ready { .. } => {}
        _ => return Err(BootstrapError::new(BootstrapErrorCategory::SchemaNotReady)),
    }

    let mut connection = pool
        .acquire()
        .await
        .map_err(|_| BootstrapError::new(BootstrapErrorCategory::DatabaseOperation))?;
    let mut transaction = connection
        .begin()
        .await
        .map_err(|_| BootstrapError::new(BootstrapErrorCategory::DatabaseOperation))?;

    sqlx::query("SELECT pg_advisory_xact_lock($1)")
        .bind(BOOTSTRAP_LOCK_KEY)
        .execute(&mut *transaction)
        .await
        .map_err(|_| BootstrapError::new(BootstrapErrorCategory::DatabaseOperation))?;
    acquire_mfa_population_lock(&mut transaction)
        .await
        .map_err(|_| BootstrapError::new(BootstrapErrorCategory::DatabaseOperation))?;

    let initialized: bool =
        sqlx::query_scalar("SELECT EXISTS (SELECT 1 FROM users WHERE is_instance_admin)")
            .fetch_one(&mut *transaction)
            .await
            .map_err(|_| BootstrapError::new(BootstrapErrorCategory::DatabaseOperation))?;
    if initialized {
        transaction
            .rollback()
            .await
            .map_err(|_| BootstrapError::new(BootstrapErrorCategory::DatabaseOperation))?;
        return Ok(BootstrapOutcome::AlreadyInitialized);
    }

    let password = input.load_password(files)?;
    let verifier =
        tokio::task::spawn_blocking(move || PasswordService::default().hash(password.as_bytes()))
            .await
            .map_err(|_| BootstrapError::new(BootstrapErrorCategory::PasswordHashing))?
            .map_err(|_| BootstrapError::new(BootstrapErrorCategory::PasswordHashing))?;

    let now = Timestamp::from_datetime(OffsetDateTime::now_utc())
        .map_err(|_| BootstrapError::new(BootstrapErrorCategory::DatabaseOperation))?;
    let user = User::new(UserFields {
        id: UserId::new(),
        email: input.email,
        normalized_email: input.normalized_email,
        display_name: input.display_name,
        status: UserStatus::Active,
        is_instance_admin: true,
        created_at: now,
        updated_at: now,
        disabled_at: None,
    })
    .map_err(|_| BootstrapError::new(BootstrapErrorCategory::Input))?;
    let user = user.into_fields();

    sqlx::query(
        "INSERT INTO users \
         (id, email, normalized_email, display_name, status, is_instance_admin, created_at, updated_at) \
         VALUES ($1::uuid, $2, $3, $4, 'active', TRUE, $5::timestamptz, $5::timestamptz)",
    )
    .bind(user.id.to_string())
    .bind(&user.email)
    .bind(&user.normalized_email)
    .bind(&user.display_name)
    .bind(user.created_at.to_string())
    .execute(&mut *transaction)
    .await
    .map_err(|_| BootstrapError::new(BootstrapErrorCategory::DatabaseOperation))?;

    PersonalStorageScopeRepository::provision(&mut transaction, user.id, user.created_at)
        .await
        .map_err(|_| BootstrapError::new(BootstrapErrorCategory::DatabaseOperation))?;

    sqlx::query(
        "INSERT INTO local_password_credentials \
         (user_id, password_verifier, created_at, updated_at) \
         VALUES ($1::uuid, $2, $3::timestamptz, $3::timestamptz)",
    )
    .bind(user.id.to_string())
    .bind(verifier.expose())
    .bind(user.created_at.to_string())
    .execute(&mut *transaction)
    .await
    .map_err(|_| BootstrapError::new(BootstrapErrorCategory::DatabaseOperation))?;

    let event_id = AuditEventId::new();
    let event = AuditEvent::new(AuditEventFields {
        id: event_id,
        occurred_at: now,
        actor: AuditActor {
            kind: ActorType::Bootstrap,
            id: "bootstrap-admin".into(),
            user_id: None,
            display_name: None,
        },
        action_code: "instance_admin.bootstrap_created".into(),
        target: AuditTarget {
            kind: "user".into(),
            id: user.id.to_string(),
        },
        scope: AuditScope {
            kind: ScopeType::Instance,
            id: "primary".into(),
        },
        result: AuditResult::Succeeded,
        reason_code: None,
        correlation_id: format!("bootstrap:{event_id}"),
        source_ip: None,
        schema_version: 1,
        changed_fields: vec![
            "is_instance_admin".into(),
            "local_credential".into(),
            "personal_storage_scope".into(),
        ],
        metadata: AuditMetadata::new(json!({"method": "bootstrap-admin"}))
            .map_err(|_| BootstrapError::new(BootstrapErrorCategory::Audit))?,
    })
    .map_err(|_| BootstrapError::new(BootstrapErrorCategory::Audit))?;
    AuditWriter::append(&mut transaction, &event)
        .await
        .map_err(|_| BootstrapError::new(BootstrapErrorCategory::Audit))?;

    transaction
        .commit()
        .await
        .map_err(|_| BootstrapError::new(BootstrapErrorCategory::DatabaseOperation))?;
    Ok(BootstrapOutcome::Created)
}
