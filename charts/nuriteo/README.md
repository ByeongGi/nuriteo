# NURITEO Helm Chart

This is the `K8S-001` chart skeleton. It freezes the values schema and the paired,
digest-only Server/Web image contract. The only rendered Kubernetes object is a
release-contract ConfigMap; application workloads intentionally arrive in
`K8S-003` after existing-Secret wiring and rollout checks are implemented.

## Contract

- Kubernetes 1.29 or newer.
- External PostgreSQL is mandatory and remains outside the Helm release lifecycle.
- External HTTPS S3-compatible storage is the initial production profile.
- Server and Web are one release pair and must use `sha256` digests, never mutable tags.
- Secrets are referenced by existing Secret name and key. Secret values are not Helm values.
- `global.imageRegistry` can point to an internal mirror; it never falls back to GHCR.
- The canonical URL is an HTTPS origin at `/`; subpath deployment is unsupported.

Before installing a later workload-capable chart, replace every example endpoint and
Secret reference in a private values file. Do not put credentials in that file.

## Validate

```sh
helm lint --strict charts/nuriteo
helm template nuriteo charts/nuriteo --namespace nuriteo
charts/nuriteo/tests/check-chart.sh
```

