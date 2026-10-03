# ID-004 PostgreSQL bootstrap fixture

`run.sh` starts the repository-pinned PostgreSQL 17.6 image, configures a
short-lived custom certificate authority and server certificate, and runs the
ignored `bootstrap_admin` integration test against `verify-full` TLS.

The test covers schema-readiness refusal, a fresh file-first bootstrap, ten
concurrent CLI invocations, deterministic repeat and disabled-admin no-ops,
Argon2id verification, plaintext absence, and credential/audit failure
rollback. The cleanup trap removes the container and temporary TLS/secret
material on success or failure.

Run from the repository root:

```sh
./crates/nuriteo-server/tests/fixtures/postgres-bootstrap/run.sh
```
