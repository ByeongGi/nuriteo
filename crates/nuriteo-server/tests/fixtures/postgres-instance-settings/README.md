# PostgreSQL Instance settings fixture

Runs `CFG-002` against the pinned PostgreSQL image with a temporary custom CA. It verifies
first-install materialization, environment/file/default precedence, PostgreSQL authority after
restart, concurrent initialization, corruption handling and schema constraints.

```bash
./crates/nuriteo-server/tests/fixtures/postgres-instance-settings/run.sh
```
