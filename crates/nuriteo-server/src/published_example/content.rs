use std::{
    fmt,
    io::{Read, Seek, SeekFrom, Write},
    pin::Pin,
    str::FromStr,
    sync::Arc,
    task::{Context, Poll},
    time::Duration,
};

use base64::{Engine as _, engine::general_purpose::URL_SAFE_NO_PAD};
use serde::{Deserialize, Serialize};
use sha2::{Digest, Sha256};
use tokio::{
    io::{AsyncRead, AsyncReadExt, AsyncWriteExt, ReadBuf},
    sync::{OwnedSemaphorePermit, Semaphore},
    time,
};
use unicode_normalization::UnicodeNormalization;

use crate::{
    database::DatabasePool,
    object_storage::{ObjectKey, ObjectStoreErrorKind, S3ObjectStore},
    project::ProjectId,
    workspace::StorageScopeId,
};

use super::PublishedExamplePublicId;

const MAX_LOGICAL_BYTES: u64 = 256 * 1024 * 1024;
const MAX_ARCHIVE_OVERHEAD_BYTES: u64 = 32 * 1024 * 1024;
const MAX_PHYSICAL_BUNDLE_BYTES: u64 = MAX_LOGICAL_BYTES + MAX_ARCHIVE_OVERHEAD_BYTES;
const MAX_FILE_COUNT: u32 = 2_500;
const MAX_FILE_BYTES: u64 = 16 * 1024 * 1024;
const MAX_MANIFEST_BYTES: u64 = 4 * 1024 * 1024;
const TAR_BLOCK_BYTES: usize = 512;
const PUBLIC_FORMAT: &str = "nuriteo-published-bundle-v1";
const MAX_CONCURRENT_SANITIZATIONS: usize = 4;
const SANITIZE_TIMEOUT: Duration = Duration::from_secs(120);

#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub(crate) enum PublishedContentError {
    InvalidInput,
    NotFound,
    ObjectUnavailable,
    ObjectMismatch,
    TooLarge,
    OperationTimeout,
    PersistenceUnavailable,
    InvariantViolation,
}

impl fmt::Display for PublishedContentError {
    fn fmt(&self, formatter: &mut fmt::Formatter<'_>) -> fmt::Result {
        formatter.write_str(match self {
            Self::InvalidInput => "published content request is invalid",
            Self::NotFound => "published content was not found",
            Self::ObjectUnavailable => "published content object is unavailable",
            Self::ObjectMismatch => "published content object does not match verified metadata",
            Self::TooLarge => "published content exceeds the public adapter limit",
            Self::OperationTimeout => "published content operation timed out",
            Self::PersistenceUnavailable => "published content persistence is unavailable",
            Self::InvariantViolation => "published content persistence state is invalid",
        })
    }
}

impl std::error::Error for PublishedContentError {}

#[derive(Clone, Debug, PartialEq, Eq)]
pub(crate) struct PublishedContentDescriptor {
    version_number: i64,
    checksum: String,
    physical_bytes: u64,
    logical_bytes: u64,
    file_count: u32,
}

impl PublishedContentDescriptor {
    pub(crate) fn etag(&self) -> String {
        format!(
            "\"published-content-v{}-{}\"",
            self.version_number, self.checksum
        )
    }

    pub(crate) const fn physical_bytes(&self) -> u64 {
        self.physical_bytes
    }

    #[allow(dead_code, reason = "retained as a verified public bundle boundary")]
    pub(crate) const fn logical_bytes(&self) -> u64 {
        self.logical_bytes
    }

    #[allow(dead_code, reason = "retained as a verified public bundle boundary")]
    pub(crate) const fn file_count(&self) -> u32 {
        self.file_count
    }
}

pub(crate) struct PublishedContentDownload {
    descriptor: PublishedContentDescriptor,
    reader: Pin<Box<dyn AsyncRead + Send>>,
}

impl PublishedContentDownload {
    pub(crate) fn into_parts(self) -> (PublishedContentDescriptor, Pin<Box<dyn AsyncRead + Send>>) {
        (self.descriptor, self.reader)
    }
}

struct PermittedFileReader {
    file: tokio::fs::File,
    _permit: OwnedSemaphorePermit,
}

impl AsyncRead for PermittedFileReader {
    fn poll_read(
        mut self: Pin<&mut Self>,
        context: &mut Context<'_>,
        buffer: &mut ReadBuf<'_>,
    ) -> Poll<std::io::Result<()>> {
        Pin::new(&mut self.file).poll_read(context, buffer)
    }
}

impl fmt::Debug for PublishedContentDownload {
    fn fmt(&self, formatter: &mut fmt::Formatter<'_>) -> fmt::Result {
        formatter
            .debug_struct("PublishedContentDownload")
            .field("descriptor", &self.descriptor)
            .field("reader", &"[BOUNDED STREAM]")
            .finish()
    }
}

#[derive(Clone)]
pub(crate) struct PublishedContentService {
    pool: DatabasePool,
    store: S3ObjectStore,
    operation_timeout: Duration,
    sanitize_slots: Arc<Semaphore>,
}

impl PublishedContentService {
    pub(crate) fn new(pool: DatabasePool, store: S3ObjectStore) -> Self {
        Self {
            pool,
            store,
            operation_timeout: Duration::from_secs(5),
            sanitize_slots: Arc::new(Semaphore::new(MAX_CONCURRENT_SANITIZATIONS)),
        }
    }

    pub(crate) async fn download(
        &self,
        public_id: &PublishedExamplePublicId,
        version_number: Option<i64>,
    ) -> Result<PublishedContentDownload, PublishedContentError> {
        if version_number.is_some_and(|value| value < 1) {
            return Err(PublishedContentError::InvalidInput);
        }
        let permit = time::timeout(
            self.operation_timeout,
            Arc::clone(&self.sanitize_slots).acquire_owned(),
        )
        .await
        .map_err(|_| PublishedContentError::OperationTimeout)?
        .map_err(|_| PublishedContentError::ObjectUnavailable)?;
        let loaded = time::timeout(
            self.operation_timeout,
            load_descriptor(&self.pool, public_id, version_number),
        )
        .await
        .map_err(|_| PublishedContentError::OperationTimeout)??;
        let key = ObjectKey::parse(loaded.object_key.clone())
            .map_err(|_| PublishedContentError::InvariantViolation)?;
        let stream = time::timeout(
            self.operation_timeout,
            self.store
                .get_stream(&key, loaded.descriptor.physical_bytes),
        )
        .await
        .map_err(|_| PublishedContentError::OperationTimeout)?
        .map_err(map_store_error)?;
        if stream.metadata.content_length != loaded.descriptor.physical_bytes {
            return Err(PublishedContentError::ObjectMismatch);
        }
        let source = spool_verified_source(stream.reader, &loaded.descriptor).await?;
        let project_id = loaded.project_id.to_string();
        let storage_scope_id = loaded.storage_scope_id.to_string();
        let expected_logical_bytes = loaded.descriptor.logical_bytes;
        let expected_file_count = loaded.descriptor.file_count;
        // The source size and file count are already bounded. Await the blocking
        // task so the semaphore permit cannot be released while disk work is
        // still running in the background after a timeout.
        let sanitized = tokio::task::spawn_blocking(move || {
            sanitize_public_bundle(
                source,
                &project_id,
                &storage_scope_id,
                expected_logical_bytes,
                expected_file_count,
            )
        })
        .await
        .map_err(|_| PublishedContentError::ObjectUnavailable)??;
        let current = time::timeout(
            self.operation_timeout,
            load_descriptor(&self.pool, public_id, version_number),
        )
        .await
        .map_err(|_| PublishedContentError::OperationTimeout)??;
        if current.descriptor != loaded.descriptor || current.object_key != loaded.object_key {
            return Err(PublishedContentError::ObjectMismatch);
        }
        let checksum = URL_SAFE_NO_PAD.encode(sanitized.sha256);
        Ok(PublishedContentDownload {
            descriptor: PublishedContentDescriptor {
                version_number: loaded.descriptor.version_number,
                checksum,
                physical_bytes: sanitized.physical_bytes,
                logical_bytes: loaded.descriptor.logical_bytes,
                file_count: loaded.descriptor.file_count,
            },
            reader: Box::pin(PermittedFileReader {
                file: tokio::fs::File::from_std(sanitized.file),
                _permit: permit,
            }),
        })
    }
}

type ContentRow = (i64, Vec<u8>, i64, i64, i32, String, String, String, String);

#[derive(Clone, Debug, PartialEq, Eq)]
struct SourceDescriptor {
    version_number: i64,
    source_sha256: [u8; 32],
    physical_bytes: u64,
    logical_bytes: u64,
    file_count: u32,
}

#[derive(Debug)]
struct LoadedContent {
    descriptor: SourceDescriptor,
    object_key: String,
    project_id: ProjectId,
    storage_scope_id: StorageScopeId,
}

async fn load_descriptor(
    pool: &DatabasePool,
    public_id: &PublishedExamplePublicId,
    version_number: Option<i64>,
) -> Result<LoadedContent, PublishedContentError> {
    // One statement fences publication state, selected immutable version, and
    // verified Bundle metadata. No Project ACL, user, or storage identifier is
    // projected across the public boundary.
    let row = sqlx::query_as::<_, ContentRow>(
        "SELECT version.version_number,bundle.sha256,bundle.physical_bytes,\
                bundle.logical_bytes,bundle.file_count,bundle.format,bundle.object_key,\
                version.project_id::text,reference.storage_scope_id::text \
         FROM published_examples example \
         JOIN published_example_versions version ON version.example_id=example.id \
         JOIN project_bundle_refs reference ON reference.id=version.project_version_id \
              AND reference.project_id=version.project_id AND reference.kind='version' \
         JOIN bundles bundle ON bundle.id=reference.bundle_id \
              AND bundle.verification_state='verified' \
         WHERE example.public_id=$1 AND example.state='published' \
           AND (($2::bigint IS NULL AND version.id=example.active_version_id) \
                OR ($2::bigint IS NOT NULL AND version.version_number=$2))",
    )
    .bind(public_id.as_str())
    .bind(version_number)
    .fetch_optional(
        &mut *pool
            .acquire()
            .await
            .map_err(|_| PublishedContentError::PersistenceUnavailable)?,
    )
    .await
    .map_err(|_| PublishedContentError::PersistenceUnavailable)?
    .ok_or(PublishedContentError::NotFound)?;
    decode_descriptor(row)
}

fn decode_descriptor(row: ContentRow) -> Result<LoadedContent, PublishedContentError> {
    let digest: [u8; 32] = row
        .1
        .try_into()
        .map_err(|_| PublishedContentError::InvariantViolation)?;
    let physical_bytes =
        u64::try_from(row.2).map_err(|_| PublishedContentError::InvariantViolation)?;
    let logical_bytes =
        u64::try_from(row.3).map_err(|_| PublishedContentError::InvariantViolation)?;
    let file_count = u32::try_from(row.4).map_err(|_| PublishedContentError::InvariantViolation)?;
    if row.0 < 1
        || physical_bytes == 0
        || logical_bytes > MAX_LOGICAL_BYTES
        || file_count > MAX_FILE_COUNT
        || row.5 != "project-bundle-v1"
    {
        return Err(PublishedContentError::InvariantViolation);
    }
    if physical_bytes > MAX_PHYSICAL_BUNDLE_BYTES {
        return Err(PublishedContentError::TooLarge);
    }
    if !valid_object_key(&row.6) {
        return Err(PublishedContentError::InvariantViolation);
    }
    ObjectKey::parse(row.6.clone()).map_err(|_| PublishedContentError::InvariantViolation)?;
    Ok(LoadedContent {
        descriptor: SourceDescriptor {
            version_number: row.0,
            source_sha256: digest,
            physical_bytes,
            logical_bytes,
            file_count,
        },
        object_key: row.6,
        project_id: ProjectId::from_str(&row.7)
            .map_err(|_| PublishedContentError::InvariantViolation)?,
        storage_scope_id: StorageScopeId::from_str(&row.8)
            .map_err(|_| PublishedContentError::InvariantViolation)?,
    })
}

#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
struct PublicManifest<'a> {
    format: &'static str,
    schema_version: u8,
    file_count: usize,
    logical_bytes: u64,
    files: Vec<PublicManifestFile<'a>>,
}

#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
struct PublicManifestFile<'a> {
    path: &'a str,
    kind: &'static str,
    mode: &'static str,
    size_bytes: u64,
    sha256: String,
}

#[derive(Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
struct SourceManifest {
    format: String,
    schema_version: u8,
    project: SourceManifestProject,
    file_count: usize,
    logical_bytes: u64,
    files: Vec<SourceManifestFile>,
}

#[derive(Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
struct SourceManifestProject {
    id: String,
    storage_scope_id: String,
}

#[derive(Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
struct SourceManifestFile {
    path: String,
    kind: String,
    mode: String,
    size_bytes: u64,
    sha256: String,
}

struct SanitizedFile {
    file: std::fs::File,
    physical_bytes: u64,
    sha256: [u8; 32],
}

async fn spool_verified_source(
    mut reader: Pin<Box<dyn AsyncRead + Send>>,
    descriptor: &SourceDescriptor,
) -> Result<std::fs::File, PublishedContentError> {
    let file = tempfile::tempfile().map_err(|_| PublishedContentError::ObjectUnavailable)?;
    let mut file = tokio::fs::File::from_std(file);
    let mut digest = Sha256::new();
    let mut total = 0_u64;
    let mut buffer = [0_u8; 64 * 1024];
    time::timeout(SANITIZE_TIMEOUT, async {
        loop {
            let read = reader
                .read(&mut buffer)
                .await
                .map_err(|_| PublishedContentError::ObjectUnavailable)?;
            if read == 0 {
                break;
            }
            total = total
                .checked_add(read as u64)
                .ok_or(PublishedContentError::TooLarge)?;
            if total > descriptor.physical_bytes {
                return Err(PublishedContentError::ObjectMismatch);
            }
            digest.update(&buffer[..read]);
            file.write_all(&buffer[..read])
                .await
                .map_err(|_| PublishedContentError::ObjectUnavailable)?;
        }
        file.flush()
            .await
            .map_err(|_| PublishedContentError::ObjectUnavailable)
    })
    .await
    .map_err(|_| PublishedContentError::OperationTimeout)??;
    let source_digest: [u8; 32] = digest.finalize().into();
    if total != descriptor.physical_bytes || source_digest != descriptor.source_sha256 {
        return Err(PublishedContentError::ObjectMismatch);
    }
    Ok(file.into_std().await)
}

fn sanitize_public_bundle(
    mut source: std::fs::File,
    project_id: &str,
    storage_scope_id: &str,
    expected_logical_bytes: u64,
    expected_file_count: u32,
) -> Result<SanitizedFile, PublishedContentError> {
    source
        .seek(SeekFrom::Start(0))
        .map_err(|_| PublishedContentError::ObjectUnavailable)?;
    let manifest_header = read_block(&mut source)?;
    let manifest_size = header_size(&manifest_header)?;
    if manifest_size > MAX_MANIFEST_BYTES
        || manifest_header != canonical_tar_header("manifest.json", manifest_size, 0o644, b'0')?
    {
        return Err(PublishedContentError::ObjectMismatch);
    }
    let manifest_bytes = read_content(&mut source, manifest_size)?;
    let manifest: SourceManifest = serde_json::from_slice(&manifest_bytes)
        .map_err(|_| PublishedContentError::ObjectMismatch)?;
    validate_source_manifest(
        &manifest,
        project_id,
        storage_scope_id,
        expected_logical_bytes,
        expected_file_count,
    )?;

    let manifest_files = manifest
        .files
        .iter()
        .map(|file| PublicManifestFile {
            path: &file.path,
            kind: if file.kind == "text" {
                "text"
            } else {
                "binary"
            },
            mode: if file.mode == "0755" { "0755" } else { "0644" },
            size_bytes: file.size_bytes,
            sha256: file.sha256.clone(),
        })
        .collect::<Vec<_>>();
    let manifest = PublicManifest {
        format: PUBLIC_FORMAT,
        schema_version: 1,
        file_count: manifest.files.len(),
        logical_bytes: manifest.logical_bytes,
        files: manifest_files,
    };
    let mut manifest_bytes =
        serde_json::to_vec(&manifest).map_err(|_| PublishedContentError::InvariantViolation)?;
    manifest_bytes.push(b'\n');
    let mut output = tempfile::tempfile().map_err(|_| PublishedContentError::ObjectUnavailable)?;
    write_tar_entry(&mut output, "manifest.json", b'0', 0o644, &manifest_bytes)?;
    for (index, expected) in manifest.files.iter().enumerate() {
        let pax_bytes = pax_record("path", &format!("files/{}", expected.path));
        let pax_header = read_block(&mut source)?;
        if pax_header
            != canonical_tar_header(
                &format!("PaxHeaders/{index:08}"),
                pax_bytes.len() as u64,
                0o644,
                b'x',
            )?
            || read_content(&mut source, pax_bytes.len() as u64)? != pax_bytes
        {
            return Err(PublishedContentError::ObjectMismatch);
        }
        let file_header = read_block(&mut source)?;
        let mode = if expected.mode == "0755" {
            0o755
        } else {
            0o644
        };
        if file_header
            != canonical_tar_header(
                &format!("files/{index:08}"),
                expected.size_bytes,
                mode,
                b'0',
            )?
        {
            return Err(PublishedContentError::ObjectMismatch);
        }
        let content = read_content(&mut source, expected.size_bytes)?;
        if hex(&Sha256::digest(&content)) != expected.sha256
            || (expected.kind == "text" && std::str::from_utf8(&content).is_err())
        {
            return Err(PublishedContentError::ObjectMismatch);
        }
        write_tar_entry(
            &mut output,
            &format!("PaxHeaders/{index:08}"),
            b'x',
            0o644,
            &pax_bytes,
        )?;
        write_tar_entry(
            &mut output,
            &format!("files/{index:08}"),
            b'0',
            mode,
            &content,
        )?;
    }
    if read_block(&mut source)? != [0_u8; TAR_BLOCK_BYTES]
        || read_block(&mut source)? != [0_u8; TAR_BLOCK_BYTES]
        || source
            .read(&mut [0_u8; 1])
            .map_err(|_| PublishedContentError::ObjectUnavailable)?
            != 0
    {
        return Err(PublishedContentError::ObjectMismatch);
    }
    output
        .write_all(&[0_u8; TAR_BLOCK_BYTES * 2])
        .map_err(|_| PublishedContentError::ObjectUnavailable)?;
    output
        .flush()
        .map_err(|_| PublishedContentError::ObjectUnavailable)?;
    let physical_bytes = output
        .stream_position()
        .map_err(|_| PublishedContentError::ObjectUnavailable)?;
    if physical_bytes > MAX_PHYSICAL_BUNDLE_BYTES {
        return Err(PublishedContentError::TooLarge);
    }
    output
        .seek(SeekFrom::Start(0))
        .map_err(|_| PublishedContentError::ObjectUnavailable)?;
    let mut digest = Sha256::new();
    let mut buffer = [0_u8; 64 * 1024];
    loop {
        let read = output
            .read(&mut buffer)
            .map_err(|_| PublishedContentError::ObjectUnavailable)?;
        if read == 0 {
            break;
        }
        digest.update(&buffer[..read]);
    }
    output
        .seek(SeekFrom::Start(0))
        .map_err(|_| PublishedContentError::ObjectUnavailable)?;
    Ok(SanitizedFile {
        file: output,
        physical_bytes,
        sha256: digest.finalize().into(),
    })
}

fn validate_source_manifest(
    manifest: &SourceManifest,
    project_id: &str,
    storage_scope_id: &str,
    expected_logical_bytes: u64,
    expected_file_count: u32,
) -> Result<(), PublishedContentError> {
    if manifest.format != "project-bundle-v1"
        || manifest.schema_version != 1
        || manifest.project.id != project_id
        || manifest.project.storage_scope_id != storage_scope_id
        || manifest.file_count != manifest.files.len()
        || manifest.file_count != expected_file_count as usize
        || manifest.logical_bytes != expected_logical_bytes
        || manifest.logical_bytes > MAX_LOGICAL_BYTES
        || manifest.file_count > MAX_FILE_COUNT as usize
    {
        return Err(PublishedContentError::ObjectMismatch);
    }
    let mut logical_bytes = 0_u64;
    let mut previous_path: Option<&str> = None;
    for file in &manifest.files {
        if !valid_bundle_path(&file.path)
            || previous_path.is_some_and(|previous| previous >= file.path.as_str())
            || file.size_bytes > MAX_FILE_BYTES
            || !matches!(file.kind.as_str(), "text" | "binary")
            || !matches!(file.mode.as_str(), "0644" | "0755")
            || file.sha256.len() != 64
            || !file
                .sha256
                .bytes()
                .all(|byte| byte.is_ascii_hexdigit() && !byte.is_ascii_uppercase())
        {
            return Err(PublishedContentError::ObjectMismatch);
        }
        logical_bytes = logical_bytes
            .checked_add(file.size_bytes)
            .filter(|value| *value <= MAX_LOGICAL_BYTES)
            .ok_or(PublishedContentError::ObjectMismatch)?;
        previous_path = Some(&file.path);
    }
    if logical_bytes != manifest.logical_bytes {
        return Err(PublishedContentError::ObjectMismatch);
    }
    Ok(())
}

fn valid_bundle_path(value: &str) -> bool {
    !value.is_empty()
        && value.len() <= 1_024
        && value.nfc().eq(value.chars())
        && !value.starts_with('/')
        && !value.contains('\\')
        && !value.chars().any(char::is_control)
        && value.split('/').count() <= 64
        && value.split('/').all(|part| {
            !part.is_empty() && part != "." && part != ".." && part != ".git" && part.len() <= 255
        })
}

fn read_block(source: &mut std::fs::File) -> Result<[u8; TAR_BLOCK_BYTES], PublishedContentError> {
    let mut block = [0_u8; TAR_BLOCK_BYTES];
    source
        .read_exact(&mut block)
        .map_err(|_| PublishedContentError::ObjectMismatch)?;
    Ok(block)
}

fn read_content(source: &mut std::fs::File, size: u64) -> Result<Vec<u8>, PublishedContentError> {
    let size = usize::try_from(size).map_err(|_| PublishedContentError::TooLarge)?;
    let mut content = vec![0_u8; size];
    source
        .read_exact(&mut content)
        .map_err(|_| PublishedContentError::ObjectMismatch)?;
    let padding = (TAR_BLOCK_BYTES - size % TAR_BLOCK_BYTES) % TAR_BLOCK_BYTES;
    let mut padding_bytes = vec![0_u8; padding];
    source
        .read_exact(&mut padding_bytes)
        .map_err(|_| PublishedContentError::ObjectMismatch)?;
    if padding_bytes.iter().any(|byte| *byte != 0) {
        return Err(PublishedContentError::ObjectMismatch);
    }
    Ok(content)
}

fn header_size(header: &[u8; TAR_BLOCK_BYTES]) -> Result<u64, PublishedContentError> {
    let field = &header[124..136];
    if field.last() != Some(&0)
        || field[..field.len() - 1]
            .iter()
            .any(|byte| !matches!(byte, b'0'..=b'7'))
    {
        return Err(PublishedContentError::ObjectMismatch);
    }
    std::str::from_utf8(&field[..field.len() - 1])
        .ok()
        .and_then(|value| u64::from_str_radix(value, 8).ok())
        .ok_or(PublishedContentError::ObjectMismatch)
}

fn write_tar_entry(
    output: &mut std::fs::File,
    name: &str,
    entry_type: u8,
    mode: u32,
    content: &[u8],
) -> Result<(), PublishedContentError> {
    output
        .write_all(&canonical_tar_header(
            name,
            content.len() as u64,
            mode,
            entry_type,
        )?)
        .and_then(|()| output.write_all(content))
        .map_err(|_| PublishedContentError::ObjectUnavailable)?;
    let padding = (TAR_BLOCK_BYTES - content.len() % TAR_BLOCK_BYTES) % TAR_BLOCK_BYTES;
    output
        .write_all(&[0_u8; TAR_BLOCK_BYTES][..padding])
        .map_err(|_| PublishedContentError::ObjectUnavailable)
}

fn canonical_tar_header(
    name: &str,
    size: u64,
    mode: u32,
    entry_type: u8,
) -> Result<[u8; TAR_BLOCK_BYTES], PublishedContentError> {
    if name.len() > 100 || !name.is_ascii() {
        return Err(PublishedContentError::InvariantViolation);
    }
    let mut header = [0_u8; TAR_BLOCK_BYTES];
    header[..name.len()].copy_from_slice(name.as_bytes());
    write_octal(&mut header[100..108], u64::from(mode))?;
    write_octal(&mut header[108..116], 0)?;
    write_octal(&mut header[116..124], 0)?;
    write_octal(&mut header[124..136], size)?;
    write_octal(&mut header[136..148], 0)?;
    header[148..156].fill(b' ');
    header[156] = entry_type;
    header[257..263].copy_from_slice(b"ustar\0");
    header[263..265].copy_from_slice(b"00");
    let checksum: u64 = header.iter().map(|byte| u64::from(*byte)).sum();
    let digits = format!("{checksum:06o}");
    if digits.len() != 6 {
        return Err(PublishedContentError::InvariantViolation);
    }
    header[148..154].copy_from_slice(digits.as_bytes());
    header[154] = 0;
    header[155] = b' ';
    Ok(header)
}

fn write_octal(field: &mut [u8], value: u64) -> Result<(), PublishedContentError> {
    let last = field
        .len()
        .checked_sub(1)
        .ok_or(PublishedContentError::InvariantViolation)?;
    let digits = format!("{value:0width$o}", width = last);
    if digits.len() != last {
        return Err(PublishedContentError::InvariantViolation);
    }
    field[..last].copy_from_slice(digits.as_bytes());
    field[last] = 0;
    Ok(())
}

fn pax_record(key: &str, value: &str) -> Vec<u8> {
    let body = format!("{key}={value}\n");
    let mut length = body.len() + 2;
    loop {
        let record = format!("{length} {body}");
        if record.len() == length {
            return record.into_bytes();
        }
        length = record.len();
    }
}

fn hex(bytes: &[u8]) -> String {
    use std::fmt::Write as _;
    let mut output = String::with_capacity(bytes.len() * 2);
    for byte in bytes {
        let _ = write!(output, "{byte:02x}");
    }
    output
}

fn valid_object_key(value: &str) -> bool {
    value == value.trim()
        && !value.starts_with('/')
        && !value.contains("//")
        && !value.chars().any(char::is_control)
        && value
            .split('/')
            .all(|segment| !segment.is_empty() && segment != "." && segment != "..")
}

fn map_store_error(error: crate::object_storage::ObjectStoreError) -> PublishedContentError {
    match error.kind() {
        ObjectStoreErrorKind::Timeout => PublishedContentError::OperationTimeout,
        ObjectStoreErrorKind::Integrity | ObjectStoreErrorKind::ResponseTooLarge => {
            PublishedContentError::ObjectMismatch
        }
        _ => PublishedContentError::ObjectUnavailable,
    }
}

#[cfg(test)]
mod tests {
    use bytes::Bytes;

    use super::*;
    use crate::{
        git_operations::embedded::{GitTreeFile, GitTreeSnapshot},
        save::encode_git_snapshot,
    };

    #[test]
    fn descriptor_accepts_only_verified_project_bundle_shape() {
        let valid = (
            3,
            vec![7; 32],
            512,
            1_024,
            8,
            "project-bundle-v1".to_owned(),
            "bundles/verified/example.tar".to_owned(),
            "0199ee6c-c777-7000-8000-00000000b001".to_owned(),
            "0199ee6c-c777-7000-8000-00000000b002".to_owned(),
        );
        let loaded = decode_descriptor(valid.clone()).expect("valid descriptor");
        assert_eq!(loaded.descriptor.version_number, 3);
        assert_eq!(loaded.descriptor.physical_bytes, 512);

        let mut invalid_format = valid.clone();
        invalid_format.5 = "zip".to_owned();
        assert_eq!(
            decode_descriptor(invalid_format).unwrap_err(),
            PublishedContentError::InvariantViolation
        );

        let mut invalid_key = valid;
        invalid_key.6 = "../secret".to_owned();
        assert_eq!(
            decode_descriptor(invalid_key).unwrap_err(),
            PublishedContentError::InvariantViolation
        );
    }

    #[test]
    fn public_archive_replaces_internal_manifest_identity() {
        let snapshot = GitTreeSnapshot::new(vec![
            GitTreeFile::new("src/main.ts", false, Bytes::from_static(b"export {};\n"))
                .expect("valid source file"),
        ])
        .expect("valid snapshot");
        let project_id =
            ProjectId::from_str("0199ee6c-c777-7000-8000-00000000b001").expect("project id");
        let storage_scope_id = StorageScopeId::from_str("0199ee6c-c777-7000-8000-00000000b002")
            .expect("storage scope id");
        let source = encode_git_snapshot(project_id, storage_scope_id, &snapshot)
            .expect("canonical source bundle");
        let mut source_file = tempfile::tempfile().expect("source tempfile");
        source_file.write_all(source.bytes()).expect("write source");
        let mut sanitized = sanitize_public_bundle(
            source_file,
            &project_id.to_string(),
            &storage_scope_id.to_string(),
            source.logical_bytes(),
            source.file_count(),
        )
        .expect("public bundle");
        let mut bundle = Vec::new();
        sanitized
            .file
            .read_to_end(&mut bundle)
            .expect("read public bundle");
        assert_eq!(&bundle[..14], b"manifest.json\0");
        let manifest_size = std::str::from_utf8(&bundle[124..135])
            .expect("octal size is ASCII")
            .trim_matches(char::from(0));
        let manifest_size = usize::from_str_radix(manifest_size, 8).expect("valid octal size");
        let manifest: serde_json::Value =
            serde_json::from_slice(&bundle[TAR_BLOCK_BYTES..TAR_BLOCK_BYTES + manifest_size])
                .expect("valid public manifest");
        assert_eq!(
            manifest
                .as_object()
                .expect("manifest object")
                .keys()
                .collect::<Vec<_>>(),
            vec![
                "fileCount",
                "files",
                "format",
                "logicalBytes",
                "schemaVersion"
            ]
        );
        assert_eq!(manifest["format"], PUBLIC_FORMAT);
        let encoded_manifest = serde_json::to_string(&manifest).expect("serializable manifest");
        assert!(!encoded_manifest.contains("projectId"));
        assert!(!encoded_manifest.contains("storageScopeId"));
        assert!(!encoded_manifest.contains("0199ee6c-c777-7000-8000-00000000b001"));
        assert!(!encoded_manifest.contains("0199ee6c-c777-7000-8000-00000000b002"));
        let archive = String::from_utf8_lossy(&bundle);
        assert!(!archive.contains("0199ee6c-c777-7000-8000-00000000b001"));
        assert!(!archive.contains("0199ee6c-c777-7000-8000-00000000b002"));
    }
}
