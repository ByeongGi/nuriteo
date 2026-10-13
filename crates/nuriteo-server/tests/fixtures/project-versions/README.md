# SAVE-008 actual fixture

Runs the explicit immutable Project Version service against pinned PostgreSQL
and RustFS, both with short-lived custom CAs. It creates verified Working Heads
through the production upload, verification, and commit services before testing
idempotent Version creation, authorization, keyset listing, immutable metadata,
quota deduplication, and GC live-reference protection.

```sh
./crates/nuriteo-server/tests/fixtures/project-versions/run.sh
```
