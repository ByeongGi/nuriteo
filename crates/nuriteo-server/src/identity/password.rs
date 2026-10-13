use std::fmt;

use argon2::password_hash::phc::PasswordHash as ParsedPasswordHash;
use argon2::password_hash::{PasswordHasher, PasswordVerifier};
use argon2::{Algorithm, Argon2, Params, Version};

const ARGON2_VERSION: u32 = 19;
const GENERATED_MEMORY_KIB: u32 = 19 * 1024;
const GENERATED_TIME_COST: u32 = 2;
const GENERATED_PARALLELISM: u32 = 1;
const GENERATED_OUTPUT_BYTES: usize = 32;
const GENERATED_SALT_BYTES: usize = 16;

const MAX_MEMORY_KIB: u32 = 64 * 1024;
const MAX_TIME_COST: u32 = 4;
const MAX_PARALLELISM: u32 = 4;
const MAX_SALT_BYTES: usize = 32;
const MAX_OUTPUT_BYTES: usize = 32;
const MAX_PASSWORD_BYTES: usize = 1024;
const MAX_PHC_BYTES: usize = 256;

/// Explicit resource and input policy for local password credentials.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub struct PasswordPolicy {
    memory_kib: u32,
    time_cost: u32,
    parallelism: u32,
    output_bytes: usize,
    salt_bytes: usize,
    max_memory_kib: u32,
    max_time_cost: u32,
    max_parallelism: u32,
    max_output_bytes: usize,
    max_salt_bytes: usize,
    max_password_bytes: usize,
    max_phc_bytes: usize,
}

impl PasswordPolicy {
    pub const STANDARD: Self = Self {
        memory_kib: GENERATED_MEMORY_KIB,
        time_cost: GENERATED_TIME_COST,
        parallelism: GENERATED_PARALLELISM,
        output_bytes: GENERATED_OUTPUT_BYTES,
        salt_bytes: GENERATED_SALT_BYTES,
        max_memory_kib: MAX_MEMORY_KIB,
        max_time_cost: MAX_TIME_COST,
        max_parallelism: MAX_PARALLELISM,
        max_output_bytes: MAX_OUTPUT_BYTES,
        max_salt_bytes: MAX_SALT_BYTES,
        max_password_bytes: MAX_PASSWORD_BYTES,
        max_phc_bytes: MAX_PHC_BYTES,
    };

    #[must_use]
    pub const fn memory_kib(self) -> u32 {
        self.memory_kib
    }

    #[must_use]
    pub const fn time_cost(self) -> u32 {
        self.time_cost
    }

    #[must_use]
    pub const fn parallelism(self) -> u32 {
        self.parallelism
    }

    #[must_use]
    pub const fn output_bytes(self) -> usize {
        self.output_bytes
    }

    #[must_use]
    pub const fn salt_bytes(self) -> usize {
        self.salt_bytes
    }

    #[must_use]
    pub const fn max_memory_kib(self) -> u32 {
        self.max_memory_kib
    }

    #[must_use]
    pub const fn max_time_cost(self) -> u32 {
        self.max_time_cost
    }

    #[must_use]
    pub const fn max_parallelism(self) -> u32 {
        self.max_parallelism
    }

    #[must_use]
    pub const fn max_output_bytes(self) -> usize {
        self.max_output_bytes
    }

    #[must_use]
    pub const fn max_salt_bytes(self) -> usize {
        self.max_salt_bytes
    }

    #[must_use]
    pub const fn max_password_bytes(self) -> usize {
        self.max_password_bytes
    }

    #[must_use]
    pub const fn max_phc_bytes(self) -> usize {
        self.max_phc_bytes
    }
}

impl Default for PasswordPolicy {
    fn default() -> Self {
        Self::STANDARD
    }
}

/// Owned PHC verifier value. Standard formatting is deliberately redacted.
#[derive(PartialEq, Eq)]
pub struct StoredPasswordHash(String);

impl StoredPasswordHash {
    pub fn new(value: String) -> Result<Self, PasswordHashInputError> {
        if value.is_empty() || value.len() > MAX_PHC_BYTES {
            return Err(PasswordHashInputError::InvalidLength);
        }
        Ok(Self(value))
    }

    /// Explicitly exposes the PHC value to the credential persistence adapter.
    #[must_use]
    pub(crate) fn expose(&self) -> &str {
        &self.0
    }
}

impl fmt::Debug for StoredPasswordHash {
    fn fmt(&self, formatter: &mut fmt::Formatter<'_>) -> fmt::Result {
        formatter.write_str("StoredPasswordHash([REDACTED])")
    }
}

impl fmt::Display for StoredPasswordHash {
    fn fmt(&self, formatter: &mut fmt::Formatter<'_>) -> fmt::Result {
        formatter.write_str("[REDACTED]")
    }
}

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum PasswordHashInputError {
    InvalidLength,
}

impl fmt::Display for PasswordHashInputError {
    fn fmt(&self, formatter: &mut fmt::Formatter<'_>) -> fmt::Result {
        formatter.write_str("password verifier length is invalid")
    }
}

impl std::error::Error for PasswordHashInputError {}

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum PasswordHashError {
    InvalidPasswordLength,
    OperationFailed,
}

impl fmt::Display for PasswordHashError {
    fn fmt(&self, formatter: &mut fmt::Formatter<'_>) -> fmt::Result {
        formatter.write_str(match self {
            Self::InvalidPasswordLength => "password length is invalid",
            Self::OperationFailed => "password hashing failed",
        })
    }
}

impl std::error::Error for PasswordHashError {}

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum PasswordVerifyError {
    InvalidPasswordLength,
    MalformedHash,
    UnsupportedHash,
    ResourceLimit,
    OperationFailed,
}

impl fmt::Display for PasswordVerifyError {
    fn fmt(&self, formatter: &mut fmt::Formatter<'_>) -> fmt::Result {
        formatter.write_str(match self {
            Self::InvalidPasswordLength => "password length is invalid",
            Self::MalformedHash => "password verifier is malformed",
            Self::UnsupportedHash => "password verifier is unsupported",
            Self::ResourceLimit => "password verifier exceeds the resource policy",
            Self::OperationFailed => "password verification failed",
        })
    }
}

impl std::error::Error for PasswordVerifyError {}

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum PasswordVerification {
    Match,
    Mismatch,
}

/// Synchronous CPU-bound Argon2id boundary.
///
/// Async callers must execute `hash` and `verify` in their own bounded
/// blocking pool. This service intentionally does not spawn detached work.
#[derive(Debug, Clone, Copy)]
pub struct PasswordService {
    policy: PasswordPolicy,
}

impl PasswordService {
    #[must_use]
    pub const fn new(policy: PasswordPolicy) -> Self {
        Self { policy }
    }

    #[must_use]
    pub const fn policy(self) -> PasswordPolicy {
        self.policy
    }

    pub fn hash(&self, password: &[u8]) -> Result<StoredPasswordHash, PasswordHashError> {
        validate_password(password, self.policy.max_password_bytes)
            .map_err(|_| PasswordHashError::InvalidPasswordLength)?;
        let parsed = self
            .argon2()
            .map_err(|_| PasswordHashError::OperationFailed)?
            .hash_password(password)
            .map_err(|_| PasswordHashError::OperationFailed)?;
        StoredPasswordHash::new(parsed.to_string()).map_err(|_| PasswordHashError::OperationFailed)
    }

    pub fn verify(
        &self,
        password: &[u8],
        stored: &StoredPasswordHash,
    ) -> Result<PasswordVerification, PasswordVerifyError> {
        validate_password(password, self.policy.max_password_bytes)
            .map_err(|_| PasswordVerifyError::InvalidPasswordLength)?;
        let parsed = ParsedPasswordHash::new(stored.expose())
            .map_err(|_| PasswordVerifyError::MalformedHash)?;
        validate_parsed_hash(&parsed, self.policy)?;

        match self
            .argon2()
            .map_err(|_| PasswordVerifyError::OperationFailed)?
            .verify_password(password, &parsed)
        {
            Ok(()) => Ok(PasswordVerification::Match),
            Err(argon2::password_hash::Error::PasswordInvalid) => {
                Ok(PasswordVerification::Mismatch)
            }
            Err(_) => Err(PasswordVerifyError::OperationFailed),
        }
    }

    fn argon2(&self) -> Result<Argon2<'static>, argon2::Error> {
        let params = Params::new(
            self.policy.memory_kib,
            self.policy.time_cost,
            self.policy.parallelism,
            Some(self.policy.output_bytes),
        )?;
        Ok(Argon2::new(Algorithm::Argon2id, Version::V0x13, params))
    }
}

impl Default for PasswordService {
    fn default() -> Self {
        Self::new(PasswordPolicy::STANDARD)
    }
}

fn validate_password(password: &[u8], maximum: usize) -> Result<(), ()> {
    if password.is_empty() || password.len() > maximum {
        Err(())
    } else {
        Ok(())
    }
}

fn validate_parsed_hash(
    parsed: &ParsedPasswordHash,
    policy: PasswordPolicy,
) -> Result<(), PasswordVerifyError> {
    if parsed.algorithm.as_str() != "argon2id" || parsed.version != Some(ARGON2_VERSION) {
        return Err(PasswordVerifyError::UnsupportedHash);
    }
    if parsed.params.iter().count() != 3 {
        return Err(PasswordVerifyError::UnsupportedHash);
    }
    let memory = parameter(parsed, "m")?;
    let time = parameter(parsed, "t")?;
    let parallelism = parameter(parsed, "p")?;
    let salt = parsed
        .salt
        .as_ref()
        .ok_or(PasswordVerifyError::MalformedHash)?;
    let output = parsed
        .hash
        .as_ref()
        .ok_or(PasswordVerifyError::MalformedHash)?;

    if memory < policy.memory_kib
        || memory > policy.max_memory_kib
        || time < policy.time_cost
        || time > policy.max_time_cost
        || parallelism < policy.parallelism
        || parallelism > policy.max_parallelism
        || decoded_salt_len(salt) < policy.salt_bytes
        || decoded_salt_len(salt) > policy.max_salt_bytes
        || output.len() < policy.output_bytes
        || output.len() > policy.max_output_bytes
    {
        return Err(PasswordVerifyError::ResourceLimit);
    }
    Ok(())
}

fn decoded_salt_len(salt: &argon2::password_hash::phc::Salt) -> usize {
    // The PHC parser has already base64-decoded into Salt's fixed 48-byte
    // buffer. AsRef<[u8]> returns only the initialized decoded byte range.
    let decoded: &[u8] = salt.as_ref();
    decoded.len()
}

fn parameter(parsed: &ParsedPasswordHash, name: &str) -> Result<u32, PasswordVerifyError> {
    parsed
        .params
        .get_decimal(name)
        .ok_or(PasswordVerifyError::MalformedHash)
}

#[cfg(test)]
mod tests;
