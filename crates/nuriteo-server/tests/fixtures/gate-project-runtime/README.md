# GATE-003 Project Runtime aggregate fixture

This fixture builds the production Next.js standalone artifact and then runs one Chromium journey against a real `nuriteo-server`, custom-CA PostgreSQL and HTTPS RustFS. It signs in through the Web BFF, creates a Personal Workspace Project, materializes the browser IDE, starts the production Runtime assets, opens an isolated signed wildcard Preview, applies an HMR edit, destroys the Preview Service Worker to prove fail-closed host rotation and recovery, and stops the workspace while checking Worker and Service Worker cleanup.

The fixture reuses the pinned infrastructure setup from `gate-collaboration`; it does not concatenate the separate Project, Runtime, or Preview mocks.

```sh
CARGO_TARGET_DIR=/private/tmp/nuriteo-gate003-target \
  ./crates/nuriteo-server/tests/fixtures/gate-project-runtime/run.sh
```

Podman is used by default. Set `CONTAINER_RUNTIME=docker` for a Docker-compatible CLI.
