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

## Validate

```sh
helm lint --strict charts/nuriteo
helm template nuriteo charts/nuriteo --namespace nuriteo
charts/nuriteo/tests/check-chart.sh
```
