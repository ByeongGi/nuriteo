# PRJ-003 PostgreSQL fixture

Runs the Project repository against the pinned PostgreSQL image with an ephemeral custom CA. It verifies User and Organization owners, owner-isolated stable listing, caller-owned rollback, typed namespace/identity/scope conflicts, membership-neutral Organization persistence, and fail-closed reconstruction of deliberately corrupted rows.

```sh
crates/nuriteo-server/tests/fixtures/postgres-project-repository/run.sh
```

Set `CONTAINER_RUNTIME=docker` to use Docker instead of Podman. The fixture removes its container and temporary certificates on exit.
