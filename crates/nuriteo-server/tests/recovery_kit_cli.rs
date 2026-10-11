use std::fs;
use std::process::{Command, Output};

use base64::Engine;
use base64::engine::general_purpose::URL_SAFE_NO_PAD;

fn command(arguments: &[&str], current_key: &str, previous_keys: &str) -> Output {
    Command::new(env!("CARGO_BIN_EXE_nuriteo-server"))
        .args(arguments)
        .env("NURITEO_MASTER_KEY", current_key)
        .env("NURITEO_MASTER_KEY_VERSION", "2")
        .env("NURITEO_PREVIOUS_MASTER_KEYS", previous_keys)
        .output()
        .unwrap()
}

#[test]
fn exports_inspects_verifies_and_restores_a_private_recovery_kit() {
    let root = tempfile::tempdir().unwrap();
    let passphrase = root.path().join("passphrase");
    let wrong_passphrase = root.path().join("wrong-passphrase");
    let artifact = root.path().join("kit.age");
    let restored = root.path().join("restored");
    fs::write(&passphrase, "correct horse battery staple").unwrap();
    fs::write(&wrong_passphrase, "another incorrect passphrase").unwrap();

    let current_key = URL_SAFE_NO_PAD.encode([7_u8; 32]);
    let previous_key = URL_SAFE_NO_PAD.encode([5_u8; 32]);
    let previous_keys = serde_json::json!([{"version": 1, "key": previous_key}]).to_string();
    let artifact_string = artifact.to_string_lossy();
    let passphrase_string = passphrase.to_string_lossy();

    let exported = command(
        &[
            "recovery-kit",
            "export",
            "--output",
            &artifact_string,
            "--passphrase-file",
            &passphrase_string,
        ],
        &current_key,
        &previous_keys,
    );
    assert!(
        exported.status.success(),
        "{}",
        String::from_utf8_lossy(&exported.stderr)
    );
    let exported_metadata: serde_json::Value = serde_json::from_slice(&exported.stdout).unwrap();
    assert_eq!(exported_metadata["instance_id"], "instance");
    assert_eq!(
        exported_metadata["master_keys"].as_array().unwrap().len(),
        2
    );
    let encrypted = fs::read(&artifact).unwrap();
    assert!(encrypted.starts_with(b"age-encryption.org/v1\n"));
    assert!(
        !encrypted
            .windows(current_key.len())
            .any(|window| window == current_key.as_bytes())
    );

    let inspected = command(
        &[
            "recovery-kit",
            "inspect",
            "--input",
            &artifact_string,
            "--passphrase-file",
            &passphrase_string,
        ],
        &current_key,
        &previous_keys,
    );
    assert!(inspected.status.success());
    assert_eq!(
        serde_json::from_slice::<serde_json::Value>(&inspected.stdout).unwrap(),
        exported_metadata
    );

    let verified = command(
        &[
            "recovery-kit",
            "verify",
            "--input",
            &artifact_string,
            "--passphrase-file",
            &passphrase_string,
        ],
        &current_key,
        &previous_keys,
    );
    assert!(verified.status.success());

    let restored_string = restored.to_string_lossy();
    let restore = command(
        &[
            "recovery-kit",
            "restore",
            "--input",
            &artifact_string,
            "--passphrase-file",
            &passphrase_string,
            "--output-dir",
            &restored_string,
        ],
        &current_key,
        &previous_keys,
    );
    assert!(
        restore.status.success(),
        "{}",
        String::from_utf8_lossy(&restore.stderr)
    );
    assert_eq!(
        fs::read_to_string(restored.join("master-key")).unwrap(),
        current_key
    );
    assert_eq!(
        fs::read_to_string(restored.join("master-key-version")).unwrap(),
        "2"
    );
    let restored_previous: serde_json::Value =
        serde_json::from_slice(&fs::read(restored.join("previous-master-keys.json")).unwrap())
            .unwrap();
    assert_eq!(restored_previous[0]["version"], 1);
    assert_eq!(restored_previous[0]["key"], previous_key);

    let second_export = command(
        &[
            "recovery-kit",
            "export",
            "--output",
            &artifact_string,
            "--passphrase-file",
            &passphrase_string,
        ],
        &current_key,
        &previous_keys,
    );
    assert!(!second_export.status.success());
    assert!(String::from_utf8_lossy(&second_export.stderr).contains("(output)"));

    let wrong_string = wrong_passphrase.to_string_lossy();
    let wrong = command(
        &[
            "recovery-kit",
            "inspect",
            "--input",
            &artifact_string,
            "--passphrase-file",
            &wrong_string,
        ],
        &current_key,
        &previous_keys,
    );
    assert!(!wrong.status.success());
    assert!(String::from_utf8_lossy(&wrong.stderr).contains("(decryption)"));

    #[cfg(unix)]
    {
        use std::os::unix::fs::PermissionsExt;
        assert_eq!(
            fs::metadata(&artifact).unwrap().permissions().mode() & 0o777,
            0o600
        );
        assert_eq!(
            fs::metadata(&restored).unwrap().permissions().mode() & 0o777,
            0o700
        );
        for name in [
            "master-key",
            "master-key-version",
            "previous-master-keys.json",
        ] {
            assert_eq!(
                fs::metadata(restored.join(name))
                    .unwrap()
                    .permissions()
                    .mode()
                    & 0o777,
                0o600
            );
        }
    }
}
