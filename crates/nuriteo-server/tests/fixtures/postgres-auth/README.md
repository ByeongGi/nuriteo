# AUTH-001 PostgreSQL TLS HTTP fixture

`run.sh` starts the pinned PostgreSQL 17.11 image, creates an ephemeral custom CA and server certificate, enables PostgreSQL TLS, runs embedded migrations, and exercises the local login, `/me`, and logout HTTP slice against the real database.

```sh
crates/nuriteo-server/tests/fixtures/postgres-auth/run.sh
```

Set `CONTAINER_RUNTIME=docker` when Podman is unavailable. `NURITEO_TEST_DATABASE_PORT` overrides the default loopback port `55440`.
