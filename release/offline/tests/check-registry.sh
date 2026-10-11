#!/bin/sh
set -eu

repository=$(CDPATH= cd -- "$(dirname "$0")/../../.." && pwd)
work=${1:?usage: check-registry.sh WORK_DIRECTORY REGISTRY_HOST_PORT}
registry=${2:?registry host and port are required}
bundle="$work/bundle"
certificates="$work/certificates"
source_archive="$work/source.oci.tar"
chart_archive="$work/nuriteo-0.1.0.tgz"

command -v node >/dev/null 2>&1 || { echo 'node is required' >&2; exit 1; }
command -v podman >/dev/null 2>&1 || { echo 'podman is required' >&2; exit 1; }
command -v skopeo >/dev/null 2>&1 || { echo 'skopeo is required' >&2; exit 1; }
[ -f "$source_archive" ] || { echo 'source OCI archive is missing' >&2; exit 1; }
[ -d "$certificates" ] || { echo 'registry CA directory is missing' >&2; exit 1; }
[ -f "$chart_archive" ] || helm package "$repository/charts/nuriteo" --destination "$work" >/dev/null

mkdir -p "$bundle"
node - "$repository" "$bundle" "$source_archive" "$chart_archive" <<'NODE'
const fs = require("node:fs");
const path = require("node:path");
const { pathToFileURL } = require("node:url");

(async () => {
  const [repository, bundle, archive, chartArchive] = process.argv.slice(2);
  const inventory = JSON.parse(fs.readFileSync(path.join(repository, "release/offline/inventory-v1.json"), "utf8"));
  const module = await import(pathToFileURL(path.join(repository, "tooling/release/offline-manifest.mjs")));
  const artifacts = module.validateInventory(inventory);
  const inspected = JSON.parse(require("node:child_process").execFileSync("skopeo", ["inspect", `oci-archive:${archive}`], { encoding: "utf8" }));
  for (const artifact of artifacts.values()) {
    const destination = path.join(bundle, artifact.path);
    fs.mkdirSync(path.dirname(destination), { recursive: true });
    if (["verify", "verify-install", "import-images", "render-config"].includes(artifact.id)) {
      fs.copyFileSync(path.join(repository, "release/offline/scripts", artifact.id), destination);
      fs.chmodSync(destination, 0o755);
    } else if (artifact.kind === "oci-image") {
      fs.copyFileSync(archive, destination);
    } else if (artifact.kind === "helm-chart") {
      fs.copyFileSync(chartArchive, destination);
    } else if (artifact.kind === "oci-digest") {
      fs.writeFileSync(destination, `${inspected.Digest}\n`);
    } else {
      fs.writeFileSync(destination, `${artifact.id}\n`);
    }
  }
  const manifest = module.buildManifest(inventory, bundle, "b".repeat(40), "2026-10-11T00:00:00.000Z");
  fs.writeFileSync(path.join(bundle, "release-manifest.json"), `${JSON.stringify(manifest, null, 2)}\n`);
})().catch((error) => { console.error(error); process.exit(1); });
NODE

"$bundle/scripts/import-images" "$bundle" "$registry" nuriteo "$certificates" >"$work/imported-images.txt"
"$bundle/scripts/verify-install" "$bundle" "$registry" nuriteo "$work/install" 10.42.0.0/16
cp "$work/install/rendered-install.yaml" "$work/rendered.yaml"

expected=$(wc -l <"$work/imported-images.txt" | tr -d ' ')
[ "$expected" = 6 ] || { echo 'all six release images were not imported' >&2; exit 1; }
grep -F "${registry}/nuriteo/server@" "$work/rendered.yaml" >/dev/null || { echo 'server image override missing' >&2; exit 1; }
grep -F "${registry}/nuriteo/web@" "$work/rendered.yaml" >/dev/null || { echo 'web image override missing' >&2; exit 1; }
grep -F "${registry}/nuriteo/operations@" "$work/rendered.yaml" >/dev/null || { echo 'operations image override missing' >&2; exit 1; }
grep -Eq 'docker\.io|ghcr\.io' "$work/rendered.yaml" && { echo 'public registry fallback found' >&2; exit 1; }
jq -e '.networkPolicy.defaultDeny == true and .networkPolicy.externalEgressCidrs == ["10.42.0.0/16"]' \
  "$work/install/install-plan.json" >/dev/null

echo 'TLS internal registry import and Helm override ok'
