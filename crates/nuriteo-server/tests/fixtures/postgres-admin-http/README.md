# ADM-002 · AUD-002 · OPS-002 PostgreSQL HTTP fixture

Runs the administrator settings and status API against the pinned PostgreSQL image with a
generated private CA. The fixture covers authentication, administrator authorization, CSRF,
recent reauthentication, strong ETag concurrency, registry validation, atomic audit persistence,
secret-free responses and status projection. It also covers administrator-only Audit query/detail,
stable cursor pagination, JSONL/CSV export, defensive metadata redaction, retention preview, bounded
prune and audit-failure rollback.
The same journey verifies administrator-only Operations access, safe dependency degradation,
cleanup queue projection and identifier-free aggregate instance usage.

```sh
./crates/nuriteo-server/tests/fixtures/postgres-admin-http/run.sh
```
