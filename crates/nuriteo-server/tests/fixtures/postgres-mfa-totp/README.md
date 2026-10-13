# MFA-001 PostgreSQL fixture

Runs the MFA encrypted-secret, recovery-code lifecycle, concurrent one-time
consume and bounded key-rotation test against a short-lived custom-CA PostgreSQL
server. The script removes its container, database password, server key and CA
key on exit.

```sh
./crates/nuriteo-server/tests/fixtures/postgres-mfa-totp/run.sh
```
