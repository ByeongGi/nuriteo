# CLIENT-005 Core/PostgreSQL/RustFS organization journey fixture

`run.sh` starts pinned PostgreSQL 17.6 with an ephemeral custom CA and pinned RustFS with HTTPS, runs the real migration and `bootstrap-admin` commands, and starts the production Core binary. The TypeScript fixture exercises only the public API client operations across separate administrator, member, and public request scopes:

administrator login → activation issue/reissue/list → member activation/login → Organization create → invitation issue/reissue/accept → Workspace projection → member role changes → second invitation decline/list.

The fixture keeps the cookie jar and CSRF credential inside its browser-boundary adapter. Domain operation results never contain response headers, cookies, passwords, or CSRF values.

Run from the repository root:

```sh
packages/api-client/test/fixtures/core-organization/run.sh
```

Set `CONTAINER_RUNTIME=docker` when Podman is not available. The fixture requires OpenSSL, curl with AWS SigV4 support, Cargo, and Node 22.23.0 through mise.

`NURITEO_CLIENT_TEST_EXTERNAL_URL` optionally sets a distinct public origin for
Web/BFF fixtures. It must be an exact canonical absolute HTTP(S) origin such as
`http://127.0.0.1:3010`; credentials, a trailing slash or path, query, fragment,
comma, whitespace, control characters and non-canonical spellings fail before
the fixture creates secrets or starts containers. The Core listen address and
`NURITEO_CLIENT_TEST_BASE_URL` remain bound to `NURITEO_TEST_CORE_PORT`. The
validated public origin is re-exposed only to the final fixture consumer.
