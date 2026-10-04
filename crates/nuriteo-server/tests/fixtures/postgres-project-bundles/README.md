# SAVE-001 PostgreSQL fixture

Runs Project Bundle, Save session, reservation, reference, multipart, Working
Head and GC schema invariants against pinned PostgreSQL over an ephemeral custom
CA. It includes active reservation/session DELETE fail-close, atomic terminal
reservation release, and a two-connection Working Head swap race. The fixture
owns only its temporary container and TLS material.

```sh
./crates/nuriteo-server/tests/fixtures/postgres-project-bundles/run.sh
```
