# PostgreSQL Instance settings fixture

Runs `CFG-002` and `POL-001` against the pinned PostgreSQL image with a temporary custom CA. It verifies
first-install materialization, environment/file/default precedence, PostgreSQL authority after
restart, atomic registry upgrades, concurrent initialization, individual/cross-policy corruption
handling and schema constraints.

```bash
./crates/nuriteo-server/tests/fixtures/postgres-instance-settings/run.sh
```
