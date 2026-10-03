# CLIENT-002 Core/PostgreSQL live contract fixture

`run.sh` starts pinned PostgreSQL 17.6 with an ephemeral custom CA and pinned RustFS with HTTPS, runs the real migration and `bootstrap-admin` commands, and starts the production Core binary. The TypeScript fixture then exercises only the public API client operations:

`createSession` → `getCurrentUser` → `getCurrentWorkspaces` → `deleteSession` → rejected `getCurrentUser`.

The fixture keeps the cookie jar and CSRF credential inside its browser-boundary adapter. Domain operation results never contain response headers, cookies, passwords, or CSRF values.

Run from the repository root:

```sh
packages/api-client/test/fixtures/core-postgres/run.sh
```

Set `CONTAINER_RUNTIME=docker` when Podman is not available. The fixture requires OpenSSL, curl with AWS SigV4 support, Cargo, and Node 22.23.0 through mise.
