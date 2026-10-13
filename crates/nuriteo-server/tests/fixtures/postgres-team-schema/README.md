# TEAM-001 PostgreSQL Team schema fixture

`run.sh` starts the pinned PostgreSQL image with an ephemeral custom CA, server
certificate, and generated password. It applies all embedded migrations twice
and verifies Team identity, Organization membership dependency, the
`Maintainer/Member` and `Read/Write/Admin` role matrices, same-Organization
Project binding, lifecycle constraints, inactive-principal fail-closed behavior,
exact optimistic locking, indexes, and the rule that Teams never own Projects.
This is a constraint fixture; production effective-role resolution is covered by
the Team domain tests.

```sh
./crates/nuriteo-server/tests/fixtures/postgres-team-schema/run.sh
```

Podman is the default. Set `CONTAINER_RUNTIME=docker` for Docker or
`NURITEO_TEST_DATABASE_PORT=<port>` if port `55463` is occupied. Cleanup removes
the container and all ephemeral password, key, and certificate material.
