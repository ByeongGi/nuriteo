# CLIENT-003 Core/PostgreSQL Project client fixture

`run.sh` reuses the production Core fixture boundary: digest-pinned PostgreSQL
17.6 with an ephemeral custom CA, digest-pinned HTTPS RustFS, real migrations,
bootstrap administrator, and the production server binary. It selects the
Project live consumer, which exercises Personal Project lifecycle, opaque
cursor continuation, and Organization direct-role grant/change/revoke
including an unchanged no-op revoke validator.

Run from the repository root:

```sh
packages/api-client/test/fixtures/core-project/run.sh
```

Set `CONTAINER_RUNTIME=docker` when Podman is unavailable.
