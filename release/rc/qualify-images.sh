#!/usr/bin/env bash
set -Eeuo pipefail

root="$(cd "$(dirname "${BASH_SOURCE[0]}")/../.." && pwd)"
manifest="$root/release/rc/1.0.0-rc.1.json"
runtime="${CONTAINER_RUNTIME:-podman}"
work="$(mktemp -d "${TMPDIR:-/tmp}/nuriteo-gate006.XXXXXX")"
cleanup() { rm -rf -- "$work"; }
trap cleanup EXIT HUP INT TERM

for command in "$runtime" jq skopeo; do command -v "$command" >/dev/null; done

for role in server web operations; do
  reference="$(jq -r --arg role "$role" '.images[] | select(.role == $role) | .reference' "$manifest")"
  expected_digest="$(jq -r --arg role "$role" '.images[] | select(.role == $role) | .digest' "$manifest")"
  expected_local_digest="$(jq -r --arg role "$role" '.images[] | select(.role == $role) | .localDigest' "$manifest")"
  expected_user="$(jq -r --arg role "$role" '.images[] | select(.role == $role) | .user' "$manifest")"
  expected_entrypoint="$(jq -c --arg role "$role" '.images[] | select(.role == $role) | .entrypoint' "$manifest")"
  expected_revision="$(jq -r '.sourceCommit' "$manifest")"

  test "$("$runtime" image inspect "$reference" --format '{{.Digest}}')" = "$expected_local_digest"
  test "$("$runtime" image inspect "$reference" --format '{{.Config.User}}')" = "$expected_user"
  test "$("$runtime" image inspect "$reference" --format '{{json .Config.Entrypoint}}')" = "$expected_entrypoint"
  test "$("$runtime" image inspect "$reference" --format '{{index .Config.Labels "org.opencontainers.image.revision"}}')" = "$expected_revision"
  test "$("$runtime" image inspect "$reference" --format '{{index .Config.Labels "org.opencontainers.image.version"}}')" = '1.0.0-rc.1'

  archive="$work/${role}.oci.tar"
  "$runtime" save --format oci-archive --output "$archive" "$reference"
  test "$(skopeo inspect "oci-archive:$archive" | jq -r .Digest)" = "$expected_digest"
done

NURITEO_RC_IMAGE_ARCHIVE_DIR="$work" NURITEO_RC_MANIFEST="$manifest" \
  node "$root/release/offline/tests/check-convergence.mjs" >/dev/null

"$runtime" run --rm localhost/nuriteo-server:1.0.0-rc.1 --help >/dev/null
"$runtime" run --rm --entrypoint pg_dump localhost/nuriteo-operations:1.0.0-rc.1 --version >/dev/null
"$runtime" run --rm --entrypoint pg_restore localhost/nuriteo-operations:1.0.0-rc.1 --version >/dev/null
NURITEO_WEB_IMAGE=localhost/nuriteo-web:1.0.0-rc.1 NURITEO_WEB_SKIP_BUILD=1 \
  "$root/deploy/docker/test-web-image.sh" >/dev/null

printf '%s\n' '{"status":"pass","gate":"GATE-006","images":3,"ociArchives":3,"revisionBound":true}'
