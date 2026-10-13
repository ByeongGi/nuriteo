use super::*;

mod actual_https_fixture;

#[test]
fn accepts_sha1_and_sha256_but_rejects_ambiguous_object_names() {
    assert!(valid_sha(&"a".repeat(40)));
    assert!(valid_sha(&"0".repeat(64)));
    assert!(!valid_sha(&"a".repeat(39)));
    assert!(!valid_sha(&"A".repeat(40)));
    assert!(!valid_sha(&format!("{}g", "a".repeat(39))));
}

#[test]
fn validates_git_branch_and_commit_boundaries() {
    for branch in ["main", "feature/git-sync", "release/v1.2"] {
        assert_eq!(validate_branch(branch), Ok(()));
    }
    for branch in [
        "",
        "/main",
        "main/",
        ".hidden",
        "main.lock",
        "a..b",
        "a@{b",
        "a b",
        "a\\b",
    ] {
        assert_eq!(
            validate_branch(branch),
            Err(GitOperationError::InvalidInput)
        );
    }
    assert_eq!(validate_commit_message("save workspace"), Ok(()));
    assert_eq!(
        validate_commit_message("contains\0nul"),
        Err(GitOperationError::InvalidInput)
    );
}

#[test]
fn outcome_enforces_transfer_and_object_bounds() {
    let valid = GitOperationOutcome::new(None, "a".repeat(40), 5, 1024).unwrap();
    assert_eq!(valid.changed_objects(), 5);
    assert_eq!(
        GitOperationOutcome::new(None, "a".repeat(40), MAX_CHANGED_OBJECTS + 1, 0),
        Err(GitOperationError::InvalidInput)
    );
    assert_eq!(
        GitOperationOutcome::new(None, "a".repeat(40), 0, MAX_TRANSFER_BYTES + 1),
        Err(GitOperationError::InvalidInput)
    );
}

#[test]
fn credential_debug_is_always_redacted() {
    let credential = GitCredential(SecretValue::new(b"never-log-this-token".to_vec()).unwrap());
    let rendered = format!("{credential:?}");
    assert_eq!(rendered, "GitCredential([REDACTED])");
    assert!(!rendered.contains("never-log"));
    assert_eq!(credential.expose(), b"never-log-this-token");
}

#[test]
fn executor_errors_preserve_non_fast_forward_and_auth_semantics() {
    assert_eq!(
        map_executor_error(GitExecutorError::NonFastForward),
        GitOperationError::NonFastForward
    );
    assert_eq!(
        map_executor_error(GitExecutorError::AuthenticationFailed),
        GitOperationError::AuthenticationFailed
    );
    assert_eq!(
        map_executor_error(GitExecutorError::TransferLimitExceeded),
        GitOperationError::TransferLimitExceeded
    );
}

#[test]
fn remote_push_success_fences_every_local_finalize_failure() {
    assert_eq!(
        map_finalize_error(GitOperationError::Unavailable, true),
        GitOperationError::CommitOutcomeUnknown
    );
    assert_eq!(
        map_finalize_error(GitOperationError::Conflict, false),
        GitOperationError::Conflict
    );
}

#[tokio::test]
async fn unconfigured_executor_fails_closed_without_touching_credential() {
    let credential = GitCredential(SecretValue::new(b"never-forwarded".to_vec()).unwrap());
    let provider = sample_provider();
    let error = UnavailableGitExecutor
        .import(GitExecution {
            provider: &provider,
            repository_url: "https://git.example.test/owner/repository.git",
            branch: "main",
            credential: &credential,
        })
        .await
        .unwrap_err();
    assert_eq!(error, GitExecutorError::Unavailable);
}

#[test]
fn public_metadata_has_no_credential_field_or_secret_debug() {
    let user = UserId::new();
    let metadata = GitCredentialConnection {
        id: Uuid::now_v7(),
        user_id: user,
        provider_id: Uuid::now_v7(),
        credential_version: 3,
        connection_version: 4,
        created_at: OffsetDateTime::UNIX_EPOCH,
        updated_at: OffsetDateTime::UNIX_EPOCH,
    };
    let rendered = format!("{metadata:?}");
    assert!(rendered.contains("credential_version: 3"));
    assert!(!rendered.contains("token"));
    assert!(!rendered.contains("secret"));
}

fn sample_provider() -> GitProviderMetadata {
    GitProviderMetadata {
        id: Uuid::now_v7(),
        display_name: "Example Git".to_owned(),
        kind: crate::git_provider::GitProviderKind::Generic,
        canonical_host: "git.example.test".to_owned(),
        canonical_port: 443,
        api_base_url: "https://git.example.test/api".to_owned(),
        oauth_authorization_url: None,
        oauth_token_url: None,
        oauth_client_id: None,
        state: GitProviderState::Active,
        allows_read: true,
        allows_write: true,
        config_version: 2,
        validated_at: Some(OffsetDateTime::UNIX_EPOCH),
        created_at: OffsetDateTime::UNIX_EPOCH,
        updated_at: OffsetDateTime::UNIX_EPOCH,
    }
}
