mod config;
mod delivery;
mod preflight;

pub use config::{
    SmtpBootstrapConfig, SmtpConfig, SmtpConfigError, SmtpConfigSnapshot, SmtpCredentials,
    SmtpPublicSettings, SmtpSecurity, SmtpTlsTrust,
};
pub use delivery::{SmtpConfigHandle, SmtpEmailSender};
pub(crate) use preflight::preflight;
pub use preflight::{
    SmtpFailureCategory, SmtpFailureClass, SmtpPreflightError, SmtpPreflightReport,
    preflight_bootstrap,
};

#[cfg(test)]
mod tests;
