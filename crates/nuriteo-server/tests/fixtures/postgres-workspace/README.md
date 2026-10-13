# WS-001 PostgreSQL fixture

Runs migration/backfill, constraint, concurrent provision, invitation activation, and bootstrap atomicity checks against a disposable pinned PostgreSQL 17.6 container with a generated private CA and verified TLS identity.

```sh
./crates/nuriteo-server/tests/fixtures/postgres-workspace/run.sh
```

Set `CONTAINER_RUNTIME=docker` to use Docker instead of Podman. The fixture removes its container and temporary certificates/password file on success or failure.
