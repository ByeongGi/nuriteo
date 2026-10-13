# AUD-001 PostgreSQL audit writer fixture

`run.sh` starts the pinned PostgreSQL 17.6 image with ephemeral TLS material and
a generated database password, then runs the ignored AUD-001 integration test.
It verifies mutation and event commit, caller rollback, audit failure rollback,
stable error categories and retention of actor context after User deletion.

```sh
./crates/nuriteo-server/tests/fixtures/postgres-audit/run.sh
```

Podman is the default. Set `CONTAINER_RUNTIME=docker` for Docker or
`NURITEO_TEST_DATABASE_PORT=<port>` if port `55437` is occupied. The script
removes its container and ephemeral credentials and certificates on exit.
