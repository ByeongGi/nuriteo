# SRV-004 production serve fixture

`run.sh` starts pinned PostgreSQL and RustFS images with fixture-local TLS certificates, then executes the ignored real-binary `serve_backends` test.

The test verifies production configuration assembly, real `/health/live` and `/health/ready`, the separate `healthcheck` subprocess, bind failure redaction, schema-pending and storage-degraded behavior, non-mutation, SIGTERM drain, clean exit, and listener port closure.

Requirements: Bash, OpenSSL, curl, Cargo, and Podman (or set `CONTAINER_RUNTIME` to a Docker-compatible CLI). PostgreSQL and RustFS ports default to `55436` and `19003`; override them with `NURITEO_TEST_DATABASE_PORT` and `NURITEO_TEST_S3_PORT`.

```sh
crates/nuriteo-server/tests/fixtures/production-serve/run.sh
```
