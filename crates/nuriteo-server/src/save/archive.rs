use std::pin::Pin;

use serde::{Deserialize, Serialize};
use sha2::{Digest, Sha256};
use tokio::io::{AsyncRead, AsyncReadExt};

use super::admission::{AdmissionContract, ROOT_IGNORE_PATH};
use super::verifier::VerificationError;

const BLOCK: usize = 512;
const MANIFEST_NAME: &str = "manifest.json";
const MAX_MANIFEST_BYTES: u64 = 4 * 1024 * 1024;

#[derive(Debug, Clone, PartialEq, Eq)]
pub(super) struct VerifiedArchive {
    pub archive_sha256: [u8; 32],
    pub physical_bytes: u64,
    pub logical_bytes: u64,
    pub file_count: u32,
}

#[derive(Debug, Serialize, Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
struct Manifest {
    format: String,
    schema_version: u8,
    project: ManifestProject,
    file_count: usize,
    logical_bytes: u64,
    files: Vec<ManifestFile>,
}

#[derive(Debug, Serialize, Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
struct ManifestProject {
    id: String,
    storage_scope_id: String,
}

#[derive(Debug, Serialize, Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
struct ManifestFile {
    path: String,
    kind: FileKind,
    mode: FileMode,
    size_bytes: u64,
    sha256: String,
}

#[derive(Debug, Serialize, Deserialize)]
#[serde(rename_all = "lowercase")]
enum FileKind {
    Text,
    Binary,
}

#[derive(Debug, Serialize, Deserialize)]
enum FileMode {
    #[serde(rename = "0644")]
    Regular,
    #[serde(rename = "0755")]
    Executable,
}

pub(super) async fn verify_archive(
    reader: Pin<Box<dyn AsyncRead + Send>>,
    expected_physical_bytes: u64,
    project_id: &str,
    storage_scope_id: &str,
    admission: &AdmissionContract,
) -> Result<VerifiedArchive, VerificationError> {
    let mut input = CountingReader::new(reader, expected_physical_bytes);
    let manifest_header = input.read_header().await?;
    validate_canonical_header(&manifest_header, MANIFEST_NAME, b'0', 0o644, None)?;
    let manifest_size = header_size(&manifest_header)?;
    if manifest_size == 0 || manifest_size > MAX_MANIFEST_BYTES {
        return Err(VerificationError::InvalidArchive);
    }
    let manifest_bytes = input.read_vec(manifest_size).await?;
    input.read_zero_padding(manifest_size).await?;
    let manifest: Manifest =
        serde_json::from_slice(&manifest_bytes).map_err(|_| VerificationError::InvalidArchive)?;
    let mut canonical =
        serde_json::to_vec(&manifest).map_err(|_| VerificationError::InvariantViolation)?;
    canonical.push(b'\n');
    if canonical != manifest_bytes
        || manifest.format != "project-bundle-v1"
        || manifest.schema_version != 1
        || manifest.project.id != project_id
        || manifest.project.storage_scope_id != storage_scope_id
        || manifest.file_count != manifest.files.len()
        || manifest.file_count > admission.limits.max_files
    {
        return Err(VerificationError::InvalidArchive);
    }

    let mut logical = 0_u64;
    let mut previous: Option<&str> = None;
    for file in &manifest.files {
        admission.validate_path(&file.path)?;
        if previous.is_some_and(|value| value.as_bytes() >= file.path.as_bytes())
            || file.size_bytes > admission.limits.max_file_bytes
            || file.sha256.len() != 64
            || !file
                .sha256
                .bytes()
                .all(|byte| byte.is_ascii_hexdigit() && !byte.is_ascii_uppercase())
        {
            return Err(VerificationError::InvalidArchive);
        }
        logical = logical
            .checked_add(file.size_bytes)
            .ok_or(VerificationError::InvalidArchive)?;
        previous = Some(&file.path);
    }
    if logical != manifest.logical_bytes || logical > admission.limits.max_logical_bytes {
        return Err(VerificationError::InvalidArchive);
    }

    let mut ignore_source = None;
    for (index, file) in manifest.files.iter().enumerate() {
        let sequence = format!("{index:08}");
        let pax_name = format!("PaxHeaders/{sequence}");
        let pax_header = input.read_header().await?;
        validate_canonical_header(&pax_header, &pax_name, b'x', 0o644, None)?;
        let pax_size = header_size(&pax_header)?;
        if pax_size == 0 || pax_size > admission.limits.max_path_bytes as u64 + 32 {
            return Err(VerificationError::InvalidArchive);
        }
        let pax = input.read_vec(pax_size).await?;
        input.read_zero_padding(pax_size).await?;
        let archive_path = format!("files/{}", file.path);
        if pax != pax_record("path", &archive_path) {
            return Err(VerificationError::InvalidArchive);
        }

        let file_name = format!("files/{sequence}");
        let file_header = input.read_header().await?;
        let mode = match file.mode {
            FileMode::Regular => 0o644,
            FileMode::Executable => 0o755,
        };
        validate_canonical_header(&file_header, &file_name, b'0', mode, Some(file.size_bytes))?;
        let capture = file.path == ROOT_IGNORE_PATH;
        let (digest, captured) = input.read_file(file.size_bytes, capture).await?;
        input.read_zero_padding(file.size_bytes).await?;
        if hex(&digest) != file.sha256 {
            return Err(VerificationError::InvalidArchive);
        }
        if capture {
            if !matches!(file.kind, FileKind::Text) {
                return Err(VerificationError::InvalidArchive);
            }
            ignore_source = captured;
        }
    }
    admission.validate_admitted_paths(
        &manifest
            .files
            .iter()
            .map(|file| file.path.clone())
            .collect::<Vec<_>>(),
        ignore_source.as_deref(),
    )?;

    if input.read_header().await? != [0_u8; BLOCK] || input.read_header().await? != [0_u8; BLOCK] {
        return Err(VerificationError::InvalidArchive);
    }
    let result = input.finish().await?;
    if result.physical_bytes != expected_physical_bytes {
        return Err(VerificationError::ObjectMismatch);
    }
    Ok(VerifiedArchive {
        archive_sha256: result.digest,
        physical_bytes: result.physical_bytes,
        logical_bytes: logical,
        file_count: u32::try_from(manifest.file_count)
            .map_err(|_| VerificationError::InvalidArchive)?,
    })
}

struct CountingReader {
    reader: Pin<Box<dyn AsyncRead + Send>>,
    digest: Sha256,
    count: u64,
    maximum: u64,
}

struct StreamResult {
    digest: [u8; 32],
    physical_bytes: u64,
}

impl CountingReader {
    fn new(reader: Pin<Box<dyn AsyncRead + Send>>, maximum: u64) -> Self {
        Self {
            reader,
            digest: Sha256::new(),
            count: 0,
            maximum,
        }
    }

    async fn read_header(&mut self) -> Result<[u8; BLOCK], VerificationError> {
        let mut block = [0_u8; BLOCK];
        self.read_exact(&mut block).await?;
        Ok(block)
    }

    async fn read_vec(&mut self, length: u64) -> Result<Vec<u8>, VerificationError> {
        let length = usize::try_from(length).map_err(|_| VerificationError::InvalidArchive)?;
        let mut bytes = vec![0; length];
        self.read_exact(&mut bytes).await?;
        Ok(bytes)
    }

    async fn read_file(
        &mut self,
        length: u64,
        capture: bool,
    ) -> Result<([u8; 32], Option<Vec<u8>>), VerificationError> {
        let mut remaining = length;
        let mut digest = Sha256::new();
        let mut captured =
            capture.then(|| Vec::with_capacity(usize::try_from(length).unwrap_or_default()));
        // Keep the async state machine compact as well as heap usage bounded;
        // large stack buffers are multiplied by nested timeout futures.
        let mut buffer = [0_u8; 8 * 1024];
        while remaining > 0 {
            let amount = usize::try_from(remaining.min(buffer.len() as u64))
                .map_err(|_| VerificationError::InvalidArchive)?;
            self.read_exact(&mut buffer[..amount]).await?;
            digest.update(&buffer[..amount]);
            if let Some(value) = &mut captured {
                value.extend_from_slice(&buffer[..amount]);
            }
            remaining -= amount as u64;
        }
        Ok((digest.finalize().into(), captured))
    }

    async fn read_zero_padding(&mut self, length: u64) -> Result<(), VerificationError> {
        let padding = (BLOCK as u64 - length % BLOCK as u64) % BLOCK as u64;
        if padding == 0 {
            return Ok(());
        }
        let mut bytes = [0_u8; BLOCK];
        self.read_exact(&mut bytes[..padding as usize]).await?;
        if bytes[..padding as usize].iter().any(|byte| *byte != 0) {
            return Err(VerificationError::InvalidArchive);
        }
        Ok(())
    }

    async fn read_exact(&mut self, target: &mut [u8]) -> Result<(), VerificationError> {
        let next = self
            .count
            .checked_add(target.len() as u64)
            .ok_or(VerificationError::ObjectMismatch)?;
        if next > self.maximum {
            return Err(VerificationError::ObjectMismatch);
        }
        self.reader
            .read_exact(target)
            .await
            .map_err(|_| VerificationError::StorageUnavailable)?;
        self.digest.update(&*target);
        self.count = next;
        Ok(())
    }

    async fn finish(mut self) -> Result<StreamResult, VerificationError> {
        let mut extra = [0_u8; 1];
        if self
            .reader
            .read(&mut extra)
            .await
            .map_err(|_| VerificationError::StorageUnavailable)?
            != 0
        {
            return Err(VerificationError::ObjectMismatch);
        }
        Ok(StreamResult {
            digest: self.digest.finalize().into(),
            physical_bytes: self.count,
        })
    }
}

fn header_size(header: &[u8; BLOCK]) -> Result<u64, VerificationError> {
    parse_octal(&header[124..136])
}

fn parse_octal(field: &[u8]) -> Result<u64, VerificationError> {
    if field.last() != Some(&0)
        || field[..field.len() - 1]
            .iter()
            .any(|byte| !matches!(byte, b'0'..=b'7'))
    {
        return Err(VerificationError::InvalidArchive);
    }
    std::str::from_utf8(&field[..field.len() - 1])
        .ok()
        .and_then(|value| u64::from_str_radix(value, 8).ok())
        .ok_or(VerificationError::InvalidArchive)
}

fn validate_canonical_header(
    actual: &[u8; BLOCK],
    name: &str,
    entry_type: u8,
    mode: u32,
    expected_size: Option<u64>,
) -> Result<(), VerificationError> {
    let size = header_size(actual)?;
    if expected_size.is_some_and(|expected| expected != size)
        || actual != &canonical_header(name, size, mode, entry_type)?
    {
        return Err(VerificationError::InvalidArchive);
    }
    Ok(())
}

fn canonical_header(
    name: &str,
    size: u64,
    mode: u32,
    entry_type: u8,
) -> Result<[u8; BLOCK], VerificationError> {
    if name.len() > 100 {
        return Err(VerificationError::InvalidArchive);
    }
    let mut header = [0_u8; BLOCK];
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
        return Err(VerificationError::InvalidArchive);
    }
    header[148..154].copy_from_slice(digits.as_bytes());
    header[154] = 0;
    header[155] = b' ';
    Ok(header)
}

fn write_octal(field: &mut [u8], value: u64) -> Result<(), VerificationError> {
    let digit_count = field.len() - 1;
    let digits = format!("{:0width$o}", value, width = digit_count);
    if digits.len() != digit_count {
        return Err(VerificationError::InvalidArchive);
    }
    field[..digit_count].copy_from_slice(digits.as_bytes());
    field[digit_count] = 0;
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

fn hex(digest: &[u8; 32]) -> String {
    use std::fmt::Write as _;
    let mut output = String::with_capacity(64);
    for byte in digest {
        let _ = write!(output, "{byte:02x}");
    }
    output
}

#[cfg(test)]
mod tests {
    use super::*;
    use tokio::io::AsyncRead;

    fn reader(bytes: Vec<u8>) -> Pin<Box<dyn AsyncRead + Send>> {
        Box::pin(std::io::Cursor::new(bytes))
    }

    #[tokio::test]
    async fn rejects_noncanonical_trailing_payload() {
        let contract = AdmissionContract::load().unwrap();
        let bytes = vec![0_u8; 1025];
        assert!(
            verify_archive(reader(bytes), 1025, "p", "s", &contract)
                .await
                .is_err()
        );
    }

    #[tokio::test]
    async fn accepts_the_bnd_001_golden_archive() {
        let bytes = golden_archive();
        assert_eq!(bytes.len(), 8_704);
        assert_eq!(
            hex(&Sha256::digest(&bytes).into()),
            "35a1c7611d15c251b4c5bdc1a0b99fafb64b8f2a23c233938bb7e42e20757ae4"
        );
        let verified = verify_archive(
            reader(bytes.clone()),
            bytes.len() as u64,
            "0199ee6c-c777-7000-8000-00000000b001",
            "0199ee6c-c777-7000-8000-00000000b002",
            &AdmissionContract::load().unwrap(),
        )
        .await
        .unwrap();
        assert_eq!(verified.logical_bytes, 73);
        assert_eq!(verified.file_count, 3);
    }

    #[tokio::test]
    async fn rejects_corrupt_header_checksum_manifest_file_and_padding() {
        let contract = AdmissionContract::load().unwrap();
        let source = golden_archive();
        for offset in [148_usize, 512, 2_048 + 512, 8_703] {
            let mut corrupt = source.clone();
            corrupt[offset] ^= 1;
            assert_eq!(
                verify_archive(
                    reader(corrupt.clone()),
                    corrupt.len() as u64,
                    "0199ee6c-c777-7000-8000-00000000b001",
                    "0199ee6c-c777-7000-8000-00000000b002",
                    &contract,
                )
                .await
                .unwrap_err(),
                VerificationError::InvalidArchive
            );
        }
    }

    fn golden_archive() -> Vec<u8> {
        let files: [(&str, FileKind, FileMode, &[u8]); 3] = [
            (
                "assets/pixel.bin",
                FileKind::Binary,
                FileMode::Regular,
                &[0, 255, 1, 2, 13, 10, 128],
            ),
            (
                "scripts/start.sh",
                FileKind::Text,
                FileMode::Executable,
                b"#!/bin/sh\nprintf 'ready\\n'\n",
            ),
            (
                "src/éxample.ts",
                FileKind::Text,
                FileMode::Regular,
                "export const greeting = \"안녕 🌱\";\n".as_bytes(),
            ),
        ];
        let manifest_files = files
            .iter()
            .map(|(path, kind, mode, bytes)| ManifestFile {
                path: (*path).to_owned(),
                kind: match kind {
                    FileKind::Text => FileKind::Text,
                    FileKind::Binary => FileKind::Binary,
                },
                mode: match mode {
                    FileMode::Regular => FileMode::Regular,
                    FileMode::Executable => FileMode::Executable,
                },
                size_bytes: bytes.len() as u64,
                sha256: hex(&Sha256::digest(bytes).into()),
            })
            .collect::<Vec<_>>();
        let manifest = Manifest {
            format: "project-bundle-v1".to_owned(),
            schema_version: 1,
            project: ManifestProject {
                id: "0199ee6c-c777-7000-8000-00000000b001".to_owned(),
                storage_scope_id: "0199ee6c-c777-7000-8000-00000000b002".to_owned(),
            },
            file_count: files.len(),
            logical_bytes: 73,
            files: manifest_files,
        };
        let mut manifest_bytes = serde_json::to_vec(&manifest).unwrap();
        manifest_bytes.push(b'\n');
        let mut output = entry(MANIFEST_NAME, b'0', 0o644, &manifest_bytes);
        for (index, (path, _, mode, bytes)) in files.iter().enumerate() {
            let sequence = format!("{index:08}");
            output.extend(entry(
                &format!("PaxHeaders/{sequence}"),
                b'x',
                0o644,
                &pax_record("path", &format!("files/{path}")),
            ));
            let numeric_mode = match mode {
                FileMode::Regular => 0o644,
                FileMode::Executable => 0o755,
            };
            output.extend(entry(
                &format!("files/{sequence}"),
                b'0',
                numeric_mode,
                bytes,
            ));
        }
        output.extend([0_u8; BLOCK * 2]);
        output
    }

    fn entry(name: &str, kind: u8, mode: u32, content: &[u8]) -> Vec<u8> {
        let mut value = canonical_header(name, content.len() as u64, mode, kind)
            .unwrap()
            .to_vec();
        value.extend(content);
        value.resize(value.len() + ((BLOCK - content.len() % BLOCK) % BLOCK), 0);
        value
    }
}
