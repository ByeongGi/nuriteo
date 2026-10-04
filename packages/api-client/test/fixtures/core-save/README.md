# CLIENT-007 Core/PostgreSQL/HTTPS RustFS direct/relay fixture

`run.sh` reuses the production client boundary: digest-pinned PostgreSQL 17.6
with a custom CA, digest-pinned HTTPS RustFS with exact Browser upload CORS,
real migrations, bootstrap administrator, and the production Core binary.

The fixture runs the production Core twice against fresh custom-CA PostgreSQL
and HTTPS RustFS instances. `direct` preserves the external-S3 presigned PUT,
client receipt, CORS, commit, Resume, cancellation, and permission-revocation
journey. `relay` proves authenticated same-origin single and 65+ MiB multipart
uploads, performs no client receipt submission, and completes and downloads the
persisted Bundle through the same typed client.

Run from the repository root:

```sh
packages/api-client/test/fixtures/core-save/run.sh
```

Set `CONTAINER_RUNTIME=docker` when Podman is unavailable.
