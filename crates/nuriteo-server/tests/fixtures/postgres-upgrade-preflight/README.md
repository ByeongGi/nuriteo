# PostgreSQL upgrade preflight fixture

`run.sh` starts the pinned PostgreSQL image with hostname-verified TLS and runs the ignored
`upgrade_preflight_postgres` test. The fixture builds the server from the RC baseline commit and
uses that binary to create the exact supported migration 46 source schema. The candidate test then
materializes Instance settings registry v4 and keeps an independent previous-service health fixture
active.

It proves that a successful preflight does not apply any candidate migration after version 46 and
that dirty/checksum failures
leave both `_sqlx_migrations` and a binary domain sentinel byte-for-byte unchanged. The health
fixture must return `200 ready` before and after every preflight result. Temporary certificates,
the database container, and all fixture data are removed on exit.
