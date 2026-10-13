use std::io::Cursor;
use std::str::FromStr;
use std::sync::{Arc, OnceLock};
use std::time::Duration;

use sha2::{Digest, Sha256};
use sqlx::{Acquire, PgConnection};
use tempfile::NamedTempFile;
use tokio::io::{AsyncReadExt, AsyncWriteExt};
use tokio::sync::{OwnedSemaphorePermit, Semaphore};
use uuid::Uuid;

use crate::database::DatabasePool;
use crate::git_operations::embedded::GitTreeSnapshot;
use crate::object_storage::{
    MAX_STREAMING_SINGLE_PUT_BYTES, MultipartLimits, MultipartPartRequest, ObjectKey,
    ObjectStoreErrorKind, S3ObjectStore, Sha256Checksum, StreamingPutRequest, UploadBody,
    UploadDeadlines, upload_abort_pair,
};
use crate::project::ProjectId;
use crate::workspace::StorageScopeId;

use super::{decode_git_bundle, encode_git_snapshot};

const CONTENT_TYPE: &str = "application/vnd.nuriteo.project-bundle.v1+tar";
const MAX_BUNDLE_BYTES: u64 = 272 * 1024 * 1024;
const MATERIALIZER_PART_BYTES: usize = 32 * 1024 * 1024;
static MATERIALIZER_MEMORY_GATE: OnceLock<Arc<Semaphore>> = OnceLock::new();

#[derive(Clone)]
pub(crate) struct CanonicalBundleMaterializer {
    pool: DatabasePool,
    store: S3ObjectStore,
    memory_gate: Arc<Semaphore>,
}

impl std::fmt::Debug for CanonicalBundleMaterializer {
    fn fmt(&self, formatter: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        formatter
            .debug_struct("CanonicalBundleMaterializer")
            .field("store", &self.store)
            .finish_non_exhaustive()
    }
}

pub(crate) struct PreparedCanonicalBundle {
    _memory_permit: OwnedSemaphorePermit,
    project_id: ProjectId,
    storage_scope_id: StorageScopeId,
    bytes: Vec<u8>,
    physical_bytes: u64,
    sha256: [u8; 32],
    object_key: String,
    logical_bytes: u64,
    file_count: u32,
}

pub(crate) struct PersistedCanonicalBundle {
    prepared: PreparedCanonicalBundle,
    ledger_id: Uuid,
}

#[derive(Debug, Clone)]
pub(crate) struct CanonicalBundleRecord {
    pub(crate) id: String,
    pub(crate) physical_bytes: i64,
}

impl CanonicalBundleMaterializer {
    pub(crate) fn new(pool: DatabasePool, store: S3ObjectStore) -> Self {
        Self {
            pool,
            store,
            memory_gate: MATERIALIZER_MEMORY_GATE
                .get_or_init(|| Arc::new(Semaphore::new(1)))
                .clone(),
        }
    }

    pub(crate) async fn prepare(
        &self,
        project_id: ProjectId,
        storage_scope_id: StorageScopeId,
        tree: &GitTreeSnapshot,
    ) -> Result<PreparedCanonicalBundle, MaterializationError> {
        let memory_permit = self
            .memory_gate
            .clone()
            .acquire_owned()
            .await
            .map_err(|_| MaterializationError::Storage)?;
        let encoded = encode_git_snapshot(project_id, storage_scope_id, tree)
            .map_err(|_| MaterializationError::InvalidBundle)?;
        decode_git_bundle(project_id, storage_scope_id, encoded.bytes())
            .map_err(|_| MaterializationError::InvalidBundle)?;
        if encoded.bytes().len() as u64 > MAX_BUNDLE_BYTES {
            return Err(MaterializationError::InvalidBundle);
        }
        let (bytes, digest, logical_bytes, file_count) = encoded.into_parts();
        Ok(PreparedCanonicalBundle {
            _memory_permit: memory_permit,
            project_id,
            storage_scope_id,
            physical_bytes: bytes.len() as u64,
            bytes,
            sha256: digest,
            object_key: format!("bundles/sha256/{}", hex(&digest)),
            logical_bytes,
            file_count,
        })
    }

    pub(crate) async fn persist(
        &self,
        mut prepared: PreparedCanonicalBundle,
    ) -> Result<PersistedCanonicalBundle, MaterializationError> {
        let (ledger_id, state) = self.begin_ledger(&prepared).await?;
        let object_is_present = if matches!(state.as_str(), "uploaded" | "finalized") {
            match self
                .store
                .head(
                    &ObjectKey::parse(prepared.object_key.clone())
                        .map_err(|_| MaterializationError::InvalidBundle)?,
                )
                .await
            {
                Ok(metadata) => metadata.content_length == prepared.physical_bytes,
                Err(error) if error.kind() == ObjectStoreErrorKind::NotFound => false,
                Err(_) => return Err(MaterializationError::Storage),
            }
        } else {
            false
        };
        if !object_is_present {
            self.prepare_object_resurrection(&prepared.object_key)
                .await?;
            let key = ObjectKey::parse(prepared.object_key.clone())
                .map_err(|_| MaterializationError::InvalidBundle)?;
            if prepared.physical_bytes <= MAX_STREAMING_SINGLE_PUT_BYTES {
                let bytes = std::mem::take(&mut prepared.bytes);
                let (_, abort) = upload_abort_pair();
                self.store
                    .put_stream_once(StreamingPutRequest {
                        key,
                        body: UploadBody::from_reader(
                            Cursor::new(bytes),
                            prepared.physical_bytes,
                            Sha256Checksum::from_bytes(prepared.sha256),
                        ),
                        content_type: Some(CONTENT_TYPE.to_owned()),
                        deadlines: UploadDeadlines::for_put(
                            Duration::from_secs(10),
                            Duration::from_secs(30),
                        )
                        .map_err(|_| MaterializationError::Storage)?,
                        abort,
                    })
                    .await
                    .map_err(|_| MaterializationError::Storage)?;
            } else {
                self.persist_multipart(ledger_id, key, &prepared.bytes)
                    .await?;
                prepared.bytes.clear();
            }
            self.mark_ledger(ledger_id, "uploaded").await?;
        }
        Ok(PersistedCanonicalBundle {
            prepared,
            ledger_id,
        })
    }

    pub(crate) async fn ensure_verified_bundle(
        &self,
        connection: &mut PgConnection,
        persisted: &PersistedCanonicalBundle,
    ) -> Result<CanonicalBundleRecord, MaterializationError> {
        let prepared = &persisted.prepared;
        sqlx::query("SELECT lock_bundle_object_lifecycle($1)")
            .bind(&prepared.object_key)
            .execute(&mut *connection)
            .await
            .map_err(|_| MaterializationError::Database)?;
        let fenced: bool = sqlx::query_scalar(
            "SELECT EXISTS(SELECT 1 FROM gc_candidates WHERE object_key=$1 \
             AND status IN ('running','completed'))",
        )
        .bind(&prepared.object_key)
        .fetch_one(&mut *connection)
        .await
        .map_err(|_| MaterializationError::Database)?;
        if fenced {
            return Err(MaterializationError::GcFenced);
        }
        sqlx::query(
            "INSERT INTO bundles \
             (id,sha256,object_key,physical_bytes,logical_bytes,file_count,format,\
              verification_state,verified_at,created_at) \
             VALUES($1::uuid,$2,$3,$4,$5,$6,'project-bundle-v1','verified',\
                    transaction_timestamp(),transaction_timestamp()) \
             ON CONFLICT (sha256) DO NOTHING",
        )
        .bind(Uuid::now_v7().to_string())
        .bind(prepared.sha256.as_slice())
        .bind(&prepared.object_key)
        .bind(to_i64(prepared.physical_bytes)?)
        .bind(to_i64(prepared.logical_bytes)?)
        .bind(i32::try_from(prepared.file_count).map_err(|_| MaterializationError::InvalidBundle)?)
        .execute(&mut *connection)
        .await
        .map_err(|_| MaterializationError::Database)?;
        let record: (String, String, i64, i64, i32) = sqlx::query_as(
            "SELECT id::text,object_key,physical_bytes,logical_bytes,file_count \
             FROM bundles WHERE sha256=$1",
        )
        .bind(prepared.sha256.as_slice())
        .fetch_one(&mut *connection)
        .await
        .map_err(|_| MaterializationError::Database)?;
        if record.2 != to_i64(prepared.physical_bytes)?
            || record.3 != to_i64(prepared.logical_bytes)?
            || record.4
                != i32::try_from(prepared.file_count)
                    .map_err(|_| MaterializationError::InvalidBundle)?
        {
            return Err(MaterializationError::InvalidBundle);
        }
        Ok(CanonicalBundleRecord {
            id: record.0,
            physical_bytes: record.2,
        })
    }

    pub(crate) async fn finalize_ledger(
        &self,
        connection: &mut PgConnection,
        persisted: &PersistedCanonicalBundle,
    ) -> Result<(), MaterializationError> {
        let affected = sqlx::query(
            "UPDATE canonical_bundle_materializations SET state='finalized',\
             updated_at=transaction_timestamp() WHERE id=$1::uuid \
             AND state IN ('uploaded','finalized')",
        )
        .bind(persisted.ledger_id.to_string())
        .execute(connection)
        .await
        .map_err(|_| MaterializationError::Database)?
        .rows_affected();
        if affected != 1 {
            return Err(MaterializationError::Database);
        }
        Ok(())
    }

    pub(crate) async fn load_verified_snapshot(
        &self,
        project_id: ProjectId,
        storage_scope_id: StorageScopeId,
        object_key: &str,
        expected_size: u64,
        expected_sha256: &[u8],
    ) -> Result<GitTreeSnapshot, MaterializationError> {
        let _memory_permit = self
            .memory_gate
            .clone()
            .acquire_owned()
            .await
            .map_err(|_| MaterializationError::Storage)?;
        if expected_size == 0 || expected_size > MAX_BUNDLE_BYTES || expected_sha256.len() != 32 {
            return Err(MaterializationError::InvalidBundle);
        }
        let mut stream = self
            .store
            .get_stream(
                &ObjectKey::parse(object_key.to_owned())
                    .map_err(|_| MaterializationError::InvalidBundle)?,
                expected_size,
            )
            .await
            .map_err(|_| MaterializationError::Storage)?;
        if stream.metadata.content_length != expected_size {
            return Err(MaterializationError::InvalidBundle);
        }
        let temporary = NamedTempFile::new().map_err(|_| MaterializationError::Storage)?;
        let std_file = temporary
            .reopen()
            .map_err(|_| MaterializationError::Storage)?;
        let mut output = tokio::fs::File::from_std(std_file);
        let mut hasher = Sha256::new();
        let mut received = 0_u64;
        let mut buffer = vec![0_u8; 64 * 1024];
        loop {
            let count = stream
                .reader
                .read(&mut buffer)
                .await
                .map_err(|_| MaterializationError::Storage)?;
            if count == 0 {
                break;
            }
            received = received
                .checked_add(count as u64)
                .filter(|value| *value <= expected_size)
                .ok_or(MaterializationError::InvalidBundle)?;
            hasher.update(&buffer[..count]);
            output
                .write_all(&buffer[..count])
                .await
                .map_err(|_| MaterializationError::Storage)?;
        }
        output
            .flush()
            .await
            .map_err(|_| MaterializationError::Storage)?;
        drop(output);
        if received != expected_size || hasher.finalize().as_slice() != expected_sha256 {
            return Err(MaterializationError::InvalidBundle);
        }
        let path = temporary.path().to_owned();
        tokio::task::spawn_blocking(move || {
            let bytes = std::fs::read(path).map_err(|_| MaterializationError::Storage)?;
            decode_git_bundle(project_id, storage_scope_id, &bytes)
                .map_err(|_| MaterializationError::InvalidBundle)
        })
        .await
        .map_err(|_| MaterializationError::Storage)?
    }

    async fn begin_ledger(
        &self,
        prepared: &PreparedCanonicalBundle,
    ) -> Result<(Uuid, String), MaterializationError> {
        let mut connection = self
            .pool
            .acquire()
            .await
            .map_err(|_| MaterializationError::Database)?;
        let row: (String, String) = sqlx::query_as(
            "INSERT INTO canonical_bundle_materializations \
             (id,project_id,storage_scope_id,sha256,object_key,physical_bytes,\
              logical_bytes,file_count,state) \
             VALUES($1::uuid,$2::uuid,$3::uuid,$4,$5,$6,$7,$8,'pending') \
             ON CONFLICT (project_id,storage_scope_id,sha256) DO UPDATE SET \
               updated_at=transaction_timestamp() RETURNING id::text,state",
        )
        .bind(Uuid::now_v7().to_string())
        .bind(prepared.project_id.to_string())
        .bind(prepared.storage_scope_id.to_string())
        .bind(prepared.sha256.as_slice())
        .bind(&prepared.object_key)
        .bind(to_i64(prepared.physical_bytes)?)
        .bind(to_i64(prepared.logical_bytes)?)
        .bind(i32::try_from(prepared.file_count).map_err(|_| MaterializationError::InvalidBundle)?)
        .fetch_one(&mut *connection)
        .await
        .map_err(|_| MaterializationError::Database)?;
        Ok((
            Uuid::from_str(&row.0).map_err(|_| MaterializationError::Database)?,
            row.1,
        ))
    }

    /// Serializes a retry with object GC. A completed/queued candidate may be
    /// removed because this operation is about to restore the exact immutable
    /// digest. A running delete cannot be cancelled safely, so callers fail
    /// closed and retry after reconciliation.
    async fn prepare_object_resurrection(
        &self,
        object_key: &str,
    ) -> Result<(), MaterializationError> {
        let mut connection = self
            .pool
            .acquire()
            .await
            .map_err(|_| MaterializationError::Database)?;
        let mut transaction = connection
            .begin()
            .await
            .map_err(|_| MaterializationError::Database)?;
        sqlx::query("SELECT lock_bundle_object_lifecycle($1)")
            .bind(object_key)
            .execute(&mut *transaction)
            .await
            .map_err(|_| MaterializationError::Database)?;
        let running: bool = sqlx::query_scalar(
            "SELECT EXISTS(SELECT 1 FROM gc_candidates \
             WHERE object_key=$1 AND status='running')",
        )
        .bind(object_key)
        .fetch_one(&mut *transaction)
        .await
        .map_err(|_| MaterializationError::Database)?;
        if running {
            return Err(MaterializationError::GcFenced);
        }
        sqlx::query("DELETE FROM gc_candidates WHERE object_key=$1")
            .bind(object_key)
            .execute(&mut *transaction)
            .await
            .map_err(|_| MaterializationError::Database)?;
        transaction
            .commit()
            .await
            .map_err(|_| MaterializationError::Database)
    }

    async fn persist_multipart(
        &self,
        ledger_id: Uuid,
        key: ObjectKey,
        bytes: &[u8],
    ) -> Result<(), MaterializationError> {
        let limits = MultipartLimits::new(MATERIALIZER_PART_BYTES)
            .map_err(|_| MaterializationError::InvalidBundle)?;
        limits
            .validate_payload(bytes.len() as u64)
            .map_err(|_| MaterializationError::InvalidBundle)?;
        let upload = self
            .store
            .create_multipart(key)
            .await
            .map_err(|_| MaterializationError::Storage)?;
        self.record_multipart_upload(ledger_id, upload.upload_id())
            .await?;
        let mut parts = Vec::new();
        for (index, chunk) in bytes.chunks(MATERIALIZER_PART_BYTES).enumerate() {
            let body = bytes::Bytes::copy_from_slice(chunk);
            let request = MultipartPartRequest {
                upload: upload.clone(),
                part_number: u16::try_from(index + 1)
                    .map_err(|_| MaterializationError::InvalidBundle)?,
                final_part: index + 1 == bytes.len().div_ceil(MATERIALIZER_PART_BYTES),
                checksum: Sha256Checksum::calculate(&body),
                body,
            };
            match self.store.upload_part(request, &limits).await {
                Ok(part) => parts.push(part),
                Err(_) => {
                    let _ = self.store.abort_multipart(&upload).await;
                    return Err(MaterializationError::Storage);
                }
            }
        }
        if self.store.complete_multipart(&upload, parts).await.is_err() {
            let _ = self.store.abort_multipart(&upload).await;
            return Err(MaterializationError::Storage);
        }
        Ok(())
    }

    async fn record_multipart_upload(
        &self,
        id: Uuid,
        upload_id: &str,
    ) -> Result<(), MaterializationError> {
        let mut connection = self
            .pool
            .acquire()
            .await
            .map_err(|_| MaterializationError::Database)?;
        let affected = sqlx::query(
            "UPDATE canonical_bundle_materializations SET multipart_upload_id=$2,\
             updated_at=transaction_timestamp() WHERE id=$1::uuid AND state='pending'",
        )
        .bind(id.to_string())
        .bind(upload_id)
        .execute(&mut *connection)
        .await
        .map_err(|_| MaterializationError::Database)?
        .rows_affected();
        if affected != 1 {
            return Err(MaterializationError::Database);
        }
        Ok(())
    }

    async fn mark_ledger(&self, id: Uuid, state: &str) -> Result<(), MaterializationError> {
        let mut connection = self
            .pool
            .acquire()
            .await
            .map_err(|_| MaterializationError::Database)?;
        let affected = sqlx::query(
            "UPDATE canonical_bundle_materializations SET state=$2,\
             multipart_upload_id=CASE WHEN $2='uploaded' THEN NULL ELSE multipart_upload_id END,\
             updated_at=transaction_timestamp() WHERE id=$1::uuid",
        )
        .bind(id.to_string())
        .bind(state)
        .execute(&mut *connection)
        .await
        .map_err(|_| MaterializationError::Database)?
        .rows_affected();
        if affected != 1 {
            return Err(MaterializationError::Database);
        }
        Ok(())
    }
}

impl PersistedCanonicalBundle {
    pub(crate) const fn ledger_id(&self) -> Uuid {
        self.ledger_id
    }
}

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub(crate) enum MaterializationError {
    InvalidBundle,
    Storage,
    Database,
    GcFenced,
}

fn to_i64(value: u64) -> Result<i64, MaterializationError> {
    i64::try_from(value).map_err(|_| MaterializationError::InvalidBundle)
}

fn hex(bytes: &[u8]) -> String {
    const DIGITS: &[u8; 16] = b"0123456789abcdef";
    let mut output = String::with_capacity(bytes.len() * 2);
    for byte in bytes {
        output.push(char::from(DIGITS[usize::from(byte >> 4)]));
        output.push(char::from(DIGITS[usize::from(byte & 0x0f)]));
    }
    output
}
