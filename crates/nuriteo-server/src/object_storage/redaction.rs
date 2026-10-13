use std::fmt;

use url::Url;

use super::ObjectStorageConfigError;

/// A bearer URL whose standard formatting never exposes its authority, path,
/// query, or signature. S3-002 may use this for presigned request results.
#[derive(Clone, PartialEq, Eq)]
pub struct SensitiveUrl(Url);

impl SensitiveUrl {
    pub fn parse(value: &str) -> Result<Self, ObjectStorageConfigError> {
        let url = Url::parse(value).map_err(|_| ObjectStorageConfigError::InvalidSignedUrl)?;
        if !matches!(url.scheme(), "http" | "https") || url.host().is_none() {
            return Err(ObjectStorageConfigError::InvalidSignedUrl);
        }
        Ok(Self(url))
    }

    pub(crate) const fn expose_bearer_url(&self) -> &Url {
        &self.0
    }
}

impl fmt::Debug for SensitiveUrl {
    fn fmt(&self, formatter: &mut fmt::Formatter<'_>) -> fmt::Result {
        formatter.write_str("SensitiveUrl([REDACTED])")
    }
}
