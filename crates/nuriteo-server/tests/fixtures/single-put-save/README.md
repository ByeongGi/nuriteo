# SAVE-003 actual fixture

`run.sh` starts pinned, ephemeral PostgreSQL and RustFS containers on dynamic
loopback ports. Both endpoints use fixture-owned custom certificate authorities.
It validates migration 1..15, atomic quota admission, restart-equivalent
idempotency, signed exact-length/SHA-256 PUT, mutation rejection and presign
failure compensation. Credentials, bearer URLs, object keys and checksums are
never printed or persisted as fixture artifacts.
