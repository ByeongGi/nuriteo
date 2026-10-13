# PostgreSQL live policy engine fixture

Runs POL-002 against the pinned PostgreSQL image over a temporary custom CA. It proves live Session
and Workspace quota policy use, impact preview, update/use serialization, restart authority and a
bounded GC dry-run that never deletes data.

```bash
./crates/nuriteo-server/tests/fixtures/postgres-policy-engine/run.sh
```
