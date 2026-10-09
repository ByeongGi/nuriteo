#!/usr/bin/env bash
set -euo pipefail

runtime="${CONTAINER_RUNTIME:-podman}"
: "${NURITEO_TEST_DB_CONTAINER:?container is required}"
archive="$1"
remote="/tmp/nuriteo-bkp-002-${RANDOM}.dump"
cleanup() {
  "$runtime" exec "$NURITEO_TEST_DB_CONTAINER" rm -f "$remote" >/dev/null 2>&1 || true
}
trap cleanup EXIT
"$runtime" cp "$archive" "$NURITEO_TEST_DB_CONTAINER:$remote"
"$runtime" exec "$NURITEO_TEST_DB_CONTAINER" \
  pg_restore --data-only --table=projects --file=- "$remote"
