# INV-002 PostgreSQL invitation lifecycle fixture

`run.sh` starts the pinned PostgreSQL 17.6 image with ephemeral custom-CA TLS
and a generated password, then runs the ignored INV-002 lifecycle service test.
It covers atomic issue/reissue/revoke/accept, concurrent terminal races,
activator and audit rollback, digest-only persistence, and replay rejection.

```sh
./crates/nuriteo-server/tests/fixtures/postgres-invitation-service/run.sh
```

Podman is the default. Set `CONTAINER_RUNTIME=docker` for Docker or
`NURITEO_TEST_DATABASE_PORT=<port>` if port `55445` is occupied. The cleanup
trap removes the container and ephemeral password, CA, and server key.
