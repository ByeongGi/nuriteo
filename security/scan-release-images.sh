#!/usr/bin/env bash
set -euo pipefail

archive_dir="${1:?usage: scan-release-images.sh ARCHIVE_DIR REPORT_DIR}"
report_dir="${2:?usage: scan-release-images.sh ARCHIVE_DIR REPORT_DIR}"
scanner='docker.io/aquasec/trivy@sha256:62b1e65e8869bc4b4c6aa4fa2b21595256c7c2f6018a9d9ad61caf87187c1969'
cache_dir="${NURITEO_TRIVY_CACHE_DIR:-${TMPDIR:-/tmp}/nuriteo-trivy-cache}"
runtime="${CONTAINER_RUNTIME:-podman}"

mkdir -p "$report_dir" "$cache_dir"
for role in server web operations; do
  archive="$archive_dir/$role.tar"
  test -f "$archive"
  "$runtime" run --rm \
    --volume "$archive_dir:/scan:ro" \
    --volume "$report_dir:/report:rw" \
    --volume "$cache_dir:/root/.cache/trivy:rw" \
    "$scanner" image \
    --input "/scan/$role.tar" \
    --scanners vuln,secret \
    --severity HIGH,CRITICAL \
    --exit-code 1 \
    --skip-version-check \
    --format json \
    --output "/report/$role.json"
done

echo "release image security scan passed (server, web, operations)"
