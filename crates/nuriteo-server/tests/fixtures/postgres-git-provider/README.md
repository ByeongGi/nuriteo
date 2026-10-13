# GIT-001 actual fixture

`run.sh` starts a TLS-enabled PostgreSQL instance and a private-CA HTTPS Git
provider endpoint. It verifies migration 39, disabled-first lifecycle, exact
host/port uniqueness, recent administrator authorization, private-network SSRF
denial in production mode, explicit test-only loopback allowance, custom CA,
redirect and response-size rejection, activation generation fencing, exact
repository routing with no fallback, active immutability, disable and audit.

Run with `bash crates/nuriteo-server/tests/fixtures/postgres-git-provider/run.sh`.
