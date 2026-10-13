#!/usr/bin/env bash
set -Eeuo pipefail

root="$(cd "$(dirname "${BASH_SOURCE[0]}")/../.." && pwd)"
runtime="${CONTAINER_RUNTIME:-podman}"
builder="${NURITEO_REPRO_BUILDER:-podman}"
version="${NURITEO_BUILD_VERSION:-1.0.0}"
revision="${NURITEO_BUILD_REVISION:-$(git -C "$root" rev-parse HEAD)}"
epoch="${SOURCE_DATE_EPOCH:-$(git -C "$root" show -s --format=%ct "$revision")}" 
if date -u -d "@$epoch" '+%Y-%m-%dT%H:%M:%SZ' >/dev/null 2>&1; then
  epoch_created="$(date -u -d "@$epoch" '+%Y-%m-%dT%H:%M:%SZ')"
else
  epoch_created="$(date -u -r "$epoch" '+%Y-%m-%dT%H:%M:%SZ')"
fi
created="${NURITEO_BUILD_CREATED:-$epoch_created}"
platforms="${NURITEO_REPRO_PLATFORMS:-linux/amd64 linux/arm64}"
roles="${NURITEO_REPRO_ROLES:-server web operations}"
output="${NURITEO_REPRO_REPORT:-$root/release/ga/reproducible-images.json}"
work="$(mktemp -d "${TMPDIR:-/tmp}/nuriteo-rel001.XXXXXX")"
tags=()
keep_work="${NURITEO_REPRO_KEEP_WORK:-false}"

cleanup() {
  if [ "$keep_work" = true ]; then
    printf 'REL-001 debug artifacts retained: %s\n' "$work" >&2
    return
  fi
  for tag in "${tags[@]}"; do "$runtime" rmi --force "$tag" >/dev/null 2>&1 || true; done
  rm -rf -- "$work"
}
trap cleanup EXIT HUP INT TERM

for command in "$runtime" git jq skopeo; do command -v "$command" >/dev/null; done
case "$builder" in podman|buildx) ;; *) echo "unsupported reproducible builder: $builder" >&2; exit 2 ;; esac
if [ "$builder" = buildx ] && [ "$runtime" != docker ]; then
  echo "buildx mode requires CONTAINER_RUNTIME=docker" >&2
  exit 2
fi
test "$revision" = "$(git -C "$root" rev-parse HEAD)"
test -z "$(git -C "$root" status --porcelain --untracked-files=no)"
[[ "$revision" =~ ^[0-9a-f]{40}$ ]]
[[ "$epoch" =~ ^[0-9]+$ ]]

printf '[]' >"$work/results.json"
for platform in $platforms; do
  arch="${platform#linux/}"
  case "$platform" in linux/amd64|linux/arm64) ;; *) echo "unsupported platform: $platform" >&2; exit 2 ;; esac
  for role in $roles; do
    case "$role" in server|web|operations) ;; *) echo "unsupported role: $role" >&2; exit 2 ;; esac
    digests=()
    for pass in 1 2; do
      archive="$work/${role}-${arch}-${pass}.oci.tar"
      if [ "$builder" = buildx ]; then
        SOURCE_DATE_EPOCH="$epoch" BUILDX_NO_DEFAULT_ATTESTATIONS=1 \
          "$runtime" buildx build --no-cache --platform "$platform" \
          --provenance=false --sbom=false \
          --build-arg "NURITEO_SOURCE_DATE_EPOCH=$epoch" \
          --build-arg "BUILD_VERSION=$version" \
          --build-arg "BUILD_REVISION=$revision" \
          --build-arg "BUILD_CREATED=$created" \
          --file "$root/deploy/docker/${role}.Dockerfile" \
          --output "type=oci,dest=$archive,rewrite-timestamp=true" "$root"
      else
        tag="localhost/nuriteo-${role}:rel001-${arch}-${pass}"
        tags+=("$tag")
        "$runtime" build --no-cache --layers=false --platform "$platform" --timestamp "$epoch" \
          --build-arg "NURITEO_SOURCE_DATE_EPOCH=$epoch" \
          --build-arg "BUILD_VERSION=$version" \
          --build-arg "BUILD_REVISION=$revision" \
          --build-arg "BUILD_CREATED=$created" \
          --file "$root/deploy/docker/${role}.Dockerfile" --tag "$tag" "$root"
        "$runtime" save --format oci-archive --output "$archive" "$tag"
      fi
      digest="$(skopeo inspect "oci-archive:$archive" | jq -r .Digest)"
      [[ "$digest" =~ ^sha256:[0-9a-f]{64}$ ]]
      digests+=("$digest")
      printf '%s\n' "$role $platform pass=$pass digest=$digest"
      if [ "$builder" = podman ] && [ "$keep_work" != true ]; then "$runtime" rmi --force "$tag" >/dev/null; fi
    done
    test "${digests[0]}" = "${digests[1]}"
    jq --arg role "$role" --arg platform "$platform" --arg digest "${digests[0]}" \
      '. + [{role:$role,platform:$platform,digest:$digest,passes:2}]' \
      "$work/results.json" >"$work/results.next.json"
    mv "$work/results.next.json" "$work/results.json"
  done
done

mkdir -p "$(dirname "$output")"
jq -n --arg taskId REL-001 --arg status PASS --arg version "$version" \
  --arg sourceCommit "$revision" --argjson sourceDateEpoch "$epoch" \
  --arg created "$created" --slurpfile images "$work/results.json" \
  '{schemaVersion:1,taskId:$taskId,status:$status,version:$version,sourceCommit:$sourceCommit,
    sourceDateEpoch:$sourceDateEpoch,created:$created,images:$images[0]}' >"$output"
jq -c '{status:(.status|ascii_downcase),task:.taskId,images:(.images|length),sourceCommit}' "$output"
