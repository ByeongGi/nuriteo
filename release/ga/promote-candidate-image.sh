#!/usr/bin/env bash
set -Eeuo pipefail

source_root="${1:?source checkout is required}"
report="${2:?REL-001 report is required}"
role="${3:?image role is required}"
platform="${4:?image platform is required}"
arch="${platform#linux/}"
registry="${NURITEO_CANDIDATE_REGISTRY:-ghcr.io/byeonggi}"

case "$role" in server|web|operations) ;; *) echo "unsupported role: $role" >&2; exit 2 ;; esac
case "$platform" in linux/amd64|linux/arm64) ;; *) echo "unsupported platform: $platform" >&2; exit 2 ;; esac

revision="$(jq -r .sourceCommit "$report")"
epoch="$(jq -r .sourceDateEpoch "$report")"
created="$(jq -r .created "$report")"
version="$(jq -r .version "$report")"
expected="$(jq -r --arg role "$role" --arg platform "$platform" \
  '.images[] | select(.role == $role and .platform == $platform) | .digest' "$report")"
test "$revision" = "$(git -C "$source_root" rev-parse HEAD)"
[[ "$expected" =~ ^sha256:[0-9a-f]{64}$ ]]

work="$(mktemp -d "${TMPDIR:-/tmp}/nuriteo-promote.XXXXXX")"
trap 'rm -rf -- "$work"' EXIT HUP INT TERM
archive="$work/${role}-${arch}.oci.tar"
SOURCE_DATE_EPOCH="$epoch" BUILDX_NO_DEFAULT_ATTESTATIONS=1 docker buildx build \
  --no-cache --platform "$platform" --provenance=false --sbom=false \
  --build-arg "NURITEO_SOURCE_DATE_EPOCH=$epoch" \
  --build-arg "BUILD_VERSION=$version" \
  --build-arg "BUILD_REVISION=$revision" \
  --build-arg "BUILD_CREATED=$created" \
  --file "$source_root/deploy/docker/${role}.Dockerfile" \
  --output "type=oci,dest=$archive,rewrite-timestamp=true" "$source_root"

actual="$(skopeo inspect "oci-archive:$archive" | jq -r .Digest)"
test "$actual" = "$expected"
reference="$registry/nuriteo-$role:ga-${revision:0:12}-$arch"
skopeo copy --preserve-digests "oci-archive:$archive" "docker://$reference"
remote="$(skopeo inspect "docker://$reference" | jq -r .Digest)"
test "$remote" = "$expected"
jq -n --arg role "$role" --arg platform "$platform" --arg reference "$reference" \
  --arg digest "$expected" --arg sourceCommit "$revision" \
  '{schemaVersion:1,status:"PASS",role:$role,platform:$platform,reference:$reference,digest:$digest,sourceCommit:$sourceCommit}'
