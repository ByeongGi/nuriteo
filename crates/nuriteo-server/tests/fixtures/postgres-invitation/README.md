# INV-001 PostgreSQL activation invitation fixture

`run.sh` starts the pinned PostgreSQL 17.6 image with ephemeral custom-CA TLS
material and a generated database password, then runs the ignored INV-001
integration test. It verifies fresh and repeated migration, digest-only token
storage, direct-SQL constraints, one pending invitation per normalized email,
forward-only terminal transitions, and same-email replacement lineage against
the real server.

```sh
./crates/nuriteo-server/tests/fixtures/postgres-invitation/run.sh
```

Podman is the default. Set `CONTAINER_RUNTIME=docker` for Docker or
`NURITEO_TEST_DATABASE_PORT=<port>` if port `55444` is occupied. The script
removes its container and ephemeral password, keys, and certificates on exit.
