# CLIENT-002 Core/PostgreSQL live contract fixture

`run.sh` starts pinned PostgreSQL 17.6 with an ephemeral custom CA and pinned RustFS with HTTPS, runs the real migration and starts the production Core binary. It verifies public setup status before and after the real CLI-only `bootstrap-admin` command, then exercises the authenticated API client operations:

`getSetupStatus(true)` → CLI bootstrap → `getSetupStatus(false)` → `createSession` → `getCurrentUser` → `getCurrentWorkspaces` → `deleteSession` → rejected `getCurrentUser`.

The setup assertion also checks the actual HTTP `Cache-Control: no-store`, JSON content type, and exact one-boolean response. The fixture keeps the cookie jar and CSRF credential inside its browser-boundary adapter. Domain operation results never contain response headers, cookies, passwords, or CSRF values.

Run from the repository root:

```sh
packages/api-client/test/fixtures/core-postgres/run.sh
```

Set `CONTAINER_RUNTIME=docker` when Podman is not available. The fixture requires OpenSSL, curl with AWS SigV4 support, Cargo, and Node 22.23.0 through mise.
