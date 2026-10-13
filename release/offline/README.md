# Offline release manifest

`inventory-v1.json` is the allowlist for the Self-hosted v1 Core Bundle and optional Quickstart
Add-on Bundle. It is source-controlled; a release job must not discover files and silently add them.

The release station stages exactly the listed paths, writes each OCI manifest digest into its declared
`.digest` file, and then creates the immutable manifest:

```sh
node tooling/release/offline-manifest.mjs build \
  --inventory release/offline/inventory-v1.json \
  --root /path/to/nuriteo-offline-1.0.0-rc.1 \
  --manifest /path/to/nuriteo-offline-1.0.0-rc.1/release-manifest.json \
  --source-commit 0123456789abcdef0123456789abcdef01234567 \
  --created-at 2026-10-11T00:00:00.000Z
```

The build fails for a missing or undeclared file, symlink, unsafe path, unknown license/SBOM reference,
malformed OCI digest, or all-zero digest sentinel. Every artifact receives a byte length and SHA-256;
every OCI archive additionally receives its registry/OCI manifest digest and at least one SPDX SBOM.

At the import station, after offline GitHub attestation verification, run:

```sh
node tooling/release/offline-manifest.mjs verify \
  --inventory release/offline/inventory-v1.json \
  --root /path/to/nuriteo-offline-1.0.0-rc.1 \
  --manifest /path/to/nuriteo-offline-1.0.0-rc.1/release-manifest.json
```

Verification recomputes the complete manifest and rejects content, metadata, inventory or file-set
drift. `release-manifest-v1.schema.json` is included in the Core Bundle for offline tooling. The checked-in
repository intentionally contains the inventory and schema, not a pretend finalized release manifest;
the latter can exist only after all OCI archives, SBOMs, licenses, trusted root and attestations have been
assembled from one source commit.

## Internal registry import

The import station needs POSIX `sh`, `jq`, and `skopeo`. Supply the internal registry as a bare
`host[:port]`, a namespace, and an explicit registry certificate directory. For an authenticated
registry, pass a containers-auth JSON file as the optional fifth argument. The tooling never disables
TLS verification and never falls back to a public registry.

```sh
./scripts/verify /media/nuriteo-offline-1.0.0-rc.1
./scripts/import-images \
  /media/nuriteo-offline-1.0.0-rc.1 \
  registry.internal:5443 nuriteo /etc/nuriteo/registry-certs \
  /etc/nuriteo/registry-auth.json
```

The import first verifies the complete bundle, preserves each OCI manifest digest while copying, and
then reads the object back from the internal registry. Any CA, authentication, copy, or digest mismatch
stops the operation. Registry trust must also be installed on every container runtime node; the bundle
does not mutate host trust stores.

Generate digest-pinned Helm and Compose overrides into a new private directory:

```sh
./scripts/render-config \
  /media/nuriteo-offline-1.0.0-rc.1 \
  registry.internal:5443 nuriteo ./nuriteo-airgap-config

helm upgrade --install nuriteo ./core/helm/nuriteo-0.1.0.tgz \
  --values ./nuriteo-airgap-config/helm-values-airgap.yaml
```

The Helm chart archive is installed from the bundle. Operators must mirror any separately approved
ingress, monitoring, or storage dependencies themselves; NURITEO does not contact an external chart or
image registry during this procedure.

Before applying the chart, generate and verify a restricted installation plan. Every PostgreSQL, S3,
OIDC, SMTP, Git or other external dependency network must be listed explicitly; a default route such as
`0.0.0.0/0` or `::/0` is rejected.

```sh
./scripts/verify-install \
  /media/nuriteo-offline-1.0.0-rc.1 \
  registry.internal:5443 nuriteo ./verified-install \
  10.40.12.0/24 10.40.18.32/28

helm upgrade --install nuriteo ./core/helm/nuriteo-0.1.0.tgz \
  --values ./verified-install/configuration/helm-values-airgap.yaml
```

The verifier renders the bundled chart only, requires the four-policy default-deny profile, rejects
public or tag-only workload images, and writes `install-plan.json` with the exact registry, images and
allowed dependency CIDRs. Keep that plan with the installation evidence.

## RC convergence qualification

The RC qualification assembles the actual Compose definitions, Helm chart, compatibility manifest and
offline scripts into one temporary Core Bundle. It verifies that bundle without network access, renders
the restricted installation plan, and checks that the repository execution graph contains only the
canonical Web, Rust Server and Workspace Runtime surfaces:

```sh
pnpm check:rc-offline-convergence
```

This qualification uses synthetic OCI payload bytes because image publication belongs to the final
release gate. The manifest digests, file inventory, bundled deployment content, release lineage and
fail-closed installation behavior are real. `GATE-006` replaces the synthetic image entries with the
fixed RC image archives and reruns the aggregate.
