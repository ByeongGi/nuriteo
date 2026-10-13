#!/usr/bin/env bash
set -Eeuo pipefail

root="$(cd "$(dirname "${BASH_SOURCE[0]}")/../.." && pwd)"
cd "$root"

runtime="${CONTAINER_RUNTIME:-podman}"
compose_provider="${NURITEO_COMPOSE_PROVIDER:-uvx}"

pnpm check:rc-gate
CONTAINER_RUNTIME="$runtime" release/rc/qualify-images.sh
NURITEO_COMPOSE_PROVIDER="$compose_provider" \
NURITEO_COMPOSE_SKIP_APP_BUILD=1 \
NURITEO_SERVER_IMAGE=localhost/nuriteo-server:1.0.0-rc.1 \
NURITEO_WEB_IMAGE=localhost/nuriteo-web:1.0.0-rc.1 \
  deploy/compose/test-compose.sh
charts/nuriteo/tests/kind-release.sh
CONTAINER_RUNTIME="$runtime" crates/nuriteo-server/tests/fixtures/backup-restore/run.sh

printf '%s\n' '{"status":"pass","gate":"GATE-006","release":"1.0.0-rc.1","compose":true,"helm":true,"restore":true,"airgap":true}'
