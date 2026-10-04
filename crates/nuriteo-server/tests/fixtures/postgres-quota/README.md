# SAVE-002 PostgreSQL fixture

Runs Workspace quota accounting and reservation serialization against pinned
PostgreSQL over an ephemeral custom CA. It verifies physical Bundle dedupe,
cross-Workspace accounting, concurrent oversubscription prevention, independent
scope progress, typed lock timeout, retry conflict, expiry, and atomic terminal
reservation release.

```sh
./crates/nuriteo-server/tests/fixtures/postgres-quota/run.sh
```
