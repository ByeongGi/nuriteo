# Single-host Compose topology

This directory contains the official single-host topology for NURITEO. Only the Web service publishes a host port. Core API, PostgreSQL, and RustFS communicate through Compose DNS; the PostgreSQL and RustFS data plane uses an internal network.

## Required files

Set these variables to absolute paths before rendering or starting the stack:

- `NURITEO_POSTGRES_PASSWORD_FILE`: PostgreSQL application password
- `NURITEO_DATABASE_URL_FILE`: complete `postgres://` URL for Core
- `NURITEO_RUSTFS_ACCESS_KEY_FILE`: non-default RustFS access key
- `NURITEO_RUSTFS_SECRET_KEY_FILE`: non-default RustFS secret key
- `NURITEO_RUSTFS_CA_FILE`: CA certificate trusted by Core
- `NURITEO_RUSTFS_TLS_DIR`: directory containing `ca.crt`, `rustfs_cert.pem`, and `rustfs_key.pem`
- `NURITEO_EXTERNAL_URL`: canonical browser origin

The Compose file has no credential defaults. Protect every credential and private-key file with owner-only permissions. The database URL and RustFS credentials are mounted as Compose secrets; RustFS TLS material is mounted read-only.

Optional settings are `NURITEO_WEB_BIND_IP` (default `127.0.0.1`), `NURITEO_WEB_PORT` (default `3000`), `NURITEO_SERVER_IMAGE`, and `NURITEO_WEB_IMAGE`.

## Validation

Run the source contract without a container engine:

```sh
node deploy/compose/check-compose.mjs
```

Run the destructive local fixture against disposable project-scoped volumes:

```sh
deploy/compose/test-compose.sh
```

The fixture creates temporary credentials and a private test CA, builds both application images, starts PostgreSQL, RustFS, and Web, writes metadata and object sentinels, stops and restarts the services, verifies persistence, and removes its containers, networks, volumes, and temporary files. If Docker Compose or a configured Podman Compose provider is unavailable, an isolated test provider can be selected with `NURITEO_COMPOSE_PROVIDER=uvx`.

## CMP-002 handoff

Core's `serve` listener is not wired in the current baseline, so this topology intentionally has no fake shell/log healthcheck and no `depends_on` readiness ordering. The `x-nuriteo-cmp-002-readiness` extension records the accepted HLT-001 `/health/live`, `/health/ready`, and CLI contracts. CMP-002 must add migration/bootstrap one-shot services and health-based startup ordering after production `serve` composes the real database pool, S3 adapter, and `HealthService`.
