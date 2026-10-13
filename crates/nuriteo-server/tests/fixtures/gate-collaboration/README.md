# GATE-002 actual Core collaboration fixture

`run.sh` starts pinned PostgreSQL 17.6 and RustFS containers with independent ephemeral custom certificate authorities. It migrates an empty schema through migration 14 and executes one real `nuriteo-server` process through administrator bootstrap, activation, local login, Personal Workspace isolation, Organization collaboration, terminal invitation behavior and Organization Workspace visibility.

The script requires `podman` by default. Set `CONTAINER_RUNTIME=docker` to select a Docker-compatible CLI. Host ports are selected dynamically; `NURITEO_TEST_DATABASE_PORT` and `NURITEO_TEST_S3_PORT` provide explicit overrides when required. Database credentials, certificate keys and the bootstrap password file are created under a temporary directory and removed by the exit trap.

```sh
CARGO_TARGET_DIR=/private/tmp/nuriteo-gate002-target \
  ./crates/nuriteo-server/tests/fixtures/gate-collaboration/run.sh
```

This fixture is actual Core evidence. It is intentionally separate from `apps/web/test/collaboration-browser.test.ts`, which verifies the production standalone Next.js/BFF/browser boundary against a bounded stateful mock Core.
