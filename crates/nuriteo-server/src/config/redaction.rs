use std::fmt;

/// An owned secret whose standard formatting cannot expose its value.
#[derive(Clone, PartialEq, Eq)]
pub struct SecretString(String);

impl SecretString {
    pub(super) fn new(value: String) -> Self {
        Self(value)
    }

    /// Explicitly exposes the value to another server adapter.
    #[must_use]
    pub fn expose_secret(&self) -> &str {
        &self.0
    }
}

impl fmt::Debug for SecretString {
    fn fmt(&self, formatter: &mut fmt::Formatter<'_>) -> fmt::Result {
        formatter.write_str("SecretString([REDACTED])")
    }
}
