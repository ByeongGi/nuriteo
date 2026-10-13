# GIT-002 actual HTTPS fixture contract

The release fixture for the embedded Git adapter must use a real HTTPS smart
Git origin and a second HTTPS redirect sink, each with a fixture-local CA. It
must exercise the same embedded executor and S3 Working Head composition used
by `GitOperationService::production`. The fixture CGI uses `git-http-backend`
only to act as the remote server; the application path never invokes it.

The fixture is complete only when it proves all of these boundaries:

- import materializes the remote tree as `project-bundle-v1`, uploads it to the
  S3-compatible fixture, admits that exact Bundle, and atomically advances the
  Project Working Head;
- pull repeats that flow for a new remote commit and rotates the prior Working
  Head into the bounded recovery checkpoints;
- push decodes the current Working Head Bundle, creates a commit with embedded
  libgit2, and advances both the origin and the fenced database binding;
- a competing origin commit returns the typed non-fast-forward result without
  changing the local binding;
- an origin redirect is rejected, and the redirect sink records zero
  `Authorization` headers and zero credential callbacks;
- the registered custom CA succeeds;
- a forced failure after the origin accepts a push returns
  `CommitOutcomeUnknown`, suitable for reconciliation rather than blind retry.

Untrusted certificates, private/special production DNS answers, exact-origin
mismatch, transfer overflow, timeout, and credential callback scoping are
covered by the deterministic transport unit suite. Multipart cancellation and
ledger cleanup are owned by the save-cleanup fixture; they are not claims made
by this smart-Git fixture.

The fixture pins its PostgreSQL and S3-compatible store image digests. The Git
origin is a local TLS CGI bridge over the host's `git-http-backend`, so its
version is printed by the runner and must be captured with release evidence.
Generated credentials and certificate material belong only in its temporary
directory and are removed by the fixture trap.

The remaining Beta/RC transport exception is libgit2's lack of an injectable
DNS resolver: public-IP preflight and postflight narrow, but cannot eliminate,
DNS rebinding between resolution and connect. GA requires a transport with a
pinned resolver/connect target (or an upstream libgit2 capability that provides
the same guarantee), followed by this fixture passing unchanged.

The macOS libgit2 backend does not honor repository-local `http.sslCAInfo`
consistently, so Nuriteo additionally verifies the presented leaf certificate
against the endpoint-bound CA with rustls before accepting it. libgit2 exposes
only the leaf to this callback; custom-CA deployments must therefore present a
leaf signed directly by one of the configured CA certificates. Intermediate
custom-CA chains remain fail-closed until the transport exposes the peer chain.

`run.sh` exercises the embedded adapter against a fixture-local CA, authenticated
smart-HTTP origin, and distinct redirect sink. `run-credentials.sh` separately
uses the pinned PostgreSQL image to prove stale reauthentication cannot create,
rotate, or delete either side of the encrypted Git credential binding.
