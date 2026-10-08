use serde::{Deserialize, Serialize};
use sha2::{Digest, Sha256};

use crate::git_operations::embedded::{GitTreeFile, GitTreeSnapshot};
use crate::project::ProjectId;
use crate::workspace::StorageScopeId;

use super::VerificationError;
use super::admission::{AdmissionContract, ROOT_IGNORE_PATH};

const BLOCK: usize = 512;

#[derive(Debug, Clone)]
pub struct EncodedGitBundle {
    bytes: Vec<u8>,
    sha256: [u8; 32],
    logical_bytes: u64,
    file_count: u32,
}

impl EncodedGitBundle {
    #[must_use]
    pub fn bytes(&self) -> &[u8] {
        &self.bytes
    }
    #[must_use]
    pub const fn sha256(&self) -> &[u8; 32] {
        &self.sha256
    }
    #[must_use]
    pub const fn logical_bytes(&self) -> u64 {
        self.logical_bytes
    }
    #[must_use]
    pub const fn file_count(&self) -> u32 {
        self.file_count
    }

    pub(crate) fn into_parts(self) -> (Vec<u8>, [u8; 32], u64, u32) {
        (self.bytes, self.sha256, self.logical_bytes, self.file_count)
    }
}

#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
struct Manifest<'a> {
    format: &'static str,
    schema_version: u8,
    project: ManifestProject,
    file_count: usize,
    logical_bytes: u64,
    files: Vec<ManifestFile<'a>>,
}

#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
struct ManifestProject {
    id: String,
    storage_scope_id: String,
}

#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
struct ManifestFile<'a> {
    path: &'a str,
    kind: &'static str,
    mode: &'static str,
    size_bytes: u64,
    sha256: String,
}

#[derive(Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
struct DecodedManifest {
    format: String,
    schema_version: u8,
    project: DecodedProject,
    file_count: usize,
    logical_bytes: u64,
    files: Vec<DecodedFile>,
}

#[derive(Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
struct DecodedProject {
    id: String,
    storage_scope_id: String,
}

#[derive(Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
struct DecodedFile {
    path: String,
    kind: String,
    mode: String,
    size_bytes: u64,
    sha256: String,
}

pub fn encode_git_snapshot(
    project_id: ProjectId,
    storage_scope_id: StorageScopeId,
    snapshot: &GitTreeSnapshot,
) -> Result<EncodedGitBundle, VerificationError> {
    let admission = AdmissionContract::load()?;
    let paths = snapshot
        .files()
        .iter()
        .map(|file| file.path().to_owned())
        .collect::<Vec<_>>();
    let ignore = snapshot
        .files()
        .iter()
        .find(|file| file.path() == ROOT_IGNORE_PATH)
        .map(|file| file.content());
    let admitted = admission.admitted_paths(&paths, ignore)?;
    let files = snapshot
        .files()
        .iter()
        .zip(admitted)
        .filter_map(|(file, admitted)| admitted.then_some(file))
        .collect::<Vec<_>>();
    if files.len() > admission.limits.max_files {
        return Err(VerificationError::InvalidArchive);
    }
    let logical_bytes = files.iter().try_fold(0_u64, |total, file| {
        if file.content().len() as u64 > admission.limits.max_file_bytes {
            return Err(VerificationError::InvalidArchive);
        }
        total
            .checked_add(file.content().len() as u64)
            .filter(|value| *value <= admission.limits.max_logical_bytes)
            .ok_or(VerificationError::InvalidArchive)
    })?;
    let manifest_files = files
        .iter()
        .map(|file| ManifestFile {
            path: file.path(),
            kind: if std::str::from_utf8(file.content()).is_ok() {
                "text"
            } else {
                "binary"
            },
            mode: if file.executable() { "0755" } else { "0644" },
            size_bytes: file.content().len() as u64,
            sha256: hex(&Sha256::digest(file.content())),
        })
        .collect();
    let manifest = Manifest {
        format: "project-bundle-v1",
        schema_version: 1,
        project: ManifestProject {
            id: project_id.to_string(),
            storage_scope_id: storage_scope_id.to_string(),
        },
        file_count: files.len(),
        logical_bytes,
        files: manifest_files,
    };
    let mut manifest_bytes =
        serde_json::to_vec(&manifest).map_err(|_| VerificationError::InvariantViolation)?;
    manifest_bytes.push(b'\n');
    let mut bytes = Vec::new();
    append_entry(&mut bytes, "manifest.json", b'0', 0o644, &manifest_bytes)?;
    for (index, file) in files.iter().enumerate() {
        let archive_path = format!("files/{}", file.path());
        append_entry(
            &mut bytes,
            &format!("PaxHeaders/{index:08}"),
            b'x',
            0o644,
            &pax_record("path", &archive_path),
        )?;
        append_entry(
            &mut bytes,
            &format!("files/{index:08}"),
            b'0',
            if file.executable() { 0o755 } else { 0o644 },
            file.content(),
        )?;
    }
    bytes.extend_from_slice(&[0_u8; BLOCK * 2]);
    let sha256 = Sha256::digest(&bytes).into();
    Ok(EncodedGitBundle {
        bytes,
        sha256,
        logical_bytes,
        file_count: u32::try_from(files.len())
            .map_err(|_| VerificationError::InvariantViolation)?,
    })
}

pub fn decode_git_bundle(
    project_id: ProjectId,
    storage_scope_id: StorageScopeId,
    bytes: &[u8],
) -> Result<GitTreeSnapshot, VerificationError> {
    let mut offset = 0_usize;
    let manifest_header = take_block(bytes, &mut offset)?;
    if header_name(manifest_header)? != "manifest.json" {
        return Err(VerificationError::InvalidArchive);
    }
    let manifest_bytes = take_content(bytes, &mut offset, header_size(manifest_header)?)?;
    let manifest: DecodedManifest =
        serde_json::from_slice(manifest_bytes).map_err(|_| VerificationError::InvalidArchive)?;
    if manifest.format != "project-bundle-v1"
        || manifest.schema_version != 1
        || manifest.project.id != project_id.to_string()
        || manifest.project.storage_scope_id != storage_scope_id.to_string()
        || manifest.file_count != manifest.files.len()
    {
        return Err(VerificationError::InvalidArchive);
    }
    let mut files = Vec::with_capacity(manifest.file_count);
    let mut logical = 0_u64;
    for (index, expected) in manifest.files.iter().enumerate() {
        let pax = take_block(bytes, &mut offset)?;
        if header_name(pax)? != format!("PaxHeaders/{index:08}") {
            return Err(VerificationError::InvalidArchive);
        }
        let pax_content = take_content(bytes, &mut offset, header_size(pax)?)?;
        if pax_content != pax_record("path", &format!("files/{}", expected.path)) {
            return Err(VerificationError::InvalidArchive);
        }
        let header = take_block(bytes, &mut offset)?;
        if header_name(header)? != format!("files/{index:08}")
            || header_size(header)? != expected.size_bytes
        {
            return Err(VerificationError::InvalidArchive);
        }
        let content = take_content(bytes, &mut offset, expected.size_bytes)?;
        if hex(&Sha256::digest(content)) != expected.sha256
            || (expected.kind == "text" && std::str::from_utf8(content).is_err())
            || !matches!(expected.kind.as_str(), "text" | "binary")
            || !matches!(expected.mode.as_str(), "0644" | "0755")
        {
            return Err(VerificationError::InvalidArchive);
        }
        logical = logical
            .checked_add(expected.size_bytes)
            .ok_or(VerificationError::InvalidArchive)?;
        files.push(
            GitTreeFile::new(
                expected.path.clone(),
                expected.mode == "0755",
                bytes::Bytes::copy_from_slice(content),
            )
            .map_err(|_| VerificationError::InvalidArchive)?,
        );
    }
    if logical != manifest.logical_bytes
        || take_block(bytes, &mut offset)? != &[0_u8; BLOCK]
        || take_block(bytes, &mut offset)? != &[0_u8; BLOCK]
        || offset != bytes.len()
    {
        return Err(VerificationError::InvalidArchive);
    }
    GitTreeSnapshot::new(files).map_err(|_| VerificationError::InvalidArchive)
}

fn take_block<'a>(
    bytes: &'a [u8],
    offset: &mut usize,
) -> Result<&'a [u8; BLOCK], VerificationError> {
    let end = offset
        .checked_add(BLOCK)
        .ok_or(VerificationError::InvalidArchive)?;
    let block: &[u8; BLOCK] = bytes
        .get(*offset..end)
        .ok_or(VerificationError::InvalidArchive)?
        .try_into()
        .map_err(|_| VerificationError::InvalidArchive)?;
    *offset = end;
    Ok(block)
}

fn take_content<'a>(
    bytes: &'a [u8],
    offset: &mut usize,
    size: u64,
) -> Result<&'a [u8], VerificationError> {
    let size = usize::try_from(size).map_err(|_| VerificationError::InvalidArchive)?;
    let end = offset
        .checked_add(size)
        .ok_or(VerificationError::InvalidArchive)?;
    let content = bytes
        .get(*offset..end)
        .ok_or(VerificationError::InvalidArchive)?;
    let padded = end
        .checked_add((BLOCK - size % BLOCK) % BLOCK)
        .ok_or(VerificationError::InvalidArchive)?;
    if bytes
        .get(end..padded)
        .is_none_or(|padding| padding.iter().any(|byte| *byte != 0))
    {
        return Err(VerificationError::InvalidArchive);
    }
    *offset = padded;
    Ok(content)
}

fn header_name(header: &[u8; BLOCK]) -> Result<&str, VerificationError> {
    let end = header[..100]
        .iter()
        .position(|byte| *byte == 0)
        .unwrap_or(100);
    std::str::from_utf8(&header[..end]).map_err(|_| VerificationError::InvalidArchive)
}

fn header_size(header: &[u8; BLOCK]) -> Result<u64, VerificationError> {
    let field = &header[124..136];
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

fn append_entry(
    output: &mut Vec<u8>,
    name: &str,
    entry_type: u8,
    mode: u32,
    content: &[u8],
) -> Result<(), VerificationError> {
    output.extend_from_slice(&canonical_header(
        name,
        content.len() as u64,
        mode,
        entry_type,
    )?);
    output.extend_from_slice(content);
    let padding = (BLOCK - content.len() % BLOCK) % BLOCK;
    output.resize(output.len() + padding, 0);
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
    let digits = format!("{:0width$o}", value, width = field.len() - 1);
    if digits.len() != field.len() - 1 {
        return Err(VerificationError::InvalidArchive);
    }
    let last = field.len() - 1;
    field[..last].copy_from_slice(digits.as_bytes());
    *field
        .last_mut()
        .ok_or(VerificationError::InvariantViolation)? = 0;
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

#[cfg(test)]
mod tests {
    use std::io::Cursor;

    use bytes::Bytes;

    use super::*;
    use crate::git_operations::embedded::GitTreeFile;
    use crate::save::archive::verify_archive;

    #[tokio::test]
    async fn git_snapshot_encodes_as_the_canonical_verified_bundle() {
        let project = ProjectId::new();
        let scope = StorageScopeId::new();
        let snapshot = GitTreeSnapshot::new(vec![
            GitTreeFile::new("README.md", false, Bytes::from_static(b"hello\n")).unwrap(),
            GitTreeFile::new("src/main.rs", false, Bytes::from_static(b"fn main() {}\n")).unwrap(),
        ])
        .unwrap();
        let bundle = encode_git_snapshot(project, scope, &snapshot).unwrap();
        let verified = verify_archive(
            Box::pin(Cursor::new(bundle.bytes.clone())),
            bundle.bytes.len() as u64,
            &project.to_string(),
            &scope.to_string(),
            &AdmissionContract::load().unwrap(),
        )
        .await
        .unwrap();
        assert_eq!(verified.archive_sha256, bundle.sha256);
        assert_eq!(verified.logical_bytes, bundle.logical_bytes);
        assert_eq!(verified.file_count, bundle.file_count);
        let decoded = decode_git_bundle(project, scope, &bundle.bytes).unwrap();
        assert_eq!(decoded, snapshot);
    }

    #[test]
    fn ignored_and_sensitive_files_are_not_encoded() {
        let snapshot = GitTreeSnapshot::new(vec![
            GitTreeFile::new(
                ".nuriteoignore",
                false,
                Bytes::from_static(b"ignored.txt\n"),
            )
            .unwrap(),
            GitTreeFile::new(".env", false, Bytes::from_static(b"TOKEN=secret\n")).unwrap(),
            GitTreeFile::new("ignored.txt", false, Bytes::from_static(b"ignored\n")).unwrap(),
            GitTreeFile::new("kept.txt", false, Bytes::from_static(b"kept\n")).unwrap(),
        ])
        .unwrap();
        let bundle =
            encode_git_snapshot(ProjectId::new(), StorageScopeId::new(), &snapshot).unwrap();
        let text = String::from_utf8_lossy(&bundle.bytes);
        assert!(text.contains("kept.txt"));
        assert!(!text.contains("TOKEN=secret"));
        assert!(!text.contains("ignored\\n"));
    }
}
