use std::fmt;
use std::str::FromStr;

use serde::{Deserialize, Deserializer, Serialize, Serializer};
use time::OffsetDateTime;
use time::format_description::well_known::Rfc3339;

use super::IdentityError;

#[derive(Clone, Copy, PartialEq, Eq, PartialOrd, Ord, Hash)]
pub struct Timestamp(OffsetDateTime);

impl Timestamp {
    pub fn from_datetime(value: OffsetDateTime) -> Result<Self, IdentityError> {
        let value = value.to_offset(time::UtcOffset::UTC);
        value
            .format(&Rfc3339)
            .map_err(|_| IdentityError::TimestampOutOfRange)?;
        Ok(Self(value))
    }

    pub fn from_unix_timestamp(seconds: i64) -> Result<Self, IdentityError> {
        OffsetDateTime::from_unix_timestamp(seconds)
            .map_err(|_| IdentityError::TimestampOutOfRange)
            .and_then(Self::from_datetime)
    }

    #[must_use]
    pub const fn into_datetime(self) -> OffsetDateTime {
        self.0
    }
}

impl fmt::Debug for Timestamp {
    fn fmt(&self, formatter: &mut fmt::Formatter<'_>) -> fmt::Result {
        formatter
            .debug_tuple("Timestamp")
            .field(&self.to_string())
            .finish()
    }
}

impl fmt::Display for Timestamp {
    fn fmt(&self, formatter: &mut fmt::Formatter<'_>) -> fmt::Result {
        let formatted = self.0.format(&Rfc3339).map_err(|_| fmt::Error)?;
        formatter.write_str(&formatted)
    }
}

impl FromStr for Timestamp {
    type Err = IdentityError;

    fn from_str(value: &str) -> Result<Self, Self::Err> {
        OffsetDateTime::parse(value, &Rfc3339)
            .map_err(|_| IdentityError::TimestampOutOfRange)
            .and_then(Self::from_datetime)
    }
}

impl Serialize for Timestamp {
    fn serialize<S>(&self, serializer: S) -> Result<S::Ok, S::Error>
    where
        S: Serializer,
    {
        serializer.collect_str(self)
    }
}

impl<'de> Deserialize<'de> for Timestamp {
    fn deserialize<D>(deserializer: D) -> Result<Self, D::Error>
    where
        D: Deserializer<'de>,
    {
        let value = String::deserialize(deserializer)?;
        value.parse().map_err(serde::de::Error::custom)
    }
}
