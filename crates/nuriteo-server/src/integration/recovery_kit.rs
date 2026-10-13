//! Passphrase-encrypted, portable recovery of the application master-key ring.

use std::fmt;
use std::io::{Read, Write};
use std::iter;

use age::secrecy::SecretString;
use base64::Engine;
use base64::engine::general_purpose::URL_SAFE_NO_PAD;
use serde::{Deserialize, Serialize};
use sha2::{Digest, Sha256};
use time::OffsetDateTime;
use time::format_description::well_known::Rfc3339;
use uuid::Uuid;
use zeroize::{Zeroize, Zeroizing};

use super::{ALGORITHM, MasterKey, MasterKeyring};

pub const DEFAULT_FILENAME: &str = "nuriteo-recovery-kit-v1.age";
pub const FORMAT_VERSION: u16 = 1;
const FORMAT: &str = "nuriteo-recovery-kit";
const MAX_ARTIFACT_BYTES: usize = 1024 * 1024;
const MAX_PLAINTEXT_BYTES: u64 = 256 * 1024;
const MAX_PASSPHRASE_BYTES: usize = 4096;
const MIN_PASSPHRASE_CHARS: usize = 15;
const MAX_KEY_COUNT: usize = 4;
const MAX_SCRYPT_LOG_N: u8 = 20;

#[derive(Clone, PartialEq, Eq)]
pub struct RecoveryKitPassphrase(Zeroizing<String>);

impl RecoveryKitPassphrase {
    pub fn new(value: String) -> Result<Self, RecoveryKitError> {
        if value.chars().count() < MIN_PASSPHRASE_CHARS || value.len() > MAX_PASSPHRASE_BYTES {
            return Err(RecoveryKitError::InvalidPassphrase);
        }
        Ok(Self(Zeroizing::new(value)))
    }

    fn age_secret(&self) -> SecretString {
        SecretString::from(self.0.to_string())
    }
}

impl fmt::Debug for RecoveryKitPassphrase {
    fn fmt(&self, formatter: &mut fmt::Formatter<'_>) -> fmt::Result {
        formatter.write_str("RecoveryKitPassphrase([REDACTED])")
    }
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize)]
pub struct RecoveryKitKeyMetadata {
    pub version: u32,
    pub algorithm: String,
    pub fingerprint_sha256: String,
    pub current: bool,
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize)]
pub struct RecoveryKitMetadata {
    pub artifact_sha256: String,
    pub format_version: u16,
    pub kit_id: Uuid,
    pub instance_id: String,
    pub created_at: String,
    pub nuriteo_release: String,
    pub master_keys: Vec<RecoveryKitKeyMetadata>,
}

pub struct VerifiedRecoveryKit {
    pub metadata: RecoveryKitMetadata,
    pub keyring: MasterKeyring,
}

impl fmt::Debug for VerifiedRecoveryKit {
    fn fmt(&self, formatter: &mut fmt::Formatter<'_>) -> fmt::Result {
        formatter
            .debug_struct("VerifiedRecoveryKit")
            .field("metadata", &self.metadata)
            .field("keyring", &self.keyring)
            .finish()
    }
}

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum RecoveryKitError {
    InvalidPassphrase,
    InvalidInstance,
    Encryption,
    Decryption,
    UnsupportedFormat,
    InvalidPayload,
    IncompatibleInstance,
    IncompatibleKeyring,
}

impl fmt::Display for RecoveryKitError {
    fn fmt(&self, formatter: &mut fmt::Formatter<'_>) -> fmt::Result {
        formatter.write_str(match self {
            Self::InvalidPassphrase => "recovery kit passphrase is invalid",
            Self::InvalidInstance => "recovery kit instance identifier is invalid",
            Self::Encryption => "recovery kit encryption failed",
            Self::Decryption => "recovery kit decryption failed",
            Self::UnsupportedFormat => "recovery kit format is unsupported",
            Self::InvalidPayload => "recovery kit payload is invalid",
            Self::IncompatibleInstance => "recovery kit belongs to another instance",
            Self::IncompatibleKeyring => "recovery kit master keys do not match",
        })
    }
}

impl std::error::Error for RecoveryKitError {}

#[derive(Serialize, Deserialize)]
#[serde(deny_unknown_fields)]
struct PayloadV1 {
    format: String,
    format_version: u16,
    kit_id: Uuid,
    instance_id: String,
    created_at: String,
    nuriteo_release: String,
    current_master_key_version: u32,
    master_keys: Vec<StoredMasterKey>,
    key_fingerprints: Vec<KeyFingerprint>,
}

#[derive(Serialize, Deserialize)]
#[serde(deny_unknown_fields)]
struct StoredMasterKey {
    version: u32,
    algorithm: String,
    key: String,
}

impl Drop for StoredMasterKey {
    fn drop(&mut self) {
        self.key.zeroize();
    }
}

#[derive(Debug, Serialize, Deserialize, PartialEq, Eq)]
#[serde(deny_unknown_fields)]
struct KeyFingerprint {
    version: u32,
    sha256: String,
}

pub fn export(
    keyring: &MasterKeyring,
    instance_id: &str,
    created_at: OffsetDateTime,
    passphrase: &RecoveryKitPassphrase,
) -> Result<(Vec<u8>, RecoveryKitMetadata), RecoveryKitError> {
    validate_instance_id(instance_id)?;
    if keyring.keys.is_empty() || keyring.keys.len() > MAX_KEY_COUNT {
        return Err(RecoveryKitError::InvalidPayload);
    }
    let created_at = created_at
        .format(&Rfc3339)
        .map_err(|_| RecoveryKitError::InvalidPayload)?;
    let kit_id = Uuid::now_v7();
    let master_keys = keyring
        .keys
        .iter()
        .map(|(version, key)| StoredMasterKey {
            version: *version,
            algorithm: ALGORITHM.to_owned(),
            key: URL_SAFE_NO_PAD.encode(key.0.as_slice()),
        })
        .collect::<Vec<_>>();
    let key_fingerprints = keyring
        .keys
        .iter()
        .map(|(version, key)| KeyFingerprint {
            version: *version,
            sha256: key_fingerprint(*version, key),
        })
        .collect::<Vec<_>>();
    let payload = PayloadV1 {
        format: FORMAT.to_owned(),
        format_version: FORMAT_VERSION,
        kit_id,
        instance_id: instance_id.to_owned(),
        created_at,
        nuriteo_release: crate::VERSION.to_owned(),
        current_master_key_version: keyring.current_version,
        master_keys,
        key_fingerprints,
    };
    let plaintext =
        Zeroizing::new(serde_json::to_vec(&payload).map_err(|_| RecoveryKitError::InvalidPayload)?);
    if plaintext.len() as u64 > MAX_PLAINTEXT_BYTES {
        return Err(RecoveryKitError::InvalidPayload);
    }

    let encryptor = age::Encryptor::with_user_passphrase(passphrase.age_secret());
    let mut artifact = Vec::new();
    let mut writer = encryptor
        .wrap_output(&mut artifact)
        .map_err(|_| RecoveryKitError::Encryption)?;
    writer
        .write_all(&plaintext)
        .map_err(|_| RecoveryKitError::Encryption)?;
    writer.finish().map_err(|_| RecoveryKitError::Encryption)?;
    if artifact.len() > MAX_ARTIFACT_BYTES {
        return Err(RecoveryKitError::Encryption);
    }
    let metadata = metadata(&payload, &artifact)?;
    Ok((artifact, metadata))
}

pub fn inspect(
    artifact: &[u8],
    passphrase: &RecoveryKitPassphrase,
) -> Result<RecoveryKitMetadata, RecoveryKitError> {
    let payload = decrypt_and_validate(artifact, passphrase)?;
    metadata(&payload, artifact)
}

pub fn verify(
    artifact: &[u8],
    passphrase: &RecoveryKitPassphrase,
    expected_instance_id: &str,
    expected_keyring: Option<&MasterKeyring>,
) -> Result<RecoveryKitMetadata, RecoveryKitError> {
    validate_instance_id(expected_instance_id)?;
    let payload = decrypt_and_validate(artifact, passphrase)?;
    if payload.instance_id != expected_instance_id {
        return Err(RecoveryKitError::IncompatibleInstance);
    }
    let restored = payload_keyring(&payload)?;
    if let Some(expected) = expected_keyring
        && (restored.current_version != expected.current_version
            || restored.keys.len() != expected.keys.len()
            || restored.keys.iter().any(|(version, key)| {
                expected
                    .keys
                    .get(version)
                    .is_none_or(|expected_key| expected_key.0 != key.0)
            }))
    {
        return Err(RecoveryKitError::IncompatibleKeyring);
    }
    metadata(&payload, artifact)
}

pub fn restore(
    artifact: &[u8],
    passphrase: &RecoveryKitPassphrase,
    expected_instance_id: &str,
) -> Result<VerifiedRecoveryKit, RecoveryKitError> {
    validate_instance_id(expected_instance_id)?;
    let payload = decrypt_and_validate(artifact, passphrase)?;
    if payload.instance_id != expected_instance_id {
        return Err(RecoveryKitError::IncompatibleInstance);
    }
    let keyring = payload_keyring(&payload)?;
    let metadata = metadata(&payload, artifact)?;
    Ok(VerifiedRecoveryKit { metadata, keyring })
}

impl VerifiedRecoveryKit {
    #[must_use]
    pub const fn current_version(&self) -> u32 {
        self.keyring.current_version
    }

    pub fn current_key_base64(&self) -> Result<Zeroizing<String>, RecoveryKitError> {
        let key = self
            .keyring
            .keys
            .get(&self.keyring.current_version)
            .ok_or(RecoveryKitError::InvalidPayload)?;
        Ok(Zeroizing::new(URL_SAFE_NO_PAD.encode(key.0.as_slice())))
    }

    pub fn previous_keys_json(&self) -> Result<Zeroizing<Vec<u8>>, RecoveryKitError> {
        #[derive(Serialize)]
        struct Previous<'a> {
            version: u32,
            key: &'a str,
        }

        let encoded = self
            .keyring
            .keys
            .iter()
            .filter(|(version, _)| **version != self.keyring.current_version)
            .map(|(version, key)| (*version, URL_SAFE_NO_PAD.encode(key.0.as_slice())))
            .collect::<Vec<_>>();
        let values = encoded
            .iter()
            .map(|(version, key)| Previous {
                version: *version,
                key,
            })
            .collect::<Vec<_>>();
        Ok(Zeroizing::new(
            serde_json::to_vec(&values).map_err(|_| RecoveryKitError::InvalidPayload)?,
        ))
    }
}

fn decrypt_and_validate(
    artifact: &[u8],
    passphrase: &RecoveryKitPassphrase,
) -> Result<PayloadV1, RecoveryKitError> {
    if artifact.is_empty() || artifact.len() > MAX_ARTIFACT_BYTES {
        return Err(RecoveryKitError::Decryption);
    }
    let decryptor =
        age::Decryptor::new_buffered(artifact).map_err(|_| RecoveryKitError::Decryption)?;
    let mut identity = age::scrypt::Identity::new(passphrase.age_secret());
    identity.set_max_work_factor(MAX_SCRYPT_LOG_N);
    let mut reader = decryptor
        .decrypt(iter::once(&identity as &dyn age::Identity))
        .map_err(|_| RecoveryKitError::Decryption)?;
    let mut plaintext = Zeroizing::new(Vec::new());
    reader
        .by_ref()
        .take(MAX_PLAINTEXT_BYTES + 1)
        .read_to_end(&mut plaintext)
        .map_err(|_| RecoveryKitError::Decryption)?;
    if plaintext.is_empty() || plaintext.len() as u64 > MAX_PLAINTEXT_BYTES {
        return Err(RecoveryKitError::InvalidPayload);
    }
    let payload: PayloadV1 =
        serde_json::from_slice(&plaintext).map_err(|_| RecoveryKitError::InvalidPayload)?;
    validate_payload(&payload)?;
    Ok(payload)
}

fn validate_payload(payload: &PayloadV1) -> Result<(), RecoveryKitError> {
    if payload.format != FORMAT || payload.format_version != FORMAT_VERSION {
        return Err(RecoveryKitError::UnsupportedFormat);
    }
    validate_instance_id(&payload.instance_id)?;
    OffsetDateTime::parse(&payload.created_at, &Rfc3339)
        .map_err(|_| RecoveryKitError::InvalidPayload)?;
    if payload.nuriteo_release.is_empty()
        || payload.nuriteo_release.len() > 128
        || payload.master_keys.is_empty()
        || payload.master_keys.len() > MAX_KEY_COUNT
        || payload.master_keys.len() != payload.key_fingerprints.len()
    {
        return Err(RecoveryKitError::InvalidPayload);
    }
    let keyring = payload_keyring(payload)?;
    for (version, key) in &keyring.keys {
        let expected = key_fingerprint(*version, key);
        let fingerprint = payload
            .key_fingerprints
            .iter()
            .find(|value| value.version == *version)
            .ok_or(RecoveryKitError::InvalidPayload)?;
        if fingerprint.sha256 != expected {
            return Err(RecoveryKitError::InvalidPayload);
        }
    }
    Ok(())
}

fn payload_keyring(payload: &PayloadV1) -> Result<MasterKeyring, RecoveryKitError> {
    let mut keys = std::collections::BTreeMap::new();
    for stored in &payload.master_keys {
        if stored.version == 0
            || stored.algorithm != ALGORITHM
            || keys.contains_key(&stored.version)
        {
            return Err(RecoveryKitError::InvalidPayload);
        }
        let decoded = Zeroizing::new(
            URL_SAFE_NO_PAD
                .decode(&stored.key)
                .map_err(|_| RecoveryKitError::InvalidPayload)?,
        );
        let bytes: [u8; 32] = decoded
            .as_slice()
            .try_into()
            .map_err(|_| RecoveryKitError::InvalidPayload)?;
        if keys
            .values()
            .any(|existing: &MasterKey| existing.0.as_slice() == bytes)
        {
            return Err(RecoveryKitError::InvalidPayload);
        }
        keys.insert(stored.version, MasterKey(Zeroizing::new(bytes)));
    }
    if !keys.contains_key(&payload.current_master_key_version)
        || keys
            .keys()
            .any(|version| *version > payload.current_master_key_version)
    {
        return Err(RecoveryKitError::InvalidPayload);
    }
    Ok(MasterKeyring {
        current_version: payload.current_master_key_version,
        keys,
    })
}

fn metadata(payload: &PayloadV1, artifact: &[u8]) -> Result<RecoveryKitMetadata, RecoveryKitError> {
    let current = payload.current_master_key_version;
    let mut master_keys = payload
        .key_fingerprints
        .iter()
        .map(|value| RecoveryKitKeyMetadata {
            version: value.version,
            algorithm: ALGORITHM.to_owned(),
            fingerprint_sha256: value.sha256.clone(),
            current: value.version == current,
        })
        .collect::<Vec<_>>();
    master_keys.sort_by_key(|value| value.version);
    Ok(RecoveryKitMetadata {
        artifact_sha256: hex_sha256(artifact),
        format_version: payload.format_version,
        kit_id: payload.kit_id,
        instance_id: payload.instance_id.clone(),
        created_at: payload.created_at.clone(),
        nuriteo_release: payload.nuriteo_release.clone(),
        master_keys,
    })
}

fn key_fingerprint(version: u32, key: &MasterKey) -> String {
    let mut digest = Sha256::new();
    digest.update(b"nuriteo.recovery-kit.master-key.v1\0");
    digest.update(version.to_be_bytes());
    digest.update(key.0.as_slice());
    hex_bytes(digest.finalize().as_slice())
}

fn hex_sha256(value: &[u8]) -> String {
    hex_bytes(Sha256::digest(value).as_slice())
}

fn hex_bytes(value: &[u8]) -> String {
    const HEX: &[u8; 16] = b"0123456789abcdef";
    let mut encoded = String::with_capacity(value.len() * 2);
    for byte in value {
        encoded.push(char::from(HEX[usize::from(byte >> 4)]));
        encoded.push(char::from(HEX[usize::from(byte & 0x0f)]));
    }
    encoded
}

fn validate_instance_id(value: &str) -> Result<(), RecoveryKitError> {
    let mut characters = value.chars();
    let Some(first) = characters.next() else {
        return Err(RecoveryKitError::InvalidInstance);
    };
    if value.len() > 128
        || !first.is_ascii_alphanumeric()
        || !characters.all(|character| {
            character.is_ascii_alphanumeric() || matches!(character, '.' | '_' | ':' | '-')
        })
    {
        return Err(RecoveryKitError::InvalidInstance);
    }
    Ok(())
}

#[cfg(test)]
mod tests {
    use super::*;

    fn fixture_ring() -> MasterKeyring {
        MasterKeyring::test(3, &[(1, [1; 32]), (2, [2; 32]), (3, [3; 32])])
    }

    fn passphrase() -> RecoveryKitPassphrase {
        RecoveryKitPassphrase::new("correct horse battery staple".to_owned()).unwrap()
    }

    #[test]
    fn binary_age_round_trip_exposes_only_metadata() {
        let ring = fixture_ring();
        let (artifact, exported) = export(
            &ring,
            "instance",
            OffsetDateTime::from_unix_timestamp(1_700_000_000).unwrap(),
            &passphrase(),
        )
        .unwrap();
        assert!(artifact.starts_with(b"age-encryption.org/v1\n"));
        assert!(!artifact.windows(32).any(|window| window == [3; 32]));

        let inspected = inspect(&artifact, &passphrase()).unwrap();
        assert_eq!(inspected, exported);
        assert_eq!(inspected.master_keys.len(), 3);
        assert_eq!(
            inspected
                .master_keys
                .iter()
                .filter(|key| key.current)
                .count(),
            1
        );
        verify(&artifact, &passphrase(), "instance", Some(&ring)).unwrap();

        let restored = restore(&artifact, &passphrase(), "instance").unwrap();
        assert_eq!(restored.current_version(), 3);
        assert_eq!(
            restored.current_key_base64().unwrap().as_str(),
            URL_SAFE_NO_PAD.encode([3; 32])
        );
        let previous: serde_json::Value =
            serde_json::from_slice(&restored.previous_keys_json().unwrap()).unwrap();
        assert_eq!(previous.as_array().unwrap().len(), 2);
    }

    #[test]
    fn rejects_wrong_passphrase_corruption_and_instance_mismatch() {
        let (mut artifact, _) = export(
            &fixture_ring(),
            "instance",
            OffsetDateTime::UNIX_EPOCH,
            &passphrase(),
        )
        .unwrap();
        let wrong = RecoveryKitPassphrase::new("this is definitely wrong".to_owned()).unwrap();
        assert_eq!(
            inspect(&artifact, &wrong),
            Err(RecoveryKitError::Decryption)
        );
        let last = artifact.len() - 1;
        artifact[last] ^= 1;
        assert_eq!(
            inspect(&artifact, &passphrase()),
            Err(RecoveryKitError::Decryption)
        );

        let (artifact, _) = export(
            &fixture_ring(),
            "instance",
            OffsetDateTime::UNIX_EPOCH,
            &passphrase(),
        )
        .unwrap();
        assert_eq!(
            verify(&artifact, &passphrase(), "other", None),
            Err(RecoveryKitError::IncompatibleInstance)
        );
    }

    #[test]
    fn validates_passphrase_without_normalizing_unicode() {
        assert_eq!(
            RecoveryKitPassphrase::new("too short".to_owned()),
            Err(RecoveryKitError::InvalidPassphrase)
        );
        let composed = RecoveryKitPassphrase::new("éabcdefghijklmno".to_owned()).unwrap();
        let decomposed = RecoveryKitPassphrase::new("e\u{301}abcdefghijklmno".to_owned()).unwrap();
        assert_ne!(composed, decomposed);
    }
}
