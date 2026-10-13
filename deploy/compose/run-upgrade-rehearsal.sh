#!/usr/bin/env bash
set -Eeuo pipefail

root="$(cd "$(dirname "${BASH_SOURCE[0]}")/../.." && pwd)"
fixture="$root/deploy/compose/fixtures/upgrade-rehearsal"
project="nuriteo-rc002-${RANDOM}"
work="$(mktemp -d "${TMPDIR:-/tmp}/nuriteo-rc002.XXXXXX")"
keep="${NURITEO_UPGRADE_REHEARSAL_KEEP:-0}"
registry_port="${NURITEO_UPGRADE_REGISTRY_PORT:-$((24000 + RANDOM % 10000))}"
registry="localhost:${registry_port}"
registry_container="${project}-registry"

if [ -n "${NURITEO_CONTAINER_ENGINE:-}" ]; then
  engine="$NURITEO_CONTAINER_ENGINE"
elif docker info >/dev/null 2>&1; then
  engine=docker
else
  engine=podman
fi
if "$engine" compose version >/dev/null 2>&1; then
  compose_provider=("$engine" compose)
  helper_provider="$engine compose"
elif command -v podman-compose >/dev/null 2>&1; then
  compose_provider=(podman-compose --in-pod false)
  helper_provider="podman-compose --in-pod false"
elif command -v uvx >/dev/null 2>&1; then
  compose_provider=(uvx --from podman-compose==1.5.0 podman-compose --in-pod false)
  helper_provider="uvx --from podman-compose==1.5.0 podman-compose --in-pod false"
else
  echo "no Compose provider found" >&2
  exit 1
fi
compose=("${compose_provider[@]}" --project-name "$project" --file "$fixture/compose.yaml")
images=(
  "$registry/nuriteo-upgrade-source-server:${project}"
  "$registry/nuriteo-upgrade-source-web:${project}"
  "$registry/nuriteo-upgrade-target-server:${project}"
  "$registry/nuriteo-upgrade-target-web:${project}"
)
refs=()
volume=""

cleanup() {
  if [ "$keep" = 1 ]; then
    echo "upgrade rehearsal retained: project=$project work=$work" >&2
    return
  fi
  "${compose[@]}" down --volumes --remove-orphans >/dev/null 2>&1 || true
  "$engine" rm --force "$registry_container" >/dev/null 2>&1 || true
  [ -z "$volume" ] || "$engine" volume rm --force "$volume" >/dev/null 2>&1 || true
  "$engine" image rm --force "${images[@]}" >/dev/null 2>&1 || true
  if [ "${#refs[@]}" -gt 0 ]; then
    "$engine" image rm --force "${refs[@]}" >/dev/null 2>&1 || true
  fi
  rm -rf -- "$work"
}
trap cleanup EXIT HUP INT TERM

"$engine" run --detach --name "$registry_container" --publish "127.0.0.1:${registry_port}:5000" \
  docker.io/library/registry:2.8.3 >/dev/null

for spec in \
  "${images[0]} source server" \
  "${images[1]} source web" \
  "${images[2]} target server" \
  "${images[3]} target web"; do
  read -r image release role <<<"$spec"
  "$engine" build --quiet --file "$fixture/Containerfile" \
    --build-arg "FIXTURE_RELEASE=$release" --build-arg "FIXTURE_ROLE=$role" \
    --label "io.nuriteo.fixture.release=$release" --label "io.nuriteo.fixture.role=$role" \
    --tag "$image" "$fixture" >/dev/null
  if [ "$engine" = podman ]; then
    "$engine" push --tls-verify=false "$image" >/dev/null
  else
    "$engine" push "$image" >/dev/null
  fi
done

image_ref() {
  local image="$1" digest reference repository tag
  repository="${image#*/}"
  tag="${repository##*:}"
  repository="${repository%:*}"
  digest="$(curl --fail --silent --dump-header - --output /dev/null \
    --header 'Accept: application/vnd.oci.image.manifest.v1+json, application/vnd.docker.distribution.manifest.v2+json' \
    "http://$registry/v2/$repository/manifests/$tag" \
    | awk 'tolower($1) == "docker-content-digest:" {gsub("\\r", "", $2); print $2}')"
  [ -n "$digest" ] || { echo "registry digest is missing for $image" >&2; return 1; }
  reference="${image%:*}@$digest"
  if [ "$engine" = podman ]; then
    "$engine" pull --tls-verify=false "$reference" >/dev/null
  else
    "$engine" pull "$reference" >/dev/null
  fi
  printf '%s\n' "$reference"
}

source_server="$(image_ref "${images[0]}")"
source_web="$(image_ref "${images[1]}")"
target_server="$(image_ref "${images[2]}")"
target_web="$(image_ref "${images[3]}")"
refs=("$source_server" "$source_web" "$target_server" "$target_web")

SOURCE_SERVER="$source_server" SOURCE_WEB="$source_web" TARGET_SERVER="$target_server" TARGET_WEB="$target_web" \
  WORK_DIR="$work" ROOT_DIR="$root" node --input-type=module <<'NODE'
import crypto from "node:crypto";
import fs from "node:fs";

const digest = (reference) => reference.slice(reference.indexOf("@") + 1);
const sha256 = (file) => crypto.createHash("sha256").update(fs.readFileSync(file)).digest("hex");
const compatibility = JSON.parse(fs.readFileSync(`${process.env.ROOT_DIR}/compat/self-hosted-upgrade-compatibility-v1.json`, "utf8"));
compatibility.images.roles = compatibility.images.roles.map((role) => {
  if (role.name === "server") return { ...role, digest: digest(process.env.SOURCE_SERVER) };
  if (role.name === "web") return { ...role, digest: digest(process.env.SOURCE_WEB) };
  return role;
});
const compatibilityPath = `${process.env.WORK_DIR}/compatibility.json`;
fs.writeFileSync(compatibilityPath, `${JSON.stringify(compatibility, null, 2)}\n`);

const target = {
  schemaVersion: 1,
  releaseLineage: compatibility.releaseLineage,
  release: compatibility.support.upgradeTo,
  images: {
    identity: "sha256-digest",
    setPolicy: "complete-release-set",
    roles: [
      { name: "server", digest: digest(process.env.TARGET_SERVER) },
      { name: "web", digest: digest(process.env.TARGET_WEB) },
    ],
  },
  rollback: {
    compatibleApplications: [compatibility.support.upgradeFrom],
    schemaMinimum: 46,
    schemaMaximum: 50,
    objectFormats: ["project-bundle-v1"],
    database: "preserve-current-schema",
    downMigration: "forbidden",
  },
};
const targetPath = `${process.env.WORK_DIR}/target.json`;
fs.writeFileSync(targetPath, `${JSON.stringify(target, null, 2)}\n`);

const plan = {
  schemaVersion: 1,
  compatibilityManifest: compatibilityPath,
  compatibilityManifestSha256: sha256(compatibilityPath),
  targetReleaseManifest: targetPath,
  targetReleaseManifestSha256: sha256(targetPath),
  source: {
    release: compatibility.support.upgradeFrom,
    migration: 46,
    serverImage: process.env.SOURCE_SERVER,
    webImage: process.env.SOURCE_WEB,
  },
  target: {
    release: compatibility.support.upgradeTo,
    migration: 50,
    serverImage: process.env.TARGET_SERVER,
    webImage: process.env.TARGET_WEB,
  },
  objects: {
    readFormats: ["project-bundle-v1"],
    writeFormat: "project-bundle-v1",
    existingObjectPolicy: "read-in-place",
    rewritePolicy: "forbidden-during-upgrade",
  },
  upgrade: { direction: "forward-only", failurePolicy: "stop-before-mutation" },
  rollback: {
    applicationRelease: compatibility.support.upgradeFrom,
    schemaMinimum: 46,
    schemaMaximum: 50,
    objectFormats: ["project-bundle-v1"],
    database: "preserve-current-schema",
    downMigration: "forbidden",
  },
};
fs.writeFileSync(`${process.env.WORK_DIR}/plan.json`, `${JSON.stringify(plan, null, 2)}\n`);
NODE

volume="${project}_state"
"$engine" volume create "$volume" >/dev/null
"$engine" run --rm --volume "$volume:/state" docker.io/library/busybox:1.37.0 \
  sh -eu -c 'printf "46\n" >/state/schema; printf "project-bundle-v1:preserve-me\n" >/state/object'

export NURITEO_COMPOSE_COMMAND="$helper_provider --project-name $project"
export NURITEO_COMPOSE_FILE="$fixture/compose.yaml"
export NURITEO_COMPOSE_PROJECT_NAME="$project"
export NURITEO_SERVER_IMAGE="$source_server"
export NURITEO_WEB_IMAGE="$source_web"
"${compose[@]}" up --detach core web >/dev/null

export FIXTURE_PREFLIGHT_FAIL=true
if node "$root/deploy/compose/upgrade.mjs" upgrade "$work/plan.json" >/dev/null 2>&1; then
  echo "preflight failure injection unexpectedly succeeded" >&2
  exit 1
fi
unset FIXTURE_PREFLIGHT_FAIL
test "$("$engine" run --rm --volume "$volume:/state" docker.io/library/busybox:1.37.0 cat /state/schema)" = 46

node "$root/deploy/compose/upgrade.mjs" upgrade "$work/plan.json"
test "$("$engine" run --rm --volume "$volume:/state" docker.io/library/busybox:1.37.0 cat /state/schema)" = 50
test "$("$engine" run --rm --volume "$volume:/state" docker.io/library/busybox:1.37.0 cat /state/object)" = "project-bundle-v1:preserve-me"

node "$root/deploy/compose/upgrade.mjs" rollback "$work/plan.json"
test "$("$engine" run --rm --volume "$volume:/state" docker.io/library/busybox:1.37.0 cat /state/schema)" = 50
test "$("$engine" run --rm --volume "$volume:/state" docker.io/library/busybox:1.37.0 cat /state/object)" = "project-bundle-v1:preserve-me"

printf '%s\n' '{"status":"pass","sourceMigration":46,"targetMigration":50,"objectPreserved":true,"rollback":"application-only"}'
