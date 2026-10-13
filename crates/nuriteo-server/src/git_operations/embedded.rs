//! Embedded libgit2 fetch primitive for the Beta Git adapter.
//!
//! This module never invokes the Git CLI and never writes credentials to the
//! checkout, argv, environment, or URL. Off-site redirects are disabled on
//! every operation. The remaining libgit2 DNS resolver limitation is bounded
//! by the transport guard's public-IP pre/postflight checks.

use std::path::Path;
use std::sync::Arc;
use std::sync::atomic::{AtomicU64, Ordering};
use std::{io::Cursor, time::SystemTime};

use bytes::Bytes;
use git2::{
    CertificateCheckStatus, Cred, ErrorCode, FetchOptions, ObjectType, ProxyOptions, PushOptions,
    RemoteCallbacks, RemoteRedirect, Repository, Signature,
};
use rustls::RootCertStore;
use rustls::client::WebPkiServerVerifier;
use rustls::client::danger::ServerCertVerifier;
use rustls::pki_types::{CertificateDer, ServerName, UnixTime};
use tempfile::TempDir;
use zeroize::Zeroizing;

use super::transport_security::{GitHttpsTransportGuard, PreparedGitHttpsTransport};
use super::{
    GitCredential, GitExecution, GitExecutionFuture, GitExecutorError, GitOperationOutcome,
    GitPushExecution, GitRemoteExecutor, GitUpdateExecution, MAX_CHANGED_OBJECTS,
    MAX_TRANSFER_BYTES,
};

const MAX_TREE_FILES: usize = 2_500;
const MAX_TREE_BYTES: u64 = 256 * 1024 * 1024;
const MAX_FILE_BYTES: usize = 16 * 1024 * 1024;

#[derive(Clone, PartialEq, Eq)]
pub struct GitTreeFile {
    path: String,
    executable: bool,
    content: Bytes,
}

impl std::fmt::Debug for GitTreeFile {
    fn fmt(&self, formatter: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        formatter
            .debug_struct("GitTreeFile")
            .field("path", &self.path)
            .field("executable", &self.executable)
            .field("content_bytes", &self.content.len())
            .finish()
    }
}

impl GitTreeFile {
    pub fn new(
        path: impl Into<String>,
        executable: bool,
        content: Bytes,
    ) -> Result<Self, GitExecutorError> {
        let path = path.into();
        validate_path(&path)?;
        if content.len() > MAX_FILE_BYTES {
            return Err(GitExecutorError::TransferLimitExceeded);
        }
        Ok(Self {
            path,
            executable,
            content,
        })
    }

    #[must_use]
    pub fn path(&self) -> &str {
        &self.path
    }

    #[must_use]
    pub const fn executable(&self) -> bool {
        self.executable
    }

    #[must_use]
    pub fn content(&self) -> &[u8] {
        &self.content
    }
}

#[derive(Clone, Debug, PartialEq, Eq)]
pub struct GitTreeSnapshot {
    files: Vec<GitTreeFile>,
    logical_bytes: u64,
}

impl GitTreeSnapshot {
    pub fn new(mut files: Vec<GitTreeFile>) -> Result<Self, GitExecutorError> {
        if files.len() > MAX_TREE_FILES {
            return Err(GitExecutorError::TransferLimitExceeded);
        }
        files.sort_unstable_by(|left, right| left.path.cmp(&right.path));
        if files.windows(2).any(|pair| pair[0].path == pair[1].path) {
            return Err(GitExecutorError::InvalidRemote);
        }
        let logical_bytes = files.iter().try_fold(0_u64, |total, file| {
            total
                .checked_add(file.content.len() as u64)
                .filter(|value| *value <= MAX_TREE_BYTES)
                .ok_or(GitExecutorError::TransferLimitExceeded)
        })?;
        Ok(Self {
            files,
            logical_bytes,
        })
    }

    #[must_use]
    pub fn files(&self) -> &[GitTreeFile] {
        &self.files
    }

    #[must_use]
    pub const fn logical_bytes(&self) -> u64 {
        self.logical_bytes
    }
}

#[derive(Debug)]
pub struct EmbeddedFetchResult {
    outcome: GitOperationOutcome,
    snapshot: GitTreeSnapshot,
}

pub struct EmbeddedPush<'a> {
    pub branch: String,
    pub credential_username: String,
    pub credential: &'a GitCredential,
    pub expected_remote_head_sha: String,
    pub commit_message: String,
    pub snapshot: GitTreeSnapshot,
}

impl std::fmt::Debug for EmbeddedPush<'_> {
    fn fmt(&self, formatter: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        formatter
            .debug_struct("EmbeddedPush")
            .field("branch", &self.branch)
            .field("credential_username", &self.credential_username)
            .field("credential", &"[REDACTED]")
            .field("expected_remote_head_sha", &self.expected_remote_head_sha)
            .field("commit_message_bytes", &self.commit_message.len())
            .field("snapshot", &self.snapshot)
            .finish()
    }
}

impl EmbeddedFetchResult {
    #[must_use]
    pub fn outcome(&self) -> &GitOperationOutcome {
        &self.outcome
    }

    #[must_use]
    pub fn snapshot(&self) -> &GitTreeSnapshot {
        &self.snapshot
    }

    #[must_use]
    pub fn into_outcome(self) -> GitOperationOutcome {
        self.outcome.with_materialized_tree(self.snapshot)
    }
}

#[derive(Debug, Default, Clone, Copy)]
pub struct EmbeddedGitHttps;

impl EmbeddedGitHttps {
    /// Fetches one exact branch into an ephemeral repository and returns a
    /// bounded, symlink-free snapshot suitable for canonical Bundle encoding.
    pub async fn fetch(
        &self,
        prepared: PreparedGitHttpsTransport,
        branch: String,
        credential_username: String,
        credential: &GitCredential,
        previous_head_sha: Option<String>,
    ) -> Result<EmbeddedFetchResult, GitExecutorError> {
        validate_component(&branch)?;
        validate_username(&credential_username)?;
        prepared.revalidate_dns().await?;
        let token = Arc::new(Zeroizing::new(credential.expose().to_vec()));
        let operation_prepared = prepared.clone();
        let result = tokio::task::spawn_blocking(move || {
            fetch_blocking(
                &operation_prepared,
                &branch,
                &credential_username,
                token,
                previous_head_sha,
            )
        })
        .await
        .map_err(|_| GitExecutorError::Unavailable)??;
        prepared.revalidate_dns().await?;
        Ok(result)
    }

    /// Commits one already-admitted Working Head snapshot and pushes it with an
    /// exact expected remote parent. A concurrent remote update is rejected as
    /// non-fast-forward by both the precondition and the remote receive-pack.
    pub async fn commit_and_push(
        &self,
        prepared: PreparedGitHttpsTransport,
        input: EmbeddedPush<'_>,
    ) -> Result<GitOperationOutcome, GitExecutorError> {
        validate_component(&input.branch)?;
        validate_username(&input.credential_username)?;
        if input.commit_message.is_empty()
            || input.commit_message.len() > 10 * 1024
            || input.commit_message.contains('\0')
        {
            return Err(GitExecutorError::InvalidRemote);
        }
        prepared.revalidate_dns().await?;
        let token = Arc::new(Zeroizing::new(input.credential.expose().to_vec()));
        let EmbeddedPush {
            branch,
            credential_username,
            credential: _,
            expected_remote_head_sha,
            commit_message,
            snapshot,
        } = input;
        let operation_prepared = prepared.clone();
        let result = tokio::task::spawn_blocking(move || {
            push_blocking(
                &operation_prepared,
                &branch,
                &credential_username,
                token,
                &expected_remote_head_sha,
                &commit_message,
                &snapshot,
            )
        })
        .await
        .map_err(|_| GitExecutorError::Unavailable)??;
        prepared.revalidate_dns().await?;
        Ok(result)
    }
}

#[derive(Clone)]
pub struct EmbeddedGitRemoteExecutor {
    guard: GitHttpsTransportGuard,
    transport: EmbeddedGitHttps,
}

impl std::fmt::Debug for EmbeddedGitRemoteExecutor {
    fn fmt(&self, formatter: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        formatter
            .debug_struct("EmbeddedGitRemoteExecutor")
            .field("guard", &self.guard)
            .finish_non_exhaustive()
    }
}

impl EmbeddedGitRemoteExecutor {
    #[must_use]
    pub fn new(guard: GitHttpsTransportGuard) -> Self {
        Self {
            guard,
            transport: EmbeddedGitHttps,
        }
    }
}

impl GitRemoteExecutor for EmbeddedGitRemoteExecutor {
    fn import<'a>(&'a self, input: GitExecution<'a>) -> GitExecutionFuture<'a> {
        Box::pin(async move {
            let prepared = self
                .guard
                .prepare(input.provider, input.repository_url)
                .await?;
            self.transport
                .fetch(
                    prepared,
                    input.branch.to_owned(),
                    credential_username(input.provider.kind).to_owned(),
                    input.credential,
                    None,
                )
                .await
                .map(EmbeddedFetchResult::into_outcome)
        })
    }

    fn pull<'a>(&'a self, input: GitUpdateExecution<'a>) -> GitExecutionFuture<'a> {
        Box::pin(async move {
            let prepared = self
                .guard
                .prepare(input.remote.provider, input.remote.repository_url)
                .await?;
            self.transport
                .fetch(
                    prepared,
                    input.remote.branch.to_owned(),
                    credential_username(input.remote.provider.kind).to_owned(),
                    input.remote.credential,
                    Some(input.expected_remote_head_sha.to_owned()),
                )
                .await
                .map(EmbeddedFetchResult::into_outcome)
        })
    }

    fn commit_and_push<'a>(&'a self, input: GitPushExecution<'a>) -> GitExecutionFuture<'a> {
        Box::pin(async move {
            let prepared = self
                .guard
                .prepare(
                    input.update.remote.provider,
                    input.update.remote.repository_url,
                )
                .await?;
            self.transport
                .commit_and_push(
                    prepared,
                    EmbeddedPush {
                        branch: input.update.remote.branch.to_owned(),
                        credential_username: credential_username(input.update.remote.provider.kind)
                            .to_owned(),
                        credential: input.update.remote.credential,
                        expected_remote_head_sha: input.update.expected_remote_head_sha.to_owned(),
                        commit_message: input.commit_message.to_owned(),
                        snapshot: input.working_tree.clone(),
                    },
                )
                .await
        })
    }
}

const fn credential_username(kind: crate::git_provider::GitProviderKind) -> &'static str {
    match kind {
        crate::git_provider::GitProviderKind::GitHub
        | crate::git_provider::GitProviderKind::GitHubEnterprise => "x-access-token",
        crate::git_provider::GitProviderKind::GitLab
        | crate::git_provider::GitProviderKind::GitLabSelfManaged => "oauth2",
        crate::git_provider::GitProviderKind::Generic => "git",
    }
}

fn fetch_blocking(
    prepared: &PreparedGitHttpsTransport,
    branch: &str,
    username: &str,
    token: Arc<Zeroizing<Vec<u8>>>,
    previous_head_sha: Option<String>,
) -> Result<EmbeddedFetchResult, GitExecutorError> {
    let workspace = TempDir::new().map_err(|_| GitExecutorError::Unavailable)?;
    let repository = Repository::init(workspace.path()).map_err(map_git_error)?;
    configure_repository(&repository, prepared.custom_ca_pem())?;

    let expected_url = prepared.repository_url().as_str().to_owned();
    let expected_host = prepared
        .repository_url()
        .host_str()
        .ok_or(GitExecutorError::InvalidRemote)?
        .to_owned();
    let mut callbacks = remote_callbacks(
        expected_url.clone(),
        expected_host,
        username.to_owned(),
        token,
        prepared.custom_ca_pem(),
    );
    callbacks.transfer_progress(|progress| {
        progress.received_objects() as u64 <= MAX_CHANGED_OBJECTS
            && progress.received_bytes() as u64 <= MAX_TRANSFER_BYTES
    });

    let proxy = ProxyOptions::new();
    let mut options = FetchOptions::new();
    options
        .remote_callbacks(callbacks)
        .proxy_options(proxy)
        .follow_redirects(RemoteRedirect::None)
        .download_tags(git2::AutotagOption::None);
    let mut remote = repository
        .remote_anonymous(&expected_url)
        .map_err(map_git_error)?;
    let refspec = format!("+refs/heads/{branch}:refs/remotes/nuriteo/{branch}");
    remote
        .fetch(&[refspec.as_str()], Some(&mut options), None)
        .map_err(map_git_error)?;
    let stats = remote.stats();
    let changed_objects = stats.received_objects() as u64;
    let transferred_bytes = stats.received_bytes() as u64;
    if changed_objects > MAX_CHANGED_OBJECTS || transferred_bytes > MAX_TRANSFER_BYTES {
        return Err(GitExecutorError::TransferLimitExceeded);
    }
    drop(remote);

    let reference = repository
        .find_reference(&format!("refs/remotes/nuriteo/{branch}"))
        .map_err(map_git_error)?;
    let commit = reference.peel_to_commit().map_err(map_git_error)?;
    let head_sha = commit.id().to_string();
    let tree = commit.tree().map_err(map_git_error)?;
    let snapshot = snapshot_tree(&repository, &tree)?;
    let outcome = GitOperationOutcome::new(
        previous_head_sha,
        head_sha,
        changed_objects,
        transferred_bytes,
    )
    .map_err(|_| GitExecutorError::TransferLimitExceeded)?;
    Ok(EmbeddedFetchResult { outcome, snapshot })
}

#[allow(
    clippy::too_many_arguments,
    reason = "the blocking boundary keeps the validated Git operation inputs explicit"
)]
fn push_blocking(
    prepared: &PreparedGitHttpsTransport,
    branch: &str,
    username: &str,
    token: Arc<Zeroizing<Vec<u8>>>,
    expected_remote_head_sha: &str,
    commit_message: &str,
    snapshot: &GitTreeSnapshot,
) -> Result<GitOperationOutcome, GitExecutorError> {
    let workspace = TempDir::new().map_err(|_| GitExecutorError::Unavailable)?;
    let repository = Repository::init(workspace.path()).map_err(map_git_error)?;
    configure_repository(&repository, prepared.custom_ca_pem())?;
    let url = prepared.repository_url().as_str().to_owned();
    let host = prepared
        .repository_url()
        .host_str()
        .ok_or(GitExecutorError::InvalidRemote)?
        .to_owned();
    let refspec = format!("+refs/heads/{branch}:refs/remotes/nuriteo/{branch}");
    {
        let callbacks = remote_callbacks(
            url.clone(),
            host.clone(),
            username.to_owned(),
            token.clone(),
            prepared.custom_ca_pem(),
        );
        let proxy = ProxyOptions::new();
        let mut options = FetchOptions::new();
        options
            .remote_callbacks(callbacks)
            .proxy_options(proxy)
            .follow_redirects(RemoteRedirect::None)
            .download_tags(git2::AutotagOption::None);
        let mut remote = repository.remote_anonymous(&url).map_err(map_git_error)?;
        remote
            .fetch(&[refspec.as_str()], Some(&mut options), None)
            .map_err(map_git_error)?;
    }
    let remote_ref = repository
        .find_reference(&format!("refs/remotes/nuriteo/{branch}"))
        .map_err(map_git_error)?;
    let parent = remote_ref.peel_to_commit().map_err(map_git_error)?;
    if parent.id().to_string() != expected_remote_head_sha {
        return Err(GitExecutorError::NonFastForward);
    }
    materialize_snapshot(workspace.path(), snapshot)?;
    let mut index = repository.index().map_err(map_git_error)?;
    index
        .add_all(["."], git2::IndexAddOption::FORCE, None)
        .map_err(map_git_error)?;
    index.write().map_err(map_git_error)?;
    let tree_id = index.write_tree().map_err(map_git_error)?;
    let tree = repository.find_tree(tree_id).map_err(map_git_error)?;
    let signature = Signature::now("Nuriteo", "noreply@nuriteo.invalid").map_err(map_git_error)?;
    let local_ref = format!("refs/heads/{branch}");
    let commit_id = repository
        .commit(
            Some(&local_ref),
            &signature,
            &signature,
            commit_message,
            &tree,
            &[&parent],
        )
        .map_err(map_git_error)?;
    let pushed_bytes = Arc::new(AtomicU64::new(0));
    let progress_bytes = pushed_bytes.clone();
    let mut callbacks = remote_callbacks(
        url.clone(),
        host,
        username.to_owned(),
        token,
        prepared.custom_ca_pem(),
    );
    let rejected = Arc::new(std::sync::atomic::AtomicBool::new(false));
    let rejected_callback = rejected.clone();
    callbacks.push_transfer_progress(move |_, _, bytes| {
        progress_bytes.store(bytes as u64, Ordering::Relaxed);
    });
    callbacks.push_update_reference(move |_, status| {
        if status.is_some() {
            rejected_callback.store(true, Ordering::Relaxed);
            Err(git2::Error::from_str("remote rejected update"))
        } else {
            Ok(())
        }
    });
    let proxy = ProxyOptions::new();
    let mut options = PushOptions::new();
    options
        .remote_callbacks(callbacks)
        .proxy_options(proxy)
        .follow_redirects(RemoteRedirect::None);
    let mut remote = repository.remote_anonymous(&url).map_err(map_git_error)?;
    let push_refspec = format!("{local_ref}:refs/heads/{branch}");
    if let Err(error) = remote.push(&[push_refspec.as_str()], Some(&mut options)) {
        if rejected.load(Ordering::Relaxed) {
            return Err(GitExecutorError::NonFastForward);
        }
        return Err(map_git_error(error));
    }
    let transferred_bytes = pushed_bytes.load(Ordering::Relaxed);
    GitOperationOutcome::new(
        Some(expected_remote_head_sha.to_owned()),
        commit_id.to_string(),
        snapshot.files().len() as u64,
        transferred_bytes,
    )
    .map_err(|_| GitExecutorError::TransferLimitExceeded)
}

fn remote_callbacks(
    expected_url: String,
    expected_host: String,
    username: String,
    token: Arc<Zeroizing<Vec<u8>>>,
    custom_ca_pem: Option<&[u8]>,
) -> RemoteCallbacks<'static> {
    let custom_verifier = custom_ca_pem.map(build_custom_ca_verifier);
    let mut callbacks = RemoteCallbacks::new();
    callbacks.credentials(move |url, _, allowed| {
        if url != expected_url || !allowed.is_user_pass_plaintext() {
            return Err(git2::Error::from_str("credential scope denied"));
        }
        let token = std::str::from_utf8(token.as_slice())
            .map_err(|_| git2::Error::from_str("credential is not UTF-8"))?;
        Cred::userpass_plaintext(&username, token)
    });
    callbacks.certificate_check(move |certificate, host| {
        if !host.eq_ignore_ascii_case(&expected_host) {
            return Err(git2::Error::from_str("certificate host scope denied"));
        }
        let Some(verifier) = custom_verifier.as_ref() else {
            return Ok(CertificateCheckStatus::CertificatePassthrough);
        };
        let verifier = verifier
            .as_ref()
            .map_err(|_| git2::Error::from_str("custom CA verifier is invalid"))?;
        let x509 = certificate
            .as_x509()
            .ok_or_else(|| git2::Error::from_str("expected X.509 server certificate"))?;
        let server_name = ServerName::try_from(expected_host.clone())
            .map_err(|_| git2::Error::from_str("invalid certificate host"))?;
        verifier
            .verify_server_cert(
                &CertificateDer::from(x509.data()),
                &[],
                &server_name,
                &[],
                UnixTime::since_unix_epoch(
                    SystemTime::now()
                        .duration_since(SystemTime::UNIX_EPOCH)
                        .map_err(|_| git2::Error::from_str("invalid system clock"))?,
                ),
            )
            .map_err(|_| git2::Error::from_str("custom CA verification failed"))?;
        Ok(CertificateCheckStatus::CertificateOk)
    });
    callbacks
}

fn build_custom_ca_verifier(pem: &[u8]) -> Result<Arc<WebPkiServerVerifier>, ()> {
    let certificates = rustls_pemfile::certs(&mut Cursor::new(pem))
        .collect::<Result<Vec<_>, _>>()
        .map_err(|_| ())?;
    if certificates.is_empty() {
        return Err(());
    }
    let mut roots = RootCertStore::empty();
    for certificate in certificates {
        roots.add(certificate).map_err(|_| ())?;
    }
    WebPkiServerVerifier::builder_with_provider(
        Arc::new(roots),
        Arc::new(rustls::crypto::ring::default_provider()),
    )
    .build()
    .map_err(|_| ())
}

fn materialize_snapshot(root: &Path, snapshot: &GitTreeSnapshot) -> Result<(), GitExecutorError> {
    for file in snapshot.files() {
        validate_path(file.path())?;
        let path = root.join(file.path());
        if let Some(parent) = path.parent() {
            std::fs::create_dir_all(parent).map_err(|_| GitExecutorError::Unavailable)?;
        }
        std::fs::write(&path, file.content()).map_err(|_| GitExecutorError::Unavailable)?;
        #[cfg(unix)]
        if file.executable() {
            use std::os::unix::fs::PermissionsExt as _;
            std::fs::set_permissions(&path, std::fs::Permissions::from_mode(0o755))
                .map_err(|_| GitExecutorError::Unavailable)?;
        }
    }
    Ok(())
}

fn configure_repository(
    repository: &Repository,
    ca_pem: Option<&[u8]>,
) -> Result<(), GitExecutorError> {
    let mut config = repository.config().map_err(map_git_error)?;
    config
        .set_bool("http.followRedirects", false)
        .map_err(map_git_error)?;
    // libgit2 has no cancellable async API. Bound stalled sockets inside the
    // transport so dropping the outer Tokio timeout cannot leave an indefinite
    // blocking worker behind.
    config
        .set_i64("http.lowSpeedLimit", 1)
        .map_err(map_git_error)?;
    config
        .set_i64("http.lowSpeedTime", 15)
        .map_err(map_git_error)?;
    if let Some(pem) = ca_pem {
        let path = repository.path().join("nuriteo-git-ca.pem");
        std::fs::write(&path, pem).map_err(|_| GitExecutorError::Unavailable)?;
        config
            .set_str(
                "http.sslCAInfo",
                path.to_str().ok_or(GitExecutorError::Unavailable)?,
            )
            .map_err(map_git_error)?;
    }
    Ok(())
}

fn snapshot_tree(
    repository: &Repository,
    tree: &git2::Tree<'_>,
) -> Result<GitTreeSnapshot, GitExecutorError> {
    let mut files = Vec::new();
    let mut logical_bytes = 0_u64;
    visit_tree(repository, tree, "", &mut files, &mut logical_bytes)?;
    let snapshot = GitTreeSnapshot::new(files)?;
    if snapshot.logical_bytes != logical_bytes {
        return Err(GitExecutorError::InvalidRemote);
    }
    Ok(snapshot)
}

fn visit_tree(
    repository: &Repository,
    tree: &git2::Tree<'_>,
    prefix: &str,
    files: &mut Vec<GitTreeFile>,
    logical_bytes: &mut u64,
) -> Result<(), GitExecutorError> {
    for entry in tree {
        let name = entry.name().map_err(|_| GitExecutorError::InvalidRemote)?;
        let path = if prefix.is_empty() {
            name.to_owned()
        } else {
            format!("{prefix}/{name}")
        };
        validate_path(&path)?;
        match entry.kind() {
            Some(ObjectType::Tree) => {
                let subtree = repository.find_tree(entry.id()).map_err(map_git_error)?;
                visit_tree(repository, &subtree, &path, files, logical_bytes)?;
            }
            Some(ObjectType::Blob) if matches!(entry.filemode(), 0o100644 | 0o100755) => {
                let blob = repository.find_blob(entry.id()).map_err(map_git_error)?;
                if blob.size() > MAX_FILE_BYTES || files.len() >= MAX_TREE_FILES {
                    return Err(GitExecutorError::TransferLimitExceeded);
                }
                *logical_bytes = logical_bytes
                    .checked_add(blob.size() as u64)
                    .filter(|value| *value <= MAX_TREE_BYTES)
                    .ok_or(GitExecutorError::TransferLimitExceeded)?;
                files.push(GitTreeFile {
                    path,
                    executable: entry.filemode() == 0o100755,
                    content: Bytes::copy_from_slice(blob.content()),
                });
            }
            // Symlinks, submodules and unknown object kinds cannot be safely
            // represented by project-bundle-v1 and fail closed.
            _ => return Err(GitExecutorError::InvalidRemote),
        }
    }
    Ok(())
}

fn validate_component(value: &str) -> Result<(), GitExecutorError> {
    if value.is_empty()
        || value.len() > 255
        || value.contains("..")
        || value.bytes().any(|byte| {
            byte.is_ascii_control()
                || byte.is_ascii_whitespace()
                || matches!(byte, b'~' | b'^' | b':' | b'?' | b'*' | b'[' | b'\\')
        })
    {
        Err(GitExecutorError::InvalidRemote)
    } else {
        Ok(())
    }
}

fn validate_username(value: &str) -> Result<(), GitExecutorError> {
    if value.is_empty()
        || value.len() > 256
        || value
            .bytes()
            .any(|byte| byte.is_ascii_control() || byte.is_ascii_whitespace() || byte == b':')
    {
        Err(GitExecutorError::InvalidRemote)
    } else {
        Ok(())
    }
}

fn validate_path(value: &str) -> Result<(), GitExecutorError> {
    if value.is_empty()
        || value.len() > 512
        || value.starts_with('/')
        || value.contains('\\')
        || value.chars().any(char::is_control)
        || value.split('/').any(|part| {
            part.is_empty() || part == "." || part == ".." || part.len() > 255 || part == ".git"
        })
    {
        Err(GitExecutorError::InvalidRemote)
    } else {
        Ok(())
    }
}

fn map_git_error(error: git2::Error) -> GitExecutorError {
    match error.code() {
        ErrorCode::Auth => GitExecutorError::AuthenticationFailed,
        ErrorCode::NotFastForward => GitExecutorError::NonFastForward,
        ErrorCode::User => GitExecutorError::TransferLimitExceeded,
        _ => GitExecutorError::RepositoryUnavailable,
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use git2::Signature;

    #[test]
    fn local_git_tree_materializes_regular_files_without_metadata() {
        let workspace = TempDir::new().unwrap();
        let repository = Repository::init(workspace.path()).unwrap();
        std::fs::create_dir_all(workspace.path().join("src")).unwrap();
        std::fs::write(workspace.path().join("README.md"), b"hello\n").unwrap();
        std::fs::write(workspace.path().join("src/main.rs"), b"fn main() {}\n").unwrap();
        let mut index = repository.index().unwrap();
        index
            .add_all(["*"], git2::IndexAddOption::DEFAULT, None)
            .unwrap();
        index.write().unwrap();
        let tree_id = index.write_tree().unwrap();
        let tree = repository.find_tree(tree_id).unwrap();
        let signature = Signature::now("Nuriteo", "noreply@nuriteo.invalid").unwrap();
        repository
            .commit(Some("HEAD"), &signature, &signature, "fixture", &tree, &[])
            .unwrap();
        let snapshot = snapshot_tree(&repository, &tree).unwrap();
        assert_eq!(snapshot.files().len(), 2);
        assert_eq!(snapshot.logical_bytes(), 19);
        assert_eq!(snapshot.files()[0].path(), "README.md");
        assert_eq!(snapshot.files()[1].path(), "src/main.rs");
    }

    #[test]
    fn paths_and_credentials_fail_closed() {
        for path in ["", "../secret", ".git/config", "a\\b", "/root"] {
            assert_eq!(validate_path(path), Err(GitExecutorError::InvalidRemote));
        }
        for username in ["", "user:name", "user name", "user\nname"] {
            assert_eq!(
                validate_username(username),
                Err(GitExecutorError::InvalidRemote)
            );
        }
    }

    #[test]
    fn repository_transport_configuration_disables_redirects_and_bounds_stalls() {
        let workspace = TempDir::new().unwrap();
        let repository = Repository::init(workspace.path()).unwrap();
        configure_repository(&repository, Some(b"test-ca-material")).unwrap();
        let config = repository.config().unwrap();
        assert!(!config.get_bool("http.followRedirects").unwrap());
        assert_eq!(config.get_i64("http.lowSpeedLimit").unwrap(), 1);
        assert_eq!(config.get_i64("http.lowSpeedTime").unwrap(), 15);
        assert!(repository.path().join("nuriteo-git-ca.pem").is_file());
        assert!(!workspace.path().join("nuriteo-git-ca.pem").exists());
    }

    #[test]
    fn provider_credentials_use_non_secret_fixed_usernames() {
        use crate::git_provider::GitProviderKind;
        assert_eq!(
            credential_username(GitProviderKind::GitHub),
            "x-access-token"
        );
        assert_eq!(credential_username(GitProviderKind::GitLab), "oauth2");
        assert_eq!(credential_username(GitProviderKind::Generic), "git");
    }

    #[test]
    fn malformed_custom_ca_never_falls_back_to_system_roots() {
        assert!(build_custom_ca_verifier(b"not a PEM certificate").is_err());
        assert!(build_custom_ca_verifier(b"").is_err());
    }
}
