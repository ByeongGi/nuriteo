#!/usr/bin/env bash
set -Eeuo pipefail

root="$(cd "$(dirname "${BASH_SOURCE[0]}")/../.." && pwd)"
artifacts="${NURITEO_GA_ARTIFACTS:-$root/release/ga/artifacts}"
public_key="${NURITEO_GA_PUBLIC_KEY:?NURITEO_GA_PUBLIC_KEY is required}"
runtime="${CONTAINER_RUNTIME:-podman}"
compose_provider="${NURITEO_COMPOSE_PROVIDER:-uvx}"
report="$root/release/ga/qualification-report.json"

for variable in NURITEO_SERVER_IMAGE NURITEO_WEB_IMAGE NURITEO_OPERATIONS_IMAGE; do
  value="${!variable:-}"
  [[ "$value" =~ @sha256:[0-9a-f]{64}$ ]] || { echo "$variable must be digest-pinned" >&2; exit 2; }
done

"$root/release/ga/verify-supply-chain.sh" "$public_key" "$artifacts"
node "$root/release/ga/verify-chart-binding.mjs" "$artifacts/nuriteo-1.0.0.chart-images.json"
node "$root/release/ga/verify-release-manifest.mjs" "$artifacts"

NURITEO_COMPOSE_PROVIDER="$compose_provider" \
NURITEO_COMPOSE_SKIP_APP_BUILD=1 \
NURITEO_SERVER_IMAGE="$NURITEO_SERVER_IMAGE" \
NURITEO_WEB_IMAGE="$NURITEO_WEB_IMAGE" \
NURITEO_OPERATIONS_IMAGE="$NURITEO_OPERATIONS_IMAGE" \
  "$root/deploy/compose/test-compose.sh"

CONTAINER_RUNTIME="$runtime" "$root/crates/nuriteo-server/tests/fixtures/backup-restore/run.sh"
NURITEO_CONTAINER_ENGINE="$runtime" "$root/deploy/compose/run-upgrade-rehearsal.sh"
CONTAINER_RUNTIME="$runtime" "$root/charts/nuriteo/tests/kind-release.sh"

source_commit="$(jq -r .sourceCommit "$artifacts/nuriteo-1.0.0.release.json")"
jq -n --arg sourceCommit "$source_commit" \
  '{schemaVersion:1,taskId:"QUAL-004",status:"PASS",release:"1.0.0",sourceCommit:$sourceCommit,
    signedArtifacts:true,cleanEnvironment:true,
    phases:{verify:true,install:true,betaJourney:true,backup:true,upgrade:true,restore:true,helm:true}}' >"$report"
jq -c '{status:(.status|ascii_downcase),task:.taskId,release,phases}' "$report"
