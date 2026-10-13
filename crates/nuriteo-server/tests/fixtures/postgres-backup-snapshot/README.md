# BKP-002 synchronized backup snapshot fixture

The fixture runs PostgreSQL 17.6 with custom-CA TLS. It exports a repeatable-read snapshot, performs
an online Project/Bundle mutation, and proves that both the real `pg_dump` custom archive and the
object inventory retain the pre-mutation view. It also exercises the active-generation GC fence and
the one-time snapshot/expectation transition.

```sh
./crates/nuriteo-server/tests/fixtures/postgres-backup-snapshot/run.sh
```

Podman is the default. Set `CONTAINER_RUNTIME=docker` or override
`NURITEO_TEST_DATABASE_PORT` when needed. Containers, archives and certificates are ephemeral.
