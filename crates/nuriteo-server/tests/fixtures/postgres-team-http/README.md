# PostgreSQL Team HTTP fixture

Runs the Team browser API journey against a digest-pinned PostgreSQL instance with a generated
custom CA. It verifies Session and CSRF enforcement, strong entity ETags, stale-write rejection,
private no-store responses, membership mutation, and durable audit records.

```sh
./crates/nuriteo-server/tests/fixtures/postgres-team-http/run.sh
```

Set `CONTAINER_RUNTIME=docker` to use Docker instead of Podman.
