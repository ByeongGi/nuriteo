# SETUP-001 repository PostgreSQL fixture

`run.sh` starts pinned PostgreSQL 17.6, installs an ephemeral custom CA/server certificate, runs all embedded migrations, and verifies that the setup-status repository reacts only to an active Instance Administrator. Active non-admin and disabled admin rows keep `bootstrapRequired=true`; activating the administrator changes it to `false`.

Run from the repository root:

```sh
crates/nuriteo-server/tests/fixtures/postgres-setup-status/run.sh
```

This isolated fixture does not wire the public application router or OpenAPI document. The final HTTP/client flow is added only after ORG-004 releases those shared files.
