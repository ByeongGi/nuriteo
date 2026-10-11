use std::collections::{BTreeMap, BTreeSet};
use std::fmt;
use std::io::{self, Read, Write};

use serde::{Deserialize, Serialize};
use sha2::{Digest, Sha256};

const BLOCK: usize = 512;
const MANIFEST_PATH: &str = "manifest.json";
const DATABASE_PATH: &str = "database.dump";

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub struct PortableLimits {
    pub max_manifest_bytes: u64,
    pub max_entry_bytes: u64,
    pub max_total_bytes: u64,
    pub max_entries: usize,
}

impl Default for PortableLimits {
    fn default() -> Self {
        Self {
            max_manifest_bytes: 4 * 1024 * 1024,
            max_entry_bytes: 64 * 1024 * 1024 * 1024,
            max_total_bytes: 1024 * 1024 * 1024 * 1024,
            max_entries: 1_000_000,
        }
    }
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct PortableBackupManifest {
    pub format: String,
    pub format_version: u32,
    pub backup_id: String,
    pub created_by: CreatedBy,
    pub database: DatabaseDescriptor,
    #[serde(default)]
    pub required_features: Vec<String>,
    pub entries: Vec<ManifestEntry>,
    #[serde(default)]
    pub extensions: BTreeMap<String, serde_json::Value>,
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(deny_unknown_fields)]
pub struct CreatedBy {
    pub version: String,
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct DatabaseDescriptor {
    pub schema_version: u64,
    pub archive_format: String,
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct ManifestEntry {
    pub path: String,
    pub kind: ManifestEntryKind,
    pub bytes: u64,
    pub sha256: String,
}

#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "snake_case")]
pub enum ManifestEntryKind {
    DatabaseArchive,
    Payload,
}

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum PortableFormatError {
    Io,
    InvalidHeader,
    InvalidManifest,
    UnsupportedFormat,
    UnsupportedFeature,
    UnsafePath,
    InvalidEntryType,
    DuplicateEntry,
    UndeclaredEntry,
    MissingEntry,
    InvalidOrder,
    SizeLimit,
    SizeMismatch,
    ChecksumMismatch,
    TrailingData,
}

impl fmt::Display for PortableFormatError {
    fn fmt(&self, formatter: &mut fmt::Formatter<'_>) -> fmt::Result {
        formatter.write_str(match self {
            Self::Io => "portable backup I/O failed",
            Self::InvalidHeader => "portable backup header is invalid",
            Self::InvalidManifest => "portable backup manifest is invalid",
            Self::UnsupportedFormat => "portable backup format is unsupported",
            Self::UnsupportedFeature => "portable backup requires an unsupported feature",
            Self::UnsafePath => "portable backup contains an unsafe path",
            Self::InvalidEntryType => "portable backup contains a forbidden entry type",
            Self::DuplicateEntry => "portable backup contains a duplicate entry",
            Self::UndeclaredEntry => "portable backup contains an undeclared entry",
            Self::MissingEntry => "portable backup is missing a declared entry",
            Self::InvalidOrder => "portable backup entries are not in canonical order",
            Self::SizeLimit => "portable backup exceeds a configured resource limit",
            Self::SizeMismatch => "portable backup entry size does not match its manifest",
            Self::ChecksumMismatch => "portable backup entry checksum does not match its manifest",
            Self::TrailingData => "portable backup contains trailing data",
        })
    }
}

impl std::error::Error for PortableFormatError {}

impl From<io::Error> for PortableFormatError {
    fn from(_: io::Error) -> Self {
        Self::Io
    }
}

impl PortableBackupManifest {
    pub fn validate(&self, limits: PortableLimits) -> Result<(), PortableFormatError> {
        if self.format != "nuriteo-portable"
            || self.format_version != 1
            || self.backup_id.is_empty()
            || self.created_by.version.is_empty()
            || self.database.schema_version == 0
            || self.database.archive_format != "postgres-custom"
        {
            return Err(PortableFormatError::UnsupportedFormat);
        }
        if !self.required_features.is_empty() {
            return Err(PortableFormatError::UnsupportedFeature);
        }
        if self.entries.is_empty() || self.entries.len() > limits.max_entries {
            return Err(PortableFormatError::SizeLimit);
        }
        let mut paths = BTreeSet::new();
        let mut total = 0_u64;
        for (index, entry) in self.entries.iter().enumerate() {
            validate_entry(entry)?;
            if !paths.insert(&entry.path) {
                return Err(PortableFormatError::DuplicateEntry);
            }
            if entry.bytes == 0 || entry.bytes > limits.max_entry_bytes {
                return Err(PortableFormatError::SizeLimit);
            }
            total = total
                .checked_add(entry.bytes)
                .ok_or(PortableFormatError::SizeLimit)?;
            if total > limits.max_total_bytes {
                return Err(PortableFormatError::SizeLimit);
            }
            if index == 0 && entry.path != DATABASE_PATH {
                return Err(PortableFormatError::InvalidOrder);
            }
        }
        let mut expected = self.entries.iter().map(|entry| entry.path.as_str());
        if expected.next() != Some(DATABASE_PATH)
            || !self.entries[1..]
                .windows(2)
                .all(|window| window[0].sha256 < window[1].sha256)
        {
            return Err(PortableFormatError::InvalidOrder);
        }
        Ok(())
    }
}

fn validate_entry(entry: &ManifestEntry) -> Result<(), PortableFormatError> {
    if !safe_path(&entry.path) || !valid_sha256(&entry.sha256) {
        return Err(PortableFormatError::UnsafePath);
    }
    match entry.kind {
        ManifestEntryKind::DatabaseArchive if entry.path == DATABASE_PATH => Ok(()),
        ManifestEntryKind::Payload => {
            let expected = format!("payloads/sha256/{}/{}", &entry.sha256[..2], entry.sha256);
            if entry.path == expected {
                Ok(())
            } else {
                Err(PortableFormatError::UnsafePath)
            }
        }
        ManifestEntryKind::DatabaseArchive => Err(PortableFormatError::UnsafePath),
    }
}

fn safe_path(path: &str) -> bool {
    !path.is_empty()
        && !path.starts_with('/')
        && !path.contains('\\')
        && !path.chars().any(char::is_control)
        && path
            .split('/')
            .all(|part| !part.is_empty() && !matches!(part, "." | ".."))
}

fn valid_sha256(value: &str) -> bool {
    value.len() == 64
        && value
            .bytes()
            .all(|byte| byte.is_ascii_digit() || (b'a'..=b'f').contains(&byte))
}

pub fn write_portable_v1<W, F>(
    output: &mut W,
    manifest: &PortableBackupManifest,
    limits: PortableLimits,
    mut open: F,
) -> Result<(), PortableFormatError>
where
    W: Write,
    F: FnMut(&ManifestEntry) -> io::Result<Box<dyn Read>>,
{
    manifest.validate(limits)?;
    let manifest_bytes =
        serde_json::to_vec(manifest).map_err(|_| PortableFormatError::InvalidManifest)?;
    if manifest_bytes.len() as u64 > limits.max_manifest_bytes {
        return Err(PortableFormatError::SizeLimit);
    }
    write_tar_entry(
        output,
        MANIFEST_PATH,
        &manifest_bytes[..],
        manifest_bytes.len() as u64,
    )?;
    for entry in &manifest.entries {
        let reader = open(entry)?;
        write_checked_entry(output, entry, reader)?;
    }
    output.write_all(&[0_u8; BLOCK * 2])?;
    Ok(())
}

fn write_checked_entry<W: Write>(
    output: &mut W,
    entry: &ManifestEntry,
    mut input: Box<dyn Read>,
) -> Result<(), PortableFormatError> {
    write_header(output, &entry.path, entry.bytes)?;
    let mut remaining = entry.bytes;
    let mut digest = Sha256::new();
    let mut buffer = [0_u8; 64 * 1024];
    while remaining != 0 {
        let amount = usize::try_from(remaining.min(buffer.len() as u64))
            .map_err(|_| PortableFormatError::SizeLimit)?;
        let read = input.read(&mut buffer[..amount])?;
        if read == 0 {
            return Err(PortableFormatError::SizeMismatch);
        }
        output.write_all(&buffer[..read])?;
        digest.update(&buffer[..read]);
        remaining -= read as u64;
    }
    let mut extra = [0_u8; 1];
    if input.read(&mut extra)? != 0 {
        return Err(PortableFormatError::SizeMismatch);
    }
    if hex_digest(digest.finalize().as_slice()) != entry.sha256 {
        return Err(PortableFormatError::ChecksumMismatch);
    }
    write_padding(output, entry.bytes)?;
    Ok(())
}

fn write_tar_entry<W: Write, R: Read>(
    output: &mut W,
    path: &str,
    mut input: R,
    bytes: u64,
) -> Result<(), PortableFormatError> {
    write_header(output, path, bytes)?;
    let copied = io::copy(&mut input.by_ref().take(bytes), output)?;
    if copied != bytes {
        return Err(PortableFormatError::SizeMismatch);
    }
    let mut extra = [0_u8; 1];
    if input.read(&mut extra)? != 0 {
        return Err(PortableFormatError::SizeMismatch);
    }
    write_padding(output, bytes)?;
    Ok(())
}

fn write_header<W: Write>(
    output: &mut W,
    path: &str,
    bytes: u64,
) -> Result<(), PortableFormatError> {
    if path.len() > 100 || !safe_path(path) {
        return Err(PortableFormatError::UnsafePath);
    }
    let mut header = [0_u8; BLOCK];
    header[..path.len()].copy_from_slice(path.as_bytes());
    write_octal(&mut header[100..108], 0o600)?;
    write_octal(&mut header[108..116], 0)?;
    write_octal(&mut header[116..124], 0)?;
    write_octal(&mut header[124..136], bytes)?;
    write_octal(&mut header[136..148], 0)?;
    header[148..156].fill(b' ');
    header[156] = b'0';
    header[257..263].copy_from_slice(b"ustar\0");
    header[263..265].copy_from_slice(b"00");
    let checksum: u64 = header.iter().map(|byte| u64::from(*byte)).sum();
    write_octal(&mut header[148..156], checksum)?;
    output.write_all(&header)?;
    Ok(())
}

fn write_octal(field: &mut [u8], value: u64) -> Result<(), PortableFormatError> {
    let text = format!("{:0width$o}\0", value, width = field.len() - 1);
    if text.len() != field.len() {
        return Err(PortableFormatError::SizeLimit);
    }
    field.copy_from_slice(text.as_bytes());
    Ok(())
}

fn write_padding<W: Write>(output: &mut W, bytes: u64) -> Result<(), PortableFormatError> {
    let padding = (BLOCK as u64 - bytes % BLOCK as u64) % BLOCK as u64;
    output.write_all(&[0_u8; BLOCK][..padding as usize])?;
    Ok(())
}

pub fn read_portable_v1<R, F>(
    input: &mut R,
    limits: PortableLimits,
    mut consume: F,
) -> Result<PortableBackupManifest, PortableFormatError>
where
    R: Read,
    F: FnMut(&ManifestEntry, &mut dyn Read) -> io::Result<()>,
{
    let (manifest_path, manifest_size, kind) =
        read_header(input)?.ok_or(PortableFormatError::MissingEntry)?;
    if manifest_path != MANIFEST_PATH || kind != b'0' || manifest_size > limits.max_manifest_bytes {
        return Err(PortableFormatError::InvalidManifest);
    }
    let manifest_len =
        usize::try_from(manifest_size).map_err(|_| PortableFormatError::SizeLimit)?;
    let mut manifest_bytes = vec![0_u8; manifest_len];
    input.read_exact(&mut manifest_bytes)?;
    read_padding(input, manifest_size)?;
    let manifest: PortableBackupManifest = serde_json::from_slice(&manifest_bytes)
        .map_err(|_| PortableFormatError::InvalidManifest)?;
    manifest.validate(limits)?;

    let mut seen = BTreeSet::new();
    for expected in &manifest.entries {
        let (path, bytes, entry_type) =
            read_header(input)?.ok_or(PortableFormatError::MissingEntry)?;
        if entry_type != b'0' {
            return Err(PortableFormatError::InvalidEntryType);
        }
        if seen.contains(&path) {
            return Err(PortableFormatError::DuplicateEntry);
        }
        if path != expected.path {
            return if manifest.entries.iter().any(|entry| entry.path == path) {
                Err(PortableFormatError::InvalidOrder)
            } else {
                Err(PortableFormatError::UndeclaredEntry)
            };
        }
        seen.insert(path);
        if bytes != expected.bytes {
            return Err(PortableFormatError::SizeMismatch);
        }
        let mut bounded = input.take(bytes);
        let mut checking = DigestReader::new(&mut bounded);
        consume(expected, &mut checking)?;
        io::copy(&mut checking, &mut io::sink())?;
        let actual_digest = checking.finish();
        if bounded.limit() != 0 {
            return Err(PortableFormatError::SizeMismatch);
        }
        if actual_digest != expected.sha256 {
            return Err(PortableFormatError::ChecksumMismatch);
        }
        read_padding(input, bytes)?;
    }

    let next = read_header(input)?;
    if next.is_some() {
        return Err(PortableFormatError::UndeclaredEntry);
    }
    let mut trailing = [0_u8; 8192];
    loop {
        let read = input.read(&mut trailing)?;
        if read == 0 {
            break;
        }
        if trailing[..read].iter().any(|byte| *byte != 0) {
            return Err(PortableFormatError::TrailingData);
        }
    }
    Ok(manifest)
}

struct DigestReader<R> {
    inner: R,
    digest: Sha256,
}

impl<R> DigestReader<R> {
    fn new(inner: R) -> Self {
        Self {
            inner,
            digest: Sha256::new(),
        }
    }

    fn finish(self) -> String {
        hex_digest(self.digest.finalize().as_slice())
    }
}

fn hex_digest(bytes: &[u8]) -> String {
    const HEX: &[u8; 16] = b"0123456789abcdef";
    let mut output = String::with_capacity(bytes.len() * 2);
    for byte in bytes {
        output.push(char::from(HEX[usize::from(byte >> 4)]));
        output.push(char::from(HEX[usize::from(byte & 0x0f)]));
    }
    output
}

impl<R: Read> Read for DigestReader<R> {
    fn read(&mut self, buffer: &mut [u8]) -> io::Result<usize> {
        let read = self.inner.read(buffer)?;
        self.digest.update(&buffer[..read]);
        Ok(read)
    }
}

fn read_header<R: Read>(input: &mut R) -> Result<Option<(String, u64, u8)>, PortableFormatError> {
    let mut header = [0_u8; BLOCK];
    input.read_exact(&mut header)?;
    if header.iter().all(|byte| *byte == 0) {
        let mut second = [0_u8; BLOCK];
        input.read_exact(&mut second)?;
        if second.iter().any(|byte| *byte != 0) {
            return Err(PortableFormatError::InvalidHeader);
        }
        return Ok(None);
    }
    if &header[257..263] != b"ustar\0" || header[156] != b'0' {
        return Err(PortableFormatError::InvalidEntryType);
    }
    let recorded = parse_octal(&header[148..156])?;
    let mut checksum_header = header;
    checksum_header[148..156].fill(b' ');
    let actual: u64 = checksum_header.iter().map(|byte| u64::from(*byte)).sum();
    if recorded != actual {
        return Err(PortableFormatError::InvalidHeader);
    }
    let path_end = header[..100]
        .iter()
        .position(|byte| *byte == 0)
        .unwrap_or(100);
    let path = std::str::from_utf8(&header[..path_end])
        .map_err(|_| PortableFormatError::UnsafePath)?
        .to_owned();
    if !safe_path(&path) {
        return Err(PortableFormatError::UnsafePath);
    }
    Ok(Some((path, parse_octal(&header[124..136])?, header[156])))
}

fn parse_octal(field: &[u8]) -> Result<u64, PortableFormatError> {
    let end = field
        .iter()
        .position(|byte| *byte == 0 || *byte == b' ')
        .unwrap_or(field.len());
    let text =
        std::str::from_utf8(&field[..end]).map_err(|_| PortableFormatError::InvalidHeader)?;
    if text.is_empty() || !text.bytes().all(|byte| (b'0'..=b'7').contains(&byte)) {
        return Err(PortableFormatError::InvalidHeader);
    }
    u64::from_str_radix(text, 8).map_err(|_| PortableFormatError::InvalidHeader)
}

fn read_padding<R: Read>(input: &mut R, bytes: u64) -> Result<(), PortableFormatError> {
    let padding = (BLOCK as u64 - bytes % BLOCK as u64) % BLOCK as u64;
    let mut buffer = [0_u8; BLOCK];
    input.read_exact(&mut buffer[..padding as usize])?;
    if buffer[..padding as usize].iter().any(|byte| *byte != 0) {
        return Err(PortableFormatError::InvalidHeader);
    }
    Ok(())
}
