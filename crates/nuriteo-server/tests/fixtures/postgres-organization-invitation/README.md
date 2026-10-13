# ORG-003 PostgreSQL Organization invitation fixture

Runs the Organization invitation lifecycle against pinned PostgreSQL 17.6 with
ephemeral custom-CA TLS. It covers migration 1..8, role-bound issue/reissue,
recent reauthentication, digest-only credentials, accept membership atomicity,
decline/revoke/expiry, terminal races, replay and audit rollback.

```sh
./crates/nuriteo-server/tests/fixtures/postgres-organization-invitation/run.sh
```

Podman is the default. Set `CONTAINER_RUNTIME=docker` or override
`NURITEO_TEST_DATABASE_PORT`. Cleanup removes the container and generated
password/TLS material.
