# DB-001 PostgreSQL fixture

`run.sh` starts the pinned PostgreSQL 17.6 image, enables TLS with an ephemeral
CA whose server certificate covers `localhost` and `127.0.0.1`, then runs the
ignored real-database integration test. It requires Podman (default) or Docker,
OpenSSL, and port `55432`.

```sh
./crates/nuriteo-server/tests/fixtures/postgres/run.sh
```

Set `CONTAINER_RUNTIME=docker` to use Docker or
`NURITEO_TEST_DATABASE_PORT=<port>` when the default port is occupied. The
script removes its container and certificate directory on exit.
