# CLIENT-006 Core Project history fixture

`run.sh` reuses the production Core fixture boundary: pinned PostgreSQL with a custom CA and pinned RustFS over HTTPS with a separate custom CA. It runs the real migration, bootstrap, S3 CORS setup, and production `serve` command before executing the handwritten TypeScript client.

The consumer covers Version create/replay/list, bounded pagination, Recovery list, Version and Recovery restore, idempotent replay, read-only reconcile, archive reads/mutation rejection, and authorization revocation. It only logs stable resource identifiers and never raw cursor, idempotency, cookie, CSRF, storage object, or presigned capability values.

Run from the repository root with Node 22.23.0 available through mise:

```sh
CARGO_TARGET_DIR=/private/tmp/nuriteo-client006-target packages/api-client/test/fixtures/core-history/run.sh
```

Set `CONTAINER_RUNTIME=docker` when Podman is unavailable.
