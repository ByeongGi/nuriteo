# TEAM-002 PostgreSQL Team service fixture

`run.sh` starts the digest-pinned PostgreSQL image with a generated password and
custom CA, applies all embedded migrations, and runs the Team service integration
test. The test covers Owner, Maintainer, Member, and Instance Administrator
authorization; optimistic-lock races; Project-binding escalation prevention; and
same-transaction audit rollback. It also proves that archived Organizations and
Projects reject binding removal without deleting the row, and that concurrent
Project Admin mutations across two Teams and two Projects complete within a
bounded deadline instead of entering a SHARE-to-UPDATE deadlock.

```sh
./crates/nuriteo-server/tests/fixtures/postgres-team-service/run.sh
```

Podman is the default. Set `CONTAINER_RUNTIME=docker` for Docker or
`NURITEO_TEST_DATABASE_PORT=<port>` if port `55464` is occupied. Cleanup removes
the container and ephemeral password, key, and certificate material.
