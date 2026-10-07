pub mod admin;
pub mod app;
pub mod audit;
pub mod auth;
pub mod bootstrap;
pub mod cli;
pub mod config;
pub mod database;
pub mod health;
pub mod http;
pub mod identity;
pub mod instance_settings;
pub mod integration;
pub mod invitations;
pub(crate) mod mfa;
pub mod notification;
pub mod object_storage;
pub mod observability;
pub mod oidc;
pub mod openapi;
pub mod organization;
pub mod policy;
pub mod project;
pub mod quota;
pub mod save;
pub mod setup;
pub mod smtp;
mod storage_check;
pub mod team;
pub mod workspace;

pub const VERSION: &str = env!("CARGO_PKG_VERSION");
pub const USAGE: &str = "Usage: nuriteo-server <COMMAND>";

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum CommandStatus {
    Success,
    Failure,
    UsageError,
}

impl CommandStatus {
    #[must_use]
    pub const fn exit_code(self) -> u8 {
        match self {
            Self::Success => 0,
            Self::Failure => 1,
            Self::UsageError => 2,
        }
    }
}

pub use cli::{run, run_async};

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn exposes_the_package_version() {
        assert_eq!(VERSION, env!("CARGO_PKG_VERSION"));
    }

    #[test]
    fn exposes_stable_exit_codes() {
        assert_eq!(CommandStatus::Success.exit_code(), 0);
        assert_eq!(CommandStatus::Failure.exit_code(), 1);
        assert_eq!(CommandStatus::UsageError.exit_code(), 2);
    }
}
