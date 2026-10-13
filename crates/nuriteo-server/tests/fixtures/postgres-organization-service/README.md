# ORG-002 PostgreSQL Organization service fixture

Runs the Organization lifecycle and membership service against pinned PostgreSQL
17.6 with ephemeral custom-CA TLS. The fixture verifies creator-owner and audit
atomicity, owner/admin authorization, strong versions, audit rollback, archived
write rejection, and a concurrent last-owner downgrade race.

```sh
./crates/nuriteo-server/tests/fixtures/postgres-organization-service/run.sh
```

Podman is the default. Set `CONTAINER_RUNTIME=docker` or override
`NURITEO_TEST_DATABASE_PORT`. Cleanup removes the container and all generated
password and TLS material.
