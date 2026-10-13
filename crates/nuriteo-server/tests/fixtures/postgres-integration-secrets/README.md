# INT-001 PostgreSQL fixture

Runs migration 0026 and the integration credential/key-rotation/private-CA
acceptance test against the pinned PostgreSQL image over a generated custom CA.
The runner removes its container and temporary certificate/key material on exit.

```sh
./crates/nuriteo-server/tests/fixtures/postgres-integration-secrets/run.sh
```
