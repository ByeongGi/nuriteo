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
