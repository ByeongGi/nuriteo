use std::process::{Command, Output};

fn run(args: &[&str]) -> Output {
    Command::new(env!("CARGO_BIN_EXE_nuriteo-server"))
        .args(args)
        .output()
        .expect("nuriteo-server binary should start")
}

#[test]
fn root_and_subcommand_help_match_the_checked_in_contract() {
    let root = run(&["--help"]);
    assert!(root.status.success());
    assert_eq!(root.stdout, include_bytes!("fixtures/root-help.txt"));
    assert!(root.stderr.is_empty());

    let subcommand = run(&["bootstrap-admin", "--help"]);
    assert!(subcommand.status.success());
    assert_eq!(
        subcommand.stdout,
        include_bytes!("fixtures/bootstrap-admin-help.txt")
    );
    assert!(subcommand.stderr.is_empty());
}

#[test]
fn version_preserves_the_original_binary_contract() {
    let output = run(&["--version"]);

    assert_eq!(output.status.code(), Some(0));
    assert_eq!(output.stdout, b"nuriteo-server 0.1.0\n");
    assert!(output.stderr.is_empty());
}

#[test]
fn invalid_invocations_are_usage_errors() {
    for args in [
        Vec::new(),
        vec!["unknown"],
        vec!["serve", "unexpected"],
        vec!["--version", "unexpected"],
    ] {
        let output = run(&args);

        assert_eq!(output.status.code(), Some(2), "args: {args:?}");
        assert!(output.stdout.is_empty(), "args: {args:?}");
        assert!(!output.stderr.is_empty(), "args: {args:?}");
    }
}

#[test]
fn unavailable_commands_fail_closed() {
    for command in ["serve", "migrate", "bootstrap-admin", "healthcheck"] {
        let output = run(&[command]);

        assert_eq!(output.status.code(), Some(1), "command: {command}");
        assert!(output.stdout.is_empty(), "command: {command}");
        assert_eq!(
            String::from_utf8(output.stderr).unwrap(),
            format!("nuriteo-server: `{command}` is not available in this build\n")
        );
    }
}
