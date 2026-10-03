use std::ffi::OsStr;
use std::io::{self, Write};

pub const VERSION: &str = env!("CARGO_PKG_VERSION");
pub const USAGE: &str = "usage: nuriteo-server --version";

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum CommandStatus {
    Success,
    UsageError,
}

impl CommandStatus {
    #[must_use]
    pub const fn exit_code(self) -> u8 {
        match self {
            Self::Success => 0,
            Self::UsageError => 2,
        }
    }
}

pub fn run<I, S, O, E>(args: I, stdout: &mut O, stderr: &mut E) -> io::Result<CommandStatus>
where
    I: IntoIterator<Item = S>,
    S: AsRef<OsStr>,
    O: Write,
    E: Write,
{
    let mut args = args.into_iter();

    match (args.next(), args.next()) {
        (Some(argument), None) if argument.as_ref() == "--version" => {
            writeln!(stdout, "nuriteo-server {VERSION}")?;
            Ok(CommandStatus::Success)
        }
        _ => {
            writeln!(stderr, "{USAGE}")?;
            Ok(CommandStatus::UsageError)
        }
    }
}

#[cfg(test)]
mod tests {
    use std::ffi::OsString;

    use super::*;

    #[test]
    fn exposes_the_package_version() {
        assert_eq!(VERSION, env!("CARGO_PKG_VERSION"));
    }

    #[test]
    fn writes_the_version_to_standard_output() {
        let mut stdout = Vec::new();
        let mut stderr = Vec::new();

        let status = run(["--version"], &mut stdout, &mut stderr).unwrap();

        assert_eq!(status, CommandStatus::Success);
        assert_eq!(status.exit_code(), 0);
        assert_eq!(stdout, b"nuriteo-server 0.1.0\n");
        assert!(stderr.is_empty());
    }

    #[test]
    fn rejects_missing_unknown_and_extra_arguments() {
        let cases = [
            Vec::<OsString>::new(),
            vec![OsString::from("serve")],
            vec![OsString::from("--version"), OsString::from("extra")],
        ];

        for args in cases {
            let mut stdout = Vec::new();
            let mut stderr = Vec::new();

            let status = run(args, &mut stdout, &mut stderr).unwrap();

            assert_eq!(status, CommandStatus::UsageError);
            assert_eq!(status.exit_code(), 2);
            assert!(stdout.is_empty());
            assert_eq!(stderr, b"usage: nuriteo-server --version\n");
        }
    }
}
