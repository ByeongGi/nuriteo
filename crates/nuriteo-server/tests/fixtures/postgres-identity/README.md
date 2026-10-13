# ID-001 PostgreSQL identity schema fixture

`run.sh` starts the pinned PostgreSQL 17.6 image with ephemeral TLS material and
a generated database password, then runs the ignored ID-001 integration test.
It verifies fresh and repeated migration, failed-migration rollback, schema
readiness, identity/session/audit constraints, foreign-key deletion behavior and
the required query indexes against the real server.

```sh
./crates/nuriteo-server/tests/fixtures/postgres-identity/run.sh
```

Podman is the default. Set `CONTAINER_RUNTIME=docker` for Docker or
`NURITEO_TEST_DATABASE_PORT=<port>` if port `55435` is occupied. The script
removes its container and ephemeral credentials and certificates on exit.
