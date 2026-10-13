# DB-003 schema readiness and migrate CLI fixture

`run.sh` starts pinned PostgreSQL 17.6 with an ephemeral TLS CA and executes the
ignored DB-003 test. The test launches the real `nuriteo-server migrate`
subprocess against fresh, repeated, stale, dirty, checksum-mismatch and
unsupported schema histories. Both direct and `_FILE` database URL inputs are
covered.

```sh
./crates/nuriteo-server/tests/fixtures/postgres-readiness/run.sh
```

Podman is the default. Set `CONTAINER_RUNTIME=docker` for Docker or
`NURITEO_TEST_DATABASE_PORT=<port>` when port `55434` is occupied. The fixture
removes the container, certificates and URL secret file on exit.
