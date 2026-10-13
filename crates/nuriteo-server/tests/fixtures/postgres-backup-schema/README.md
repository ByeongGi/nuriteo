# BKP-001 PostgreSQL backup schema fixture

`run.sh` starts the pinned PostgreSQL image with ephemeral TLS material and proves the backup
generation, manifest, retention, digest deduplication and payload-GC database fences.

```sh
./crates/nuriteo-server/tests/fixtures/postgres-backup-schema/run.sh
```

Podman is the default. Set `CONTAINER_RUNTIME=docker` for Docker or
`NURITEO_TEST_DATABASE_PORT=<port>` if port `55447` is occupied. The fixture always removes its
container and temporary certificates.
