# Single-host Compose topology

This directory contains the official single-host topology for NURITEO. Only the Web service publishes a host port. Browser Save traffic stays on the application origin and follows `Browser -> Web -> Core -> RustFS`; Web proxies the authenticated request and Core streams the bounded body to the private bucket. Core API, PostgreSQL, and RustFS communicate through Compose DNS; the PostgreSQL and RustFS data plane uses an internal network. Bundled RustFS has no browser-facing endpoint and does not require bucket CORS.

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
- `NURITEO_PREVIEW_SIGNING_KEY_FILE`: file containing an independently generated 32-byte base64url key shared only by Core and Web for short-lived Preview host capabilities and privacy-preserving Preview admission proofs
- `NURITEO_MASTER_KEY_FILE`: file containing the persistent base64-encoded 32-byte Integration credential envelope key
- `NURITEO_MASTER_KEY_VERSION`: positive version of that envelope key (defaults to `1` for a new installation)

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
2. `storage-init` idempotently creates the bundled private bucket and enforces the no-CORS upgrade boundary, while `migrate` applies forward-only database migrations.
3. After `storage-init`, bundled `storage-check` uses the literal `relay` transport and proves bucket readiness and the required object-storage capabilities without a browser CORS check or OPTIONS preflight. After `migrate`, `bootstrap-admin` creates the first administrator.
4. Core starts only after every required one-shot succeeds, then Web starts only after Core reports ready.

All operational commands use the same Server image as `serve`. One-shots have no restart policy, and a failed one-shot keeps Core and Web gated. Re-running the stack against the same named volumes is safe: bucket creation, migration, and administrator bootstrap are idempotent. `compose down` preserves data; use `compose down --volumes` only when intentionally deleting this installation.

### Upgrading from the CMP-002 browser-upload topology

CMP-003 changes only the bundled upload data path. Preserve the existing PostgreSQL and RustFS named volumes, TLS material, credentials, and save idempotency secret, then deploy the new Compose definition normally. On the first start, `storage-init` reads the bundled bucket CORS document before Core or Web can start:

- No CORS document is already the desired state and is left unchanged.
- The exact CMP-002 single rule for the current `NURITEO_EXTERNAL_URL` (`nuriteo-browser-upload-v1`, `PUT`, the three documented request headers, the two exposed response headers, and `MaxAgeSeconds=300`) is removed, and its absence is verified.
- Any additional rule, wildcard, changed origin/header/method, or otherwise mixed/drifted document fails closed as `storage-init failed (legacy-cors-drift)`. The initializer does not guess which operator-owned rule is safe to delete, and Core and Web remain gated.

When drift is reported, inspect and reconcile the bucket CORS document deliberately, retaining any independently owned rules as appropriate; do not replace or delete the entire document merely to make startup pass. Then rerun `docker compose up`. This cleanup applies only to the bundled bucket. It does not migrate an external S3 deployment, whose direct browser upload still requires its exact CORS contract.

Core also requires `NURITEO_SAVE_IDEMPOTENCY_SECRET_FILE`, containing exactly 32 non-zero random bytes encoded as standard base64. Preserve this file across restarts; changing it makes earlier save idempotency keys intentionally fail closed. Preserve `NURITEO_MASTER_KEY_FILE` and its version as part of the external Secret Recovery Kit: changing or losing this key makes stored OIDC, SMTP, Git, and Registry credentials intentionally unavailable. Key rotation must retain the old key in the documented previous-key ring until every envelope has been re-encrypted. `NURITEO_SAVE_DEFAULT_QUOTA_BYTES` is the bootstrap Instance default for each Workspace (`10737418240`, 10 GiB, in the bundled Compose file). Set a positive decimal byte count up to the PostgreSQL `bigint` maximum or the explicit value `unlimited`.

The bootstrap password is accepted only through its mounted file. It is not placed in the command, environment, rendered Compose configuration, or image. After the initial install, rotate or remove the host-side bootstrap password file according to local secret-management policy; an already-initialized bootstrap run does not rewrite the credential.

## External S3 preflight

External S3 is an explicit, separate operator-preflight path. Configure `NURITEO_EXTERNAL_URL`, `NURITEO_S3_ENDPOINT`, `NURITEO_S3_REGION`, `NURITEO_S3_BUCKET`, `NURITEO_S3_ACCESS_KEY_FILE`, `NURITEO_S3_SECRET_KEY_FILE`, and `NURITEO_S3_CA_FILE`, then run:

```sh
docker compose -f deploy/compose/compose.external-s3.yaml run --rm storage-check
```

The bucket must already exist. This profile sets the literal `direct` transport. Its default `storage-check` path is read-only with respect to bucket policy: it refuses a missing, wildcard, extra, or drifted CORS document, performs real single/multipart presigned upload and OPTIONS checks, and never falls back to bundled RustFS or the relay. It uses reserved probe objects/uploads and cleans them.

If the external bucket does not yet have the required policy, review the exact contract below and run the separate, explicit mutation once:

```sh
docker compose -f deploy/compose/compose.external-s3.yaml \
  --profile configure-browser-upload-cors \
  run --rm storage-configure-browser-upload-cors
docker compose -f deploy/compose/compose.external-s3.yaml run --rm storage-check
```

The configure command replaces the bucket CORS document with one rule: the canonical application origin only, `PUT` only, request headers `content-type`, `x-amz-checksum-sha256`, and the multipart signer-required `x-amz-sdk-checksum-algorithm`, exposed response headers `etag` and `x-amz-checksum-sha256`, and a 300-second preflight cache. It never enables credentials or wildcard origin/header. Because replacement can remove unrelated rules, operators must use a dedicated NURITEO bucket or explicitly accept that ownership before running it. Core only performs the read-only exact check at startup.

## Validation

Run the source contract without a container engine:

```sh
node deploy/compose/check-compose.mjs
```

Run the destructive local fixture against disposable project-scoped volumes:

```sh
deploy/compose/test-compose.sh
```

The fixture creates temporary credentials and private test CAs, renders the configuration and scans it for secret values, builds the application images, and exercises a clean-volume installation. It verifies ready Core/Web, the administrator/credential/audit transaction, migration readiness, same-origin relay Save, no bundled browser storage exposure or CORS, database and object persistence, exact CMP-002 CORS removal on same-volume restart, fresh-browser-context Resume, and failed-one-shot gating. It removes its project-scoped containers, networks, volumes, and temporary files. Set `NURITEO_COMPOSE_KEEP=1` only for local failure diagnosis.

Local runs may use Docker Compose, a configured Podman Compose provider, or the pinned isolated provider selected with `NURITEO_COMPOSE_PROVIDER=uvx`. Podman results are useful compatibility information, but they are not official release acceptance. The official acceptance boundary is the manual `Docker Compose v2 / Linux qualification` job in `.github/workflows/docker-compose-qualification.yml`, which requires Docker Compose v2 on a Linux Docker Engine and runs the bounded clean-install/restart/persistence/failure journey.

## Release upgrade helper

Create a release-specific plan from `fixtures/upgrade-plan-v1.json`, replace the explicitly non-runnable `example.invalid` fixture references, and pin both the compatibility manifest and the published target release-set manifest by SHA-256. The helper requires the target release-set to name exactly one digest-pinned Server and Web pair for the same release lineage; arbitrary or mixed target images are rejected. With the normal Compose variables and secrets still exported, run:

```sh
node deploy/compose/upgrade.mjs upgrade /absolute/path/to/upgrade-plan.json
```

The helper verifies that the running Core and Web are the plan's supported source release, then runs the target Server image in this strict order: read-only `upgrade-preflight`, object-storage capability check, forward migration, Core replacement/readiness, Web replacement, and a bounded `/sign-in` HTTP readiness probe from inside the Web container. A preflight, object check, or migration failure exits before either workload is changed. A Core or Web readiness failure switches both workloads back to the manifest-compatible source application while preserving the migrated schema and objects, and verifies both source readiness boundaries again.

Application rollback is explicit and never means database downgrade:

```sh
node deploy/compose/upgrade.mjs rollback /absolute/path/to/upgrade-plan.json
```

Rollback first runs the current candidate's preflight, requires the plan to declare that the previous application accepts the current schema and object format, and then replaces only Core and Web. The helper contains no down-migration path. If schema or object data must be reverted, use a coordinated full restore instead. `NURITEO_COMPOSE_COMMAND` defaults to `docker compose`; set it to `podman compose` for a Podman compatibility rehearsal.

The repository-owned qualification creates four distinct OCI images, pushes them to a disposable local registry,
uses digest-only source/target release sets, injects a preflight failure, upgrades migration 46 to 50, and performs an
application-only rollback while asserting that the schema and stored object sentinel remain intact:

```sh
deploy/compose/run-upgrade-rehearsal.sh
```

For the real database boundary, `crates/nuriteo-server/tests/fixtures/postgres-upgrade-preflight/run.sh` builds the
server from the frozen Beta commit, migrates a TLS PostgreSQL instance to version 46, verifies read-only preflight,
then runs the current migration 50 binary and checks that pre-existing domain bytes are unchanged.
