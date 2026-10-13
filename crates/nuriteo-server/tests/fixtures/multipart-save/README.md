# SAVE-004 actual fixture

This fixture reuses the pinned SAVE PostgreSQL and RustFS harness with dynamic
loopback ports and independently generated custom certificate authorities. It
runs the bounded multipart journey: durable plan/idempotency, signed exact
part mutation rejection, receipt retry/conflict, completion reconciliation,
the 128-part/2 GiB metadata boundary, confirmed abort, quota release, and
secret-safe output.
