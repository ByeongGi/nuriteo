mod input;
mod service;

pub use input::{BootstrapAdminInput, BootstrapInputError};
pub use service::{
    BootstrapError, BootstrapErrorCategory, BootstrapOutcome, bootstrap_administrator,
};

#[cfg(test)]
mod tests;
