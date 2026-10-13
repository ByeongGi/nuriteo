use base64::Engine as _;
use base64::engine::general_purpose::STANDARD as BASE64;
use std::fmt;

use crate::config::{ConfigError, Environment, FileReader, load_secret};

use super::{IdempotencySecret, SinglePutServiceError};
use crate::quota::EffectiveQuota;

pub const IDEMPOTENCY_SECRET: &str = "NURITEO_SAVE_IDEMPOTENCY_SECRET";
pub const IDEMPOTENCY_SECRET_FILE: &str = "NURITEO_SAVE_IDEMPOTENCY_SECRET_FILE";
pub const DEFAULT_QUOTA_BYTES: &str = "NURITEO_SAVE_DEFAULT_QUOTA_BYTES";
pub const UPLOAD_TRANSPORT: &str = "NURITEO_SAVE_UPLOAD_TRANSPORT";

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum SaveUploadTransport {
    Relay,
    Direct,
}

#[derive(Clone)]
pub struct SaveHttpConfig {
    idempotency_secret: IdempotencySecret,
    effective_quota: EffectiveQuota,
    upload_transport: SaveUploadTransport,
}

impl SaveHttpConfig {
    pub fn load(
        environment: &impl Environment,
        files: &impl FileReader,
    ) -> Result<Self, SaveHttpConfigError> {
        if environment
            .entries()
            .iter()
            .any(|(name, _)| name.to_str() == Some(IDEMPOTENCY_SECRET))
        {
            return Err(SaveHttpConfigError::DirectSecretUnsupported);
        }
        let encoded = load_secret(
            environment,
            files,
            IDEMPOTENCY_SECRET,
            IDEMPOTENCY_SECRET_FILE,
        )?
        .ok_or(SaveHttpConfigError::MissingSecret)?;
        let decoded = BASE64
            .decode(encoded.expose_secret())
            .map_err(|_| SaveHttpConfigError::InvalidSecret)?;
        let bytes: [u8; 32] = decoded
            .try_into()
            .map_err(|_| SaveHttpConfigError::InvalidSecret)?;
        let idempotency_secret =
            IdempotencySecret::new(bytes).map_err(|_| SaveHttpConfigError::InvalidSecret)?;
        let quota = environment
            .entries()
            .into_iter()
            .find(|(name, _)| name == DEFAULT_QUOTA_BYTES)
            .ok_or(SaveHttpConfigError::MissingQuota)?
            .1
            .into_string()
            .map_err(|_| SaveHttpConfigError::InvalidQuota)?;
        let effective_quota = if quota == "unlimited" {
            EffectiveQuota::unlimited()
        } else {
            EffectiveQuota::limited(
                quota
                    .parse::<u64>()
                    .map_err(|_| SaveHttpConfigError::InvalidQuota)?,
            )
            .map_err(|_| SaveHttpConfigError::InvalidQuota)?
        };
        let upload_transport = environment
            .entries()
            .into_iter()
            .find(|(name, _)| name == UPLOAD_TRANSPORT)
            .ok_or(SaveHttpConfigError::MissingUploadTransport)?
            .1
            .into_string()
            .map_err(|_| SaveHttpConfigError::InvalidUploadTransport)
            .and_then(|value| match value.as_str() {
                "relay" => Ok(SaveUploadTransport::Relay),
                "direct" => Ok(SaveUploadTransport::Direct),
                _ => Err(SaveHttpConfigError::InvalidUploadTransport),
            })?;
        Ok(Self {
            idempotency_secret,
            effective_quota,
            upload_transport,
        })
    }

    #[must_use]
    pub fn idempotency_secret(&self) -> IdempotencySecret {
        self.idempotency_secret.clone()
    }

    #[must_use]
    pub const fn effective_quota(&self) -> EffectiveQuota {
        self.effective_quota
    }

    #[must_use]
    pub const fn upload_transport(&self) -> SaveUploadTransport {
        self.upload_transport
    }
}

impl fmt::Debug for SaveHttpConfig {
    fn fmt(&self, formatter: &mut fmt::Formatter<'_>) -> fmt::Result {
        formatter
            .debug_struct("SaveHttpConfig")
            .field("idempotency_secret", &"[REDACTED]")
            .field("effective_quota", &self.effective_quota)
            .field("upload_transport", &self.upload_transport)
            .finish()
    }
}

#[derive(Debug)]
pub enum SaveHttpConfigError {
    Config(ConfigError),
    MissingSecret,
    DirectSecretUnsupported,
    InvalidSecret,
    MissingQuota,
    InvalidQuota,
    MissingUploadTransport,
    InvalidUploadTransport,
}

impl fmt::Display for SaveHttpConfigError {
    fn fmt(&self, formatter: &mut fmt::Formatter<'_>) -> fmt::Result {
        formatter.write_str(match self {
            Self::Config(_) => "Save HTTP secret source is invalid",
            Self::MissingSecret => "Save idempotency secret is missing",
            Self::DirectSecretUnsupported => {
                "Save idempotency secret must use the mounted secret file source"
            }
            Self::InvalidSecret => {
                "Save idempotency secret must be non-zero base64-encoded 32 bytes"
            }
            Self::MissingQuota => "Save default quota is missing",
            Self::InvalidQuota => "Save default quota must be unlimited or a positive byte count",
            Self::MissingUploadTransport => "Save upload transport is missing",
            Self::InvalidUploadTransport => "Save upload transport must be relay or direct",
        })
    }
}

impl std::error::Error for SaveHttpConfigError {}

impl From<ConfigError> for SaveHttpConfigError {
    fn from(value: ConfigError) -> Self {
        Self::Config(value)
    }
}

impl From<SinglePutServiceError> for SaveHttpConfigError {
    fn from(_: SinglePutServiceError) -> Self {
        Self::InvalidSecret
    }
}

#[cfg(test)]
mod tests {
    use std::collections::BTreeMap;
    use std::ffi::OsString;
    use std::io;
    use std::path::Path;

    use super::*;

    #[derive(Default)]
    struct TestEnvironment(Vec<(OsString, OsString)>);

    impl Environment for TestEnvironment {
        fn entries(&self) -> Vec<(OsString, OsString)> {
            self.0.clone()
        }
    }

    #[derive(Default)]
    struct TestFiles(BTreeMap<String, Vec<u8>>);

    impl FileReader for TestFiles {
        fn read(&self, path: &Path, _limit: usize) -> io::Result<Vec<u8>> {
            self.0
                .get(path.to_string_lossy().as_ref())
                .cloned()
                .ok_or_else(|| io::Error::new(io::ErrorKind::NotFound, "missing fixture"))
        }
    }

    fn environment(entries: &[(&str, String)]) -> TestEnvironment {
        TestEnvironment(
            entries
                .iter()
                .map(|(name, value)| (OsString::from(name), OsString::from(value)))
                .collect(),
        )
    }

    #[test]
    fn loads_restart_stable_file_secret_and_bounded_quota_without_debug_leak() {
        let encoded = BASE64.encode([0x5a; 32]);
        let files = TestFiles(BTreeMap::from([(
            "/run/secrets/save".to_owned(),
            format!("{encoded}\n").into_bytes(),
        )]));
        let config = SaveHttpConfig::load(
            &environment(&[
                (IDEMPOTENCY_SECRET_FILE, "/run/secrets/save".to_owned()),
                (DEFAULT_QUOTA_BYTES, "10737418240".to_owned()),
                (UPLOAD_TRANSPORT, "relay".to_owned()),
            ]),
            &files,
        )
        .unwrap();
        assert_eq!(
            config.effective_quota().limit_bytes(),
            Some(10 * 1024 * 1024 * 1024)
        );
        assert_eq!(config.upload_transport(), SaveUploadTransport::Relay);
        let debug = format!("{config:?}");
        assert!(debug.contains("[REDACTED]"));
        assert!(!debug.contains(&encoded));
    }

    #[test]
    fn fails_closed_for_missing_changed_or_ambiguous_bootstrap_values() {
        let valid = BASE64.encode([0x33; 32]);
        let zeros = BASE64.encode([0; 32]);
        let files = TestFiles(BTreeMap::from([
            ("/secret".to_owned(), valid.as_bytes().to_vec()),
            ("/zeros".to_owned(), zeros.as_bytes().to_vec()),
        ]));
        for (entries, expected) in [
            (
                vec![(DEFAULT_QUOTA_BYTES, "10".to_owned())],
                SaveHttpConfigError::MissingSecret,
            ),
            (
                vec![
                    (IDEMPOTENCY_SECRET_FILE, "/secret".to_owned()),
                    (DEFAULT_QUOTA_BYTES, "0".to_owned()),
                    (UPLOAD_TRANSPORT, "relay".to_owned()),
                ],
                SaveHttpConfigError::InvalidQuota,
            ),
            (
                vec![
                    (IDEMPOTENCY_SECRET_FILE, "/zeros".to_owned()),
                    (DEFAULT_QUOTA_BYTES, "10".to_owned()),
                    (UPLOAD_TRANSPORT, "relay".to_owned()),
                ],
                SaveHttpConfigError::InvalidSecret,
            ),
            (
                vec![
                    (IDEMPOTENCY_SECRET_FILE, "/secret".to_owned()),
                    (DEFAULT_QUOTA_BYTES, (i64::MAX as u64 + 1).to_string()),
                    (UPLOAD_TRANSPORT, "relay".to_owned()),
                ],
                SaveHttpConfigError::InvalidQuota,
            ),
        ] {
            let error = SaveHttpConfig::load(&environment(&entries), &files).unwrap_err();
            assert_eq!(error.to_string(), expected.to_string());
        }

        let direct = SaveHttpConfig::load(
            &environment(&[
                (IDEMPOTENCY_SECRET, valid),
                (DEFAULT_QUOTA_BYTES, "unlimited".to_owned()),
                (UPLOAD_TRANSPORT, "direct".to_owned()),
            ]),
            &files,
        )
        .unwrap_err();
        assert!(matches!(
            direct,
            SaveHttpConfigError::DirectSecretUnsupported
        ));

        let missing_transport = SaveHttpConfig::load(
            &environment(&[
                (IDEMPOTENCY_SECRET_FILE, "/secret".to_owned()),
                (DEFAULT_QUOTA_BYTES, "unlimited".to_owned()),
            ]),
            &files,
        )
        .unwrap_err();
        assert!(matches!(
            missing_transport,
            SaveHttpConfigError::MissingUploadTransport
        ));

        for invalid in ["", "DIRECT", "presigned", "relay "] {
            let error = SaveHttpConfig::load(
                &environment(&[
                    (IDEMPOTENCY_SECRET_FILE, "/secret".to_owned()),
                    (DEFAULT_QUOTA_BYTES, "unlimited".to_owned()),
                    (UPLOAD_TRANSPORT, invalid.to_owned()),
                ]),
                &files,
            )
            .unwrap_err();
            assert!(matches!(error, SaveHttpConfigError::InvalidUploadTransport));
        }
    }
}
