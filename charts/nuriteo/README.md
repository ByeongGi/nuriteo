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

The checked-in Server and Web digests record the GATE-005 baseline. The Operations image uses an
all-zero sentinel and makes every backup/restore template fail closed until release automation supplies
its published digest. Before actual RC deployment, the release pipeline must replace all three digests;
the Operations image contains the same Server binary plus `pg_dump`/`pg_restore`, while the online
Server remains distroless.

## Backup schedule and operator jobs

The chart does not create backup work by default. `backupSchedule.enabled=true` is an explicit opt-in
that creates one `batch/v1` CronJob running the same pinned Server image and exact `backup create`
engine used by the CLI and admin surface. It uses `concurrencyPolicy: Forbid`, a starting deadline,
an active deadline, bounded retries and bounded successful/failed history. The Server-side Instance
lock remains authoritative if a CLI or admin request races the CronJob. Choose and review the IANA
timezone explicitly; this schedule is a Kubernetes CronJob schedule, not the product scheduler.

```yaml
backupSchedule:
  enabled: true
  schedule: "0 2 * * *"
  timeZone: Asia/Seoul
  startingDeadlineSeconds: 900
  activeDeadlineSeconds: 14400
  backoffLimit: 0
  successfulJobsHistoryLimit: 3
  failedJobsHistoryLimit: 3
```

The toolbox is also disabled by default. It deliberately exposes only remote `create`, `list` and
`verify`; restore cannot be smuggled through the generic operation field, and the local-directory
`import`/`prune` commands are not presented as cluster operations. Render it separately, inspect
the exact digest, argv and target refs, create the Job, and only then unsuspend that Job. Do not set
`toolbox.enabled` in a long-lived Helm release: a completed Job is immutable operational evidence, not
declarative application state.

```sh
helm template nuriteo charts/nuriteo --namespace nuriteo \
  --show-only templates/toolbox-job.yaml \
  --set toolbox.enabled=true \
  --set toolbox.operation=list > nuriteo-toolbox.yaml
kubectl create -f nuriteo-toolbox.yaml
kubectl patch job nuriteo-nuriteo-toolbox -n nuriteo \
  --type=merge -p '{"spec":{"suspend":false}}'
```

Restore has a separate fail-closed template and is never scheduled or started by rendering. Enabling
the template requires a complete restore-point UUID, an operator target identity, separate target
PostgreSQL and Object Storage Secret references, plus acknowledgements that Maintenance Mode is active,
writes are drained, and the target was validated. The rendered Job is still `suspend: true`. At runtime
the Server independently rejects the production database identity, the production endpoint/bucket pair,
a non-empty target, an incomplete restore point, or incompatible release data. The acknowledgements are
operator cutover evidence; they are not presented as runtime enforcement. There is no chart-specific
restore implementation.

```sh
helm template nuriteo charts/nuriteo --namespace nuriteo \
  --show-only templates/restore-job.yaml \
  --set restore.enabled=true \
  --set-string restore.restorePointId=0199ee6c-c777-7000-8000-000000007099 \
  --set-string restore.target.identity=isolated-drill \
  --set-string restore.target.postgresql.existingSecret.name=nuriteo-restore-postgresql \
  --set-string restore.target.objectStorage.endpoint=https://restore-s3.example.com \
  --set-string restore.target.objectStorage.bucket=nuriteo-restore \
  --set-string restore.target.objectStorage.existingSecret.name=nuriteo-restore-storage \
  --set restore.fence.maintenanceModeAcknowledged=true \
  --set restore.fence.writesDrainedAcknowledged=true \
  --set restore.fence.targetValidatedAcknowledged=true > nuriteo-restore.yaml
# Inspect the immutable digest, `backup restore` argv, restore-point and target
# annotations. Create it only while the application is in Maintenance Mode.
kubectl create -f nuriteo-restore.yaml
kubectl patch job nuriteo-nuriteo-restore -n nuriteo \
  --type=merge -p '{"spec":{"suspend":false}}'
```

All three operation types require the dedicated `backupStorage` destination and Secret reference,
disable ServiceAccount token automount, run as UID/GID 65532 with
RuntimeDefault seccomp, drop every capability, use a read-only root filesystem, and mount existing
Secret files read-only with mode `0400`. Their `/tmp` scratch `emptyDir` is ephemeral and bounded;
size it with `backupStorage.scratchSizeLimit` before using larger datasets.

## Pod security, disruption, and network isolation

Every Pod runs as non-root UID/GID 65532 with RuntimeDefault seccomp, no privilege escalation, a
read-only root filesystem and all Linux capabilities dropped. CPU/memory requests and memory limits are
declared for every workload. Core and Web each render a `policy/v1` PodDisruptionBudget with
`minAvailable: 1`; the chart rejects a minimum above the configured replica count. A one-replica install
therefore deliberately blocks voluntary eviction. Scale the component before draining a node instead of
disabling its budget during normal operation.

Full NetworkPolicy isolation is opt-in because Kubernetes policies cannot safely infer IP ranges from
PostgreSQL, S3, OIDC, SMTP, Git or registry DNS names. Enabling it without at least one explicit dependency
CIDR fails schema validation. The restricted profile installs default deny, permits Ingress-controller →
Web, Web → Core, selected DNS, and only the configured TCP ports to the configured CIDRs. It has no
implicit public-network or private-network fallback.

```yaml
networkPolicy:
  enabled: true
  ingressController:
    namespaceLabels:
      kubernetes.io/metadata.name: ingress-nginx
    podLabels:
      app.kubernetes.io/name: ingress-nginx
  dns:
    namespaceLabels:
      kubernetes.io/metadata.name: kube-system
    podLabels:
      k8s-app: kube-dns
  externalEgress:
    cidrBlocks:
      - 10.42.0.0/16
    tcpPorts: [443, 465, 587, 5432]
```

List every actual dependency CIDR and custom port before enabling the profile. For endpoints with rotating
addresses, use a CNI/FQDN policy maintained by the cluster operator and keep this chart profile disabled;
do not widen it to `0.0.0.0/0` merely to make an incomplete inventory pass.

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

The release lifecycle qualification uses a disposable kind cluster and five distinct fixture images. It
proves clean install, preflight failure fencing, forward upgrade, Helm rollback, uninstall, and preservation
of operator-owned Secrets. Podman is the local default:

```sh
charts/nuriteo/tests/kind-release.sh
```

Docker-based CI uses the same test with `KIND_EXPERIMENTAL_PROVIDER=docker` and
`NURITEO_CONTAINER_RUNTIME=docker`. The test deletes its temporary cluster and fixture images on exit.
