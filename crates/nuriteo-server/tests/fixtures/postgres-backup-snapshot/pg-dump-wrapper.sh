#!/usr/bin/env bash
set -euo pipefail

runtime="${CONTAINER_RUNTIME:-podman}"
: "${NURITEO_TEST_DB_CONTAINER:?container is required}"
exec "$runtime" exec --env "PGPASSWORD=${PGPASSWORD:-}" \
  "$NURITEO_TEST_DB_CONTAINER" pg_dump "$@"
