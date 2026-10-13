# AUTH-002 PostgreSQL fixture

`run.sh` starts the repository-pinned PostgreSQL image, provisions an ephemeral
custom certificate authority, enables server TLS, and runs the ignored
`auth_lockout` integration test over a verified TLS connection.

The test covers threshold and active-lock behavior, twelve concurrent failures,
PostgreSQL-time expiry, success reset, unknown/disabled/no-credential accounts,
and rollback when failure, lock, or success audit insertion is rejected.

```sh
CARGO_TARGET_DIR=/private/tmp/nuriteo-auth002-target \
  crates/nuriteo-server/tests/fixtures/postgres-auth-lockout/run.sh
```
