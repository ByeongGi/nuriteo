# Single-host Compose topology

This directory contains the official single-host topology for NURITEO. Only the Web service publishes a host port. Core API, PostgreSQL, and RustFS communicate through Compose DNS; the PostgreSQL and RustFS data plane uses an internal network.

## Required files

Set these variables to absolute paths before rendering or starting the stack:

- `NURITEO_POSTGRES_PASSWORD_FILE`: PostgreSQL application password
- `NURITEO_POSTGRES_SERVER_CERT_FILE`: PostgreSQL server certificate with `DNS:postgres`
- `NURITEO_POSTGRES_SERVER_KEY_FILE`: matching PostgreSQL private key
- `NURITEO_DATABASE_URL_FILE`: complete `postgres://` URL for Core
- `NURITEO_DATABASE_CA_FILE`: CA certificate that verifies the PostgreSQL service identity
- `NURITEO_RUSTFS_ACCESS_KEY_FILE`: non-default RustFS access key
- `NURITEO_RUSTFS_SECRET_KEY_FILE`: non-default RustFS secret key
- `NURITEO_RUSTFS_CA_FILE`: CA certificate trusted by Core
- `NURITEO_RUSTFS_TLS_DIR`: directory containing `ca.crt`, `rustfs_cert.pem`, and `rustfs_key.pem`
- `NURITEO_BOOTSTRAP_ADMIN_EMAIL`: normalized email for the first Instance Administrator
- `NURITEO_BOOTSTRAP_ADMIN_NAME`: display name for the first Instance Administrator
- `NURITEO_BOOTSTRAP_ADMIN_PASSWORD_FILE`: password file for the first Instance Administrator
- `NURITEO_EXTERNAL_URL`: canonical browser origin
- `NURITEO_PREVIEW_BASE_DOMAIN`: dedicated wildcard Preview base domain (for example `preview.example.com`)
- `NURITEO_PREVIEW_SIGNING_KEY_FILE`: file containing an independently generated 32-byte base64url key used only for short-lived Preview host capabilities

The Compose file has no credential defaults. Protect every credential and private-key file with owner-only permissions. A minimal PostgreSQL derivative copies its mounted certificate and key into a private runtime path before delegating to the upstream entrypoint with TLS enabled. The Dockerfile build context allowlists only that wrapper. The database URL, database CA, PostgreSQL identity, and RustFS credentials are mounted as Compose secrets; RustFS TLS material is mounted read-only. Core always verifies the PostgreSQL hostname and CA; this topology does not claim that PostgreSQL rejects every non-TLS client.

Optional settings are `NURITEO_WEB_BIND_IP` (default `127.0.0.1`), `NURITEO_WEB_PORT` (default `3000`), `NURITEO_POSTGRES_IMAGE`, `NURITEO_SERVER_IMAGE`, and `NURITEO_WEB_IMAGE`.

## Isolated Preview origin

Production Preview requires wildcard DNS and TLS for `*.${NURITEO_PREVIEW_BASE_DOMAIN}` at the reverse proxy. The proxy must preserve the original `Host` header and route both the application origin and the wildcard Preview hosts to Web. Set `NURITEO_PREVIEW_WILDCARD_READY=true` only after independently verifying that DNS, the wildcard certificate, and proxy routing work end to end. This flag is an explicit operator acknowledgement; Nuriteo does not infer or provision those external resources.

Generate the content of `NURITEO_PREVIEW_SIGNING_KEY_FILE` from 32 random bytes encoded as unpadded base64url, mount it as the Compose secret, and keep it private. Preview host capabilities expire within five seconds and bind the opaque runtime token to the internal dev-server port; tampered, expired, or wrong-port hosts are rejected. Rotating the file and restarting Web immediately invalidates outstanding Preview hosts and requires users to run Preview again.

The default is `false`. Missing acknowledgement, non-HTTPS application URLs, invalid hostnames, or unmatched Preview hosts fail closed: the product does not fall back to a same-origin Preview. Local qualification may use `app.localhost` with a `preview.localhost` base domain over loopback HTTP; this exception is not a production readiness claim.

An example reverse-proxy shape is provided in `Caddyfile.preview.example`. Replace both example domains and mount a certificate covering the application host and wildcard Preview host. Automated wildcard certificate issuance requires a DNS provider integration and remains operator-owned.

## Startup lifecycle

`compose up` enforces this order:

1. PostgreSQL and bundled RustFS become healthy.
2. `storage-init` idempotently creates the bundled private bucket, while `migrate` applies forward-only database migrations.
3. `storage-check` validates the bucket and `bootstrap-admin` atomically creates the first administrator, local credential, and audit event.
4. Core starts only after every required one-shot succeeds, then Web starts only after Core reports ready.

All operational commands use the same Server image as `serve`. One-shots have no restart policy, and a failed one-shot keeps Core and Web gated. Re-running the stack against the same named volumes is safe: bucket creation, migration, and administrator bootstrap are idempotent. `compose down` preserves data; use `compose down --volumes` only when intentionally deleting this installation.

The bootstrap password is accepted only through its mounted file. It is not placed in the command, environment, rendered Compose configuration, or image. After the initial install, rotate or remove the host-side bootstrap password file according to local secret-management policy; an already-initialized bootstrap run does not rewrite the credential.

## External S3 preflight

External S3 is an explicit, separate operator-preflight path. Configure `NURITEO_EXTERNAL_URL`, `NURITEO_S3_ENDPOINT`, `NURITEO_S3_REGION`, `NURITEO_S3_BUCKET`, `NURITEO_S3_ACCESS_KEY_FILE`, `NURITEO_S3_SECRET_KEY_FILE`, and `NURITEO_S3_CA_FILE`, then run:

```sh
docker compose -f deploy/compose/compose.external-s3.yaml run --rm storage-check
```

The bucket must already exist. This path contains only the Server `storage-check` command: it does not run bundled storage initialization, create or delete buckets, change policies, or fall back to RustFS. An external deployment overlay can reuse the validated settings for Core without changing that ownership boundary.

## Validation

Run the source contract without a container engine:

```sh
node deploy/compose/check-compose.mjs
```

Run the destructive local fixture against disposable project-scoped volumes:

```sh
deploy/compose/test-compose.sh
```

The fixture creates temporary credentials and private test CAs, renders the configuration and scans it for secret values, builds the application images, and exercises a clean-volume installation. It verifies ready Core/Web, the administrator/credential/audit transaction, migration readiness, database and object persistence, idempotent same-volume restart, and failed-bootstrap gating. It removes its project-scoped containers, networks, volumes, and temporary files. Set `NURITEO_COMPOSE_KEEP=1` only for local failure diagnosis. If Docker Compose or a configured Podman Compose provider is unavailable, select the pinned isolated provider with `NURITEO_COMPOSE_PROVIDER=uvx`.
