# SAVE-009 cleanup fixture

`run.sh` starts pinned PostgreSQL and RustFS containers with independently
generated custom certificate authorities. It proves the persisted Save cleanup
lifecycle against real TLS backends:

- PostgreSQL-clock expiry drains 101 sessions as `100 + 1` and releases each
  reservation through the existing terminal trigger;
- authenticated abort is idempotent and queues cleanup atomically;
- a still-valid single-PUT capability can upload after abort, while deletion is
  fenced until capability expiry;
- an unknown multipart-create outcome is reconciled only by bounded exact-key
  listing and abort;
- an unavailable backend persists retry state, and a new worker process drains
  that state after recovery;
- an abandoned canonical Bundle multipart upload is recovered from its durable
  ledger, aborted by exact object key and upload ID, and marked for object GC;
- shutdown is supervised and bounded.

Run from the repository root:

```sh
crates/nuriteo-server/tests/fixtures/save-cleanup/run.sh
```

Set `CONTAINER_RUNTIME=docker` to use Docker instead of Podman.
