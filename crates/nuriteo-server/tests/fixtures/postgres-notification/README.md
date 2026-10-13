# NOT-001 PostgreSQL notification fixture

`run.sh` starts the pinned PostgreSQL image with a generated password and an
ephemeral custom CA. It applies every embedded migration twice, then proves
that an inbox notification and optional email job are committed or rolled back
together. It also checks the channel classification matrix, recursive secret
key rejection, irreversible action transitions, monotonic recurrence history,
linked-message parity, bounded claim/retry/terminal transitions, active-mail
retention fencing, detached preservation of sent/dead-letter/canceled history,
the exact compact JSON 16 KiB boundary, and the absence of durable token/body
columns.

The same custom-CA PostgreSQL run also exercises the authenticated NOT-003
inbox, preference, role isolation, optimistic concurrency, recent-reauth,
redaction, safe retry/cancel, audit, and durable idempotency boundaries.

```sh
./crates/nuriteo-server/tests/fixtures/postgres-notification/run.sh
```

Podman is the default. Set `CONTAINER_RUNTIME=docker` for Docker or
`NURITEO_TEST_DATABASE_PORT=<port>` if port `55464` is occupied. Cleanup removes
the container and all ephemeral password, key, and certificate material.
