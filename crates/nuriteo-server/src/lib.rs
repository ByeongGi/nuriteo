pub mod app;
pub mod cli;
pub mod config;
pub mod database;
pub mod http;
pub mod object_storage;
pub mod observability;
pub mod openapi;

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

pub use cli::run;

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
