# DB-002 PostgreSQL migration fixture

`run.sh` starts the pinned PostgreSQL 17.6 image with ephemeral TLS material,
then runs the ignored DB-002 migration integration test against the real server.
The test covers concurrent runners, advisory-lock timeout, transaction rollback,
retry/idempotency, execution timeout, checksum mismatch, and a missing embedded
version.

```sh
./crates/nuriteo-server/tests/fixtures/postgres-migrations/run.sh
```

Podman is the default. Set `CONTAINER_RUNTIME=docker` for Docker or
`NURITEO_TEST_DATABASE_PORT=<port>` if port `55433` is occupied. The script
removes its container and ephemeral certificates on exit.
