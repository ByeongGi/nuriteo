mod config;
mod preflight;

pub use config::{
    SmtpConfig, SmtpConfigError, SmtpConfigSnapshot, SmtpCredentials, SmtpPublicSettings,
    SmtpSecurity, SmtpTlsTrust,
};
pub use preflight::{
    SmtpFailureCategory, SmtpFailureClass, SmtpPreflightError, SmtpPreflightReport, preflight,
};

#[cfg(test)]
mod tests;
