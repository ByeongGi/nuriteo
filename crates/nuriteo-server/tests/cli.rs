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
fn bootstrap_admin_fails_closed_without_global_configuration() {
    let output = Command::new(env!("CARGO_BIN_EXE_nuriteo-server"))
        .arg("bootstrap-admin")
        .env_clear()
        .output()
        .expect("nuriteo-server binary should start");

    assert_eq!(output.status.code(), Some(1));
    assert!(output.stdout.is_empty());
    assert_eq!(
        output.stderr,
        b"nuriteo-server: bootstrap-admin failed (configuration)\n"
    );
}

#[test]
fn bootstrap_admin_fails_closed_without_command_input() {
    let output = Command::new(env!("CARGO_BIN_EXE_nuriteo-server"))
        .arg("bootstrap-admin")
        .env_clear()
        .env("NURITEO_EXTERNAL_URL", "http://127.0.0.1:3000")
        .output()
        .expect("nuriteo-server binary should start");

    assert_eq!(output.status.code(), Some(1));
    assert!(output.stdout.is_empty());
    assert_eq!(
        output.stderr,
        b"nuriteo-server: bootstrap-admin failed (input)\n"
    );
}

#[test]
fn bootstrap_admin_strict_configuration_rejects_unknown_names_without_values() {
    let secret = "never-print-this";
    let output = Command::new(env!("CARGO_BIN_EXE_nuriteo-server"))
        .arg("bootstrap-admin")
        .env_clear()
        .env("NURITEO_EXTERNAL_URL", "http://127.0.0.1:3000")
        .env("NURITEO_BOOTSTRAP_ADMIN_EMAIL", "admin@example.test")
        .env("NURITEO_BOOTSTRAP_ADMIN_NAME", "Admin")
        .env("NURITEO_BOOTSTRAP_ADMIN_PASSWORD", secret)
        .env("NURITEO_BOOTSTRAP_ADMIN_TYPO", secret)
        .output()
        .expect("nuriteo-server binary should start");

    assert_eq!(output.status.code(), Some(1));
    assert!(output.stdout.is_empty());
    assert_eq!(
        output.stderr,
        b"nuriteo-server: bootstrap-admin failed (configuration)\n"
    );
    assert!(!String::from_utf8_lossy(&output.stderr).contains(secret));
}

#[test]
fn bootstrap_admin_rejects_cli_secret_arguments_without_echoing_the_value() {
    let output = run(&["bootstrap-admin", "--password", "never-print-this"]);

    assert_eq!(output.status.code(), Some(2));
    assert!(output.stdout.is_empty());
    assert!(!String::from_utf8_lossy(&output.stderr).contains("never-print-this"));
}

#[test]
fn serve_fails_closed_before_binding_without_configuration() {
    let output = Command::new(env!("CARGO_BIN_EXE_nuriteo-server"))
        .arg("serve")
        .env_remove("NURITEO_EXTERNAL_URL")
        .env_remove("NURITEO_DATABASE_URL")
        .env_remove("NURITEO_DATABASE_URL_FILE")
        .output()
        .expect("nuriteo-server binary should start");

    assert_eq!(output.status.code(), Some(1));
    assert!(output.stdout.is_empty());
    assert_eq!(
        output.stderr,
        b"nuriteo-server: serve failed (configuration)\n"
    );
}

#[test]
fn healthcheck_fails_closed_when_the_endpoint_is_unavailable() {
    let output = Command::new(env!("CARGO_BIN_EXE_nuriteo-server"))
        .arg("healthcheck")
        .env("NURITEO_HEALTHCHECK_URL", "http://127.0.0.1:9/health/ready")
        .env("NURITEO_HEALTHCHECK_TIMEOUT_MS", "100")
        .output()
        .expect("nuriteo-server binary should start");

    assert_eq!(output.status.code(), Some(1));
    assert!(output.stdout.is_empty());
    assert_eq!(output.stderr, b"nuriteo-server: healthcheck unavailable\n");
}

#[test]
fn migrate_fails_closed_without_configuration() {
    let output = Command::new(env!("CARGO_BIN_EXE_nuriteo-server"))
        .arg("migrate")
        .env_remove("NURITEO_EXTERNAL_URL")
        .env_remove("NURITEO_DATABASE_URL")
        .env_remove("NURITEO_DATABASE_URL_FILE")
        .output()
        .expect("nuriteo-server binary should start");

    assert_eq!(output.status.code(), Some(1));
    assert!(output.stdout.is_empty());
    assert_eq!(
        output.stderr,
        b"nuriteo-server: migrate failed (configuration)\n"
    );
}

#[test]
fn upgrade_preflight_fails_closed_without_configuration() {
    let output = Command::new(env!("CARGO_BIN_EXE_nuriteo-server"))
        .arg("upgrade-preflight")
        .env_remove("NURITEO_EXTERNAL_URL")
        .env_remove("NURITEO_DATABASE_URL")
        .env_remove("NURITEO_DATABASE_URL_FILE")
        .output()
        .expect("nuriteo-server binary should start");

    assert_eq!(output.status.code(), Some(1));
    assert!(output.stdout.is_empty());
    assert_eq!(
        output.stderr,
        b"nuriteo-server: upgrade-preflight stopped (configuration)\n"
    );
}
