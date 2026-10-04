# CLIENT-004 Core/PostgreSQL/HTTPS RustFS fixture

`run.sh` reuses the production client boundary: digest-pinned PostgreSQL 17.6
with a custom CA, digest-pinned HTTPS RustFS with exact Browser upload CORS,
real migrations, bootstrap administrator, and the production Core binary.

The Node 22 consumer creates a Personal Project, creates and uploads a
canonical Project Bundle through a presigned capability, commits its Working
Head, obtains an authorized descriptor, and consumes the same-origin download
through a bounded checksum-verifying sink. It also covers idempotent create,
commit reconciliation, cancellation, and permission-revocation behavior.

Run from the repository root:

```sh
packages/api-client/test/fixtures/core-save/run.sh
```

Set `CONTAINER_RUNTIME=docker` when Podman is unavailable.
