# NURITEO Helm Chart

This chart deploys the paired NURITEO Web and Core workloads. It keeps the
digest-only image contract introduced by `K8S-001`, the external reference and
rollout rules introduced by `K8S-002`, and the ordered lifecycle Jobs introduced
by `K8S-003`.

## Contract

- Kubernetes 1.29 or newer.
- External PostgreSQL is mandatory and remains outside the Helm release lifecycle.
- External HTTPS S3-compatible storage is the initial production profile.
- Server and Web are one release pair and must use `sha256` digests, never mutable tags.
- Secrets are referenced by existing Secret name and key. Secret values are not Helm values.
- The chart owns only non-secret runtime configuration by default. Set
  `runtimeConfig.create=false` to reference an existing ConfigMap.
- Chart-owned configuration changes update `checksum/nuriteo-runtime-config` automatically.
- Kubernetes does not expose an existing Secret's content to Helm. After rotating any referenced
  Secret, change `rollout.externalSecretsRevision` to a new opaque generation so workloads roll.
  Never use a password, token, content hash or other derivation of secret material as that value.
- `global.imageRegistry` can point to an internal mirror; it never falls back to GHCR.
- The canonical URL is an HTTPS origin at `/`; subpath deployment is unsupported.
- The optional Ingress always sends the canonical application host to Web. It adds exactly one wildcard
  Preview host (`*.preview.baseDomain`) only after Preview readiness is acknowledged. It references an
  existing TLS Secret and never installs an Ingress controller, cert-manager, DNS records, or a certificate.

Before installing, replace every example endpoint and Secret reference in a private
values file. Do not put credentials in that file.

The chart never creates a `Secret`. Required operator-owned references are:

- `postgresql.existingSecret`: database URL and optional PostgreSQL CA
- `objectStorage.existingSecret`: static S3 credentials, optional token and CA
- `applicationSecrets.existingSecret`: master, Save-idempotency and Preview-signing keys
- `bootstrapAdmin.existingSecret`: bootstrap password when bootstrap is enabled

When `runtimeConfig.create=false`, change `runtimeConfig.existingConfigMap.revision` after updating
that ConfigMap. This is also an opaque generation and must not contain configuration contents.

## Install and upgrade ordering

Helm runs blocking hooks before creating or changing either Deployment:

1. Install runs `storage-check`; upgrade runs the non-mutating `upgrade-preflight` command.
2. The same pinned Server image runs `migrate` after preflight succeeds.
3. Optional `bootstrap-admin` runs after migration when explicitly enabled.
4. Only then does Helm apply the Core and Web Deployments and Services.

Preflight and migration are mandatory in the values schema. They use hook weights `-20` and `-10`,
`restartPolicy: Never`, bounded deadlines and a zero default retry count. A failed Job fails the
Helm operation before a new Deployment template is applied, leaving the previous release running.
The completed Job is retained for diagnosis until TTL cleanup or the next attempt.

The Jobs receive configuration directly rather than depending on the chart-owned ConfigMap because
pre-install hooks run before regular release resources exist. Credential files still come only from
the same operator-owned Secrets used by Core.

Core serves application traffic and Kubernetes health probes on port `8080`; the internal management
listener remains a separate port. Web probes its local `/sign-in` route and calls Core through the
cluster-internal Core Service. Both Deployment Pod templates consume the K8S-002 rollout checksums.

The current checked-in digests record the GATE-005 baseline. Before actual RC deployment, the release
pipeline must replace them with the paired RC image digests that include the current migration and
`upgrade-preflight` command, then qualify that exact pair in a Kubernetes cluster.

## Ingress and wildcard Preview

Ingress is disabled by default. It can expose the application host while Preview remains disabled; the
wildcard TLS host and routing rule are omitted until `preview.wildcardReady=true`. The controller must
preserve the original `Host`, support upgraded WebSocket connections for the editor/terminal boundary,
and route every path on both hosts to the Web Service. The Web middleware, not an Ingress rewrite,
validates the opaque, signed single-label Preview hostname and permits only the Preview bootstrap,
Service Worker and HMR assets.

Create DNS records for the application host and `*.preview.baseDomain`, and provision one existing TLS
Secret whose certificate is valid for both. Then test HTTPS, the cross-origin Preview boundary, original
Host propagation, WebSocket upgrade, and an actual edit-to-HMR journey before setting the readiness
values. The acknowledgements are fail-closed: `preview.wildcardReady=true` is rejected unless every one
is true, and `ingress.enabled=true` additionally requires an Ingress class and existing TLS Secret name.

```yaml
externalUrl: https://nuriteo.example.com
preview:
  baseDomain: preview.nuriteo.example.com
  wildcardReady: true
ingress:
  enabled: true
  className: nginx
  tls:
    existingSecretName: nuriteo-edge-tls
  readiness:
    wildcardDns: true
    wildcardTls: true
    originalHost: true
    webSocket: true
    crossOrigin: true
    hmr: true
```

The chart derives the application host from `externalUrl`; it is not configurable a second time.
The render fails if that host equals or falls below `preview.baseDomain`, which prevents application
traffic from being captured by the Preview wildcard. A custom external edge may leave
`ingress.enabled=false`, but it must satisfy and acknowledge the same readiness contract before enabling
remote Preview. Never use a same-origin fallback when any check fails: leave `preview.wildcardReady=false`
so the product reports Preview as disabled.

## Validate

```sh
helm lint --strict charts/nuriteo
helm template nuriteo charts/nuriteo --namespace nuriteo
charts/nuriteo/tests/check-chart.sh
```
