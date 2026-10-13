# SAVE-011 production HTTP fixture

`run.sh` starts the shared custom-CA PostgreSQL and HTTPS RustFS fixture, then
executes the ignored save HTTP vertical test. The test rebuilds the complete
Axum service graph with the same persisted database and idempotency secret,
proves replay after that restart, rejects a changed secret during service
assembly, uploads a canonical Bundle, commits the Working Head, reconciles the
result, and verifies tenant-safe authorization.
