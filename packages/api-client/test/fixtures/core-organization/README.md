# CLIENT-005 Core/PostgreSQL/RustFS organization journey fixture

`run.sh` starts pinned PostgreSQL 17.6 with an ephemeral custom CA and pinned RustFS with HTTPS, runs the real migration and `bootstrap-admin` commands, and starts the production Core binary. The TypeScript fixture exercises only the public API client operations across separate administrator, member, and public request scopes:

administrator login → activation issue/reissue/list → member activation/login → Organization create → invitation issue/reissue/accept → Workspace projection → member role changes → second invitation decline/list.

The fixture keeps the cookie jar and CSRF credential inside its browser-boundary adapter. Domain operation results never contain response headers, cookies, passwords, or CSRF values.

Run from the repository root:

```sh
packages/api-client/test/fixtures/core-organization/run.sh
```

Set `CONTAINER_RUNTIME=docker` when Podman is not available. The fixture requires OpenSSL, curl with AWS SigV4 support, Cargo, and Node 22.23.0 through mise.
