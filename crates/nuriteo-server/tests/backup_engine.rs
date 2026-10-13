use std::collections::{BTreeMap, BTreeSet};
use std::fs::{self, File};
use std::io::{Cursor, Read};
use std::process::{Command, Stdio};

use nuriteo_server::backup::{
    BackupEngine, BackupEngineError, CreatedBy, DatabaseDescriptor, DirectoryBackupRepository,
    ManifestEntry, ManifestEntryKind, PortableBackupManifest, PortableFormatError, PortableLimits,
    PrunePolicy, RestoreTarget, write_portable_v1,
};
use sha2::{Digest, Sha256};

fn digest(bytes: &[u8]) -> String {
    let value = Sha256::digest(bytes);
    value.iter().map(|byte| format!("{byte:02x}")).collect()
}

fn fixture() -> (PortableBackupManifest, BTreeMap<String, Vec<u8>>) {
    let database = b"PGDMP fixed database".to_vec();
    let payload = b"immutable bundle payload".to_vec();
    let database_digest = digest(&database);
    let payload_digest = digest(&payload);
    let payload_path = format!(
        "payloads/sha256/{}/{}",
        &payload_digest[..2],
        payload_digest
    );
    let entries = vec![
        ManifestEntry {
            path: "database.dump".into(),
            kind: ManifestEntryKind::DatabaseArchive,
            bytes: database.len() as u64,
            sha256: database_digest,
        },
        ManifestEntry {
            path: payload_path.clone(),
            kind: ManifestEntryKind::Payload,
            bytes: payload.len() as u64,
            sha256: payload_digest,
        },
    ];
    let manifest = PortableBackupManifest {
        format: "nuriteo-portable".into(),
        format_version: 1,
        backup_id: "0199ee6c-c777-7000-8000-000000024001".into(),
        created_by: CreatedBy {
            version: env!("CARGO_PKG_VERSION").into(),
        },
        database: DatabaseDescriptor {
            schema_version: 48,
            archive_format: "postgres-custom".into(),
        },
        required_features: Vec::new(),
        entries,
        extensions: BTreeMap::from([("fixture.note".into(), serde_json::json!("optional"))]),
    };
    let files = BTreeMap::from([("database.dump".into(), database), (payload_path, payload)]);
    (manifest, files)
}

fn stream() -> Vec<u8> {
    let (manifest, files) = fixture();
    let mut stream = Vec::new();
    write_portable_v1(&mut stream, &manifest, PortableLimits::default(), |entry| {
        Ok(Box::new(Cursor::new(files[&entry.path].clone())))
    })
    .unwrap();
    stream
}

fn tar_size(header: &[u8]) -> usize {
    let field = &header[124..136];
    let end = field
        .iter()
        .position(|byte| *byte == 0 || *byte == b' ')
        .unwrap_or(field.len());
    usize::from_str_radix(std::str::from_utf8(&field[..end]).unwrap(), 8).unwrap()
}

fn entry_offsets(archive: &[u8]) -> Vec<usize> {
    let mut offsets = Vec::new();
    let mut offset = 0;
    loop {
        if archive[offset..offset + 512].iter().all(|byte| *byte == 0) {
            return offsets;
        }
        offsets.push(offset);
        let size = tar_size(&archive[offset..offset + 512]);
        offset += 512 + size.div_ceil(512) * 512;
    }
}

fn rewrite_header(archive: &mut [u8], offset: usize, path: Option<&str>, kind: Option<u8>) {
    let header = &mut archive[offset..offset + 512];
    if let Some(path) = path {
        assert!(path.len() <= 100);
        header[..100].fill(0);
        header[..path.len()].copy_from_slice(path.as_bytes());
    }
    if let Some(kind) = kind {
        header[156] = kind;
    }
    header[148..156].fill(b' ');
    let checksum: u64 = header.iter().map(|byte| u64::from(*byte)).sum();
    let encoded = format!("{checksum:07o}\0");
    header[148..156].copy_from_slice(encoded.as_bytes());
}

fn replace_manifest(archive: &mut [u8], manifest: &PortableBackupManifest) {
    let size = tar_size(&archive[..512]);
    let mut encoded = serde_json::to_vec(manifest).unwrap();
    assert!(encoded.len() <= size);
    encoded.resize(size, b' ');
    archive[512..512 + size].copy_from_slice(&encoded);
}

fn import_error(archive: Vec<u8>) -> BackupEngineError {
    let temp = tempfile::tempdir().unwrap();
    let engine = BackupEngine::new(
        DirectoryBackupRepository::open(temp.path()).unwrap(),
        PortableLimits::default(),
    );
    engine.import(&mut Cursor::new(archive)).unwrap_err()
}

#[test]
fn portable_stream_import_verify_export_and_external_tar_listing() {
    let temp = tempfile::tempdir().unwrap();
    let repository = DirectoryBackupRepository::open(temp.path()).unwrap();
    let engine = BackupEngine::new(repository, PortableLimits::default());
    let mut source = Cursor::new(stream());

    let imported = engine.import(&mut source).unwrap();
    assert_eq!(engine.verify(&imported.backup_id).unwrap(), imported);
    let mut exported = Vec::new();
    engine.export(&imported.backup_id, &mut exported).unwrap();

    let mut child = Command::new("tar")
        .args(["-tf", "-"])
        .stdin(Stdio::piped())
        .stdout(Stdio::piped())
        .spawn()
        .expect("POSIX tar is part of the fixture environment");
    std::io::Write::write_all(child.stdin.as_mut().unwrap(), &exported).unwrap();
    let output = child.wait_with_output().unwrap();
    assert!(output.status.success());
    let listing = String::from_utf8(output.stdout).unwrap();
    assert!(listing.lines().next() == Some("manifest.json"));
    assert!(listing.contains("database.dump"));
    assert!(listing.contains("payloads/sha256/"));
}

#[test]
fn checked_in_public_manifests_match_the_production_contract() {
    for source in [
        include_str!("../../../fixtures/backup/portable-v1/valid-minimal.manifest.json"),
        include_str!("../../../fixtures/backup/portable-v1/valid-optional-extension.manifest.json"),
    ] {
        let manifest: PortableBackupManifest = serde_json::from_str(source).unwrap();
        manifest.validate(PortableLimits::default()).unwrap();
    }
    let cases: serde_json::Value = serde_json::from_str(include_str!(
        "../../../fixtures/backup/portable-v1/cases.json"
    ))
    .unwrap();
    assert_eq!(cases["schemaVersion"], 1);
    assert_eq!(cases["generatedArchiveCases"].as_array().unwrap().len(), 12);
}

#[test]
fn interrupted_corrupt_and_missing_object_fail_closed() {
    let temp = tempfile::tempdir().unwrap();
    let repository = DirectoryBackupRepository::open(temp.path()).unwrap();
    let engine = BackupEngine::new(repository, PortableLimits::default());
    let valid = stream();

    let mut interrupted = Cursor::new(&valid[..valid.len() - 700]);
    assert!(engine.import(&mut interrupted).is_err());
    assert!(engine.list().unwrap().is_empty());

    let mut corrupt = valid.clone();
    let offset = corrupt
        .windows(b"PGDMP fixed database".len())
        .position(|window| window == b"PGDMP fixed database")
        .unwrap();
    corrupt[offset] ^= 0x20;
    let mut corrupt = Cursor::new(corrupt);
    assert!(matches!(
        engine.import(&mut corrupt),
        Err(BackupEngineError::Portable(
            PortableFormatError::ChecksumMismatch
        ))
    ));
    assert!(engine.list().unwrap().is_empty());

    let mut valid = Cursor::new(valid);
    let imported = engine.import(&mut valid).unwrap();
    let (manifest, _) = fixture();
    fs::remove_file(
        temp.path()
            .join(&imported.backup_id)
            .join(&manifest.entries[1].path),
    )
    .unwrap();
    assert!(matches!(
        engine.verify(&imported.backup_id),
        Err(BackupEngineError::Portable(
            PortableFormatError::MissingEntry
        ))
    ));
}

#[test]
fn portable_import_rejects_adversarial_archive_matrix() {
    for path in ["../escape.dump", "/absolute.dump"] {
        let mut archive = stream();
        let database = entry_offsets(&archive)[1];
        rewrite_header(&mut archive, database, Some(path), None);
        assert_eq!(
            import_error(archive),
            BackupEngineError::Portable(PortableFormatError::UnsafePath)
        );
    }

    for kind in *b"12346" {
        let mut archive = stream();
        let database = entry_offsets(&archive)[1];
        rewrite_header(&mut archive, database, None, Some(kind));
        assert_eq!(
            import_error(archive),
            BackupEngineError::Portable(PortableFormatError::InvalidEntryType)
        );
    }

    let mut undeclared = stream();
    let database = entry_offsets(&undeclared)[1];
    rewrite_header(&mut undeclared, database, Some("other.dump"), None);
    assert_eq!(
        import_error(undeclared),
        BackupEngineError::Portable(PortableFormatError::UndeclaredEntry)
    );

    let mut duplicate = stream();
    let payload = entry_offsets(&duplicate)[2];
    rewrite_header(&mut duplicate, payload, Some("database.dump"), None);
    assert_eq!(
        import_error(duplicate),
        BackupEngineError::Portable(PortableFormatError::DuplicateEntry)
    );

    let mut unsupported = stream();
    let (mut manifest, _) = fixture();
    manifest.required_features = vec!["restore-transform-v1".into()];
    manifest.extensions.clear();
    replace_manifest(&mut unsupported, &manifest);
    assert_eq!(
        import_error(unsupported),
        BackupEngineError::Portable(PortableFormatError::UnsupportedFeature)
    );

    let mut size_mismatch = stream();
    let database = entry_offsets(&size_mismatch)[1];
    let header = &mut size_mismatch[database..database + 512];
    header[124..136].copy_from_slice(b"00000000025\0");
    rewrite_header(&mut size_mismatch, database, None, None);
    assert_eq!(
        import_error(size_mismatch),
        BackupEngineError::Portable(PortableFormatError::SizeMismatch)
    );

    let mut trailing = stream();
    trailing.extend_from_slice(b"not-allowed");
    assert_eq!(
        import_error(trailing),
        BackupEngineError::Portable(PortableFormatError::TrailingData)
    );
}

#[derive(Default)]
struct FakeRestoreTarget {
    empty: bool,
    fail_after_entries: Option<usize>,
    entries: usize,
    cutover: bool,
    aborted: bool,
}

impl RestoreTarget for FakeRestoreTarget {
    fn require_empty(&mut self) -> Result<(), BackupEngineError> {
        if self.empty {
            Ok(())
        } else {
            Err(BackupEngineError::TargetNotEmpty)
        }
    }

    fn begin_staging(&mut self, _: &PortableBackupManifest) -> Result<(), BackupEngineError> {
        Ok(())
    }

    fn stage_entry(
        &mut self,
        _: &ManifestEntry,
        source: &mut dyn Read,
    ) -> Result<(), BackupEngineError> {
        if self.fail_after_entries == Some(self.entries) {
            return Err(BackupEngineError::RestoreInterrupted);
        }
        std::io::copy(source, &mut std::io::sink()).map_err(|_| BackupEngineError::Io)?;
        self.entries += 1;
        Ok(())
    }

    fn validate_staging(&mut self, _: &PortableBackupManifest) -> Result<(), BackupEngineError> {
        Ok(())
    }

    fn cutover(&mut self) -> Result<(), BackupEngineError> {
        self.cutover = true;
        Ok(())
    }

    fn abort_staging(&mut self) {
        self.aborted = true;
    }
}

#[test]
fn restore_requires_empty_target_and_never_cuts_over_interrupted_staging() {
    let temp = tempfile::tempdir().unwrap();
    let engine = BackupEngine::new(
        DirectoryBackupRepository::open(temp.path()).unwrap(),
        PortableLimits::default(),
    );
    let mut source = Cursor::new(stream());
    let backup_id = engine.import(&mut source).unwrap().backup_id;

    let mut nonempty = FakeRestoreTarget::default();
    assert_eq!(
        engine.restore(&backup_id, &mut nonempty),
        Err(BackupEngineError::TargetNotEmpty)
    );
    assert!(!nonempty.cutover);

    let mut interrupted = FakeRestoreTarget {
        empty: true,
        fail_after_entries: Some(1),
        ..FakeRestoreTarget::default()
    };
    assert_eq!(
        engine.restore(&backup_id, &mut interrupted),
        Err(BackupEngineError::RestoreInterrupted)
    );
    assert!(interrupted.aborted);
    assert!(!interrupted.cutover);
}

#[test]
fn prune_enforces_policy_and_external_hold_marker() {
    let temp = tempfile::tempdir().unwrap();
    let engine = BackupEngine::new(
        DirectoryBackupRepository::open(temp.path()).unwrap(),
        PortableLimits::default(),
    );
    let mut source = Cursor::new(stream());
    let backup_id = engine.import(&mut source).unwrap().backup_id;
    File::create(temp.path().join(&backup_id).join(".hold")).unwrap();

    assert!(engine.prune(&PrunePolicy::default()).unwrap().is_empty());
    assert!(temp.path().join(&backup_id).exists());

    fs::remove_file(temp.path().join(&backup_id).join(".hold")).unwrap();
    let policy = PrunePolicy {
        protected_backup_ids: BTreeSet::from([backup_id.clone()]),
        max_deletions: 100,
    };
    assert!(engine.prune(&policy).unwrap().is_empty());
    assert!(temp.path().join(&backup_id).exists());
}
