# ORG-001 PostgreSQL Organization fixture

`run.sh` starts the pinned PostgreSQL 17.6 image with an ephemeral custom CA,
server certificate, and generated database password. It runs migration 7 twice
and verifies Organization identity, immutable canonical slug, lifecycle,
optimistic-lock shape, membership roles, uniqueness, foreign-key preservation,
and schema/index parity against the real server.

```sh
./crates/nuriteo-server/tests/fixtures/postgres-organization/run.sh
```

Podman is the default. Set `CONTAINER_RUNTIME=docker` for Docker or
`NURITEO_TEST_DATABASE_PORT=<port>` if port `55447` is occupied. Cleanup removes
the container and all ephemeral password, key, and certificate material.
