# HLT-001 real backend fixture

`run.sh` starts the pinned PostgreSQL and RustFS images with fixture-local TLS certificates, then runs the ignored `health_backends` integration test. The test exercises the real HTTP health routes and the real `nuriteo-server healthcheck` subprocess.

Requirements: Bash, OpenSSL, curl, Cargo, and Podman (or set `CONTAINER_RUNTIME` to a Docker-compatible CLI). Ports default to PostgreSQL `55435` and RustFS `19002`; override them with `NURITEO_TEST_DATABASE_PORT` and `NURITEO_TEST_S3_PORT`.

```sh
crates/nuriteo-server/tests/fixtures/health-backends/run.sh
```

Both containers and generated certificates are removed on exit.
