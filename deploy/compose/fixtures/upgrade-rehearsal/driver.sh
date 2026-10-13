#!/bin/sh
set -eu

command=${1:-serve}
case "$command" in
  upgrade-preflight)
    [ "${FIXTURE_PREFLIGHT_FAIL:-false}" != true ] || exit 42
    echo '{"status":"upgrade-required","currentMigration":46,"targetMigration":50}'
    ;;
  storage-check)
    echo '{"status":"ready","format":"project-bundle-v1"}'
    ;;
  migrate)
    [ "${FIXTURE_MIGRATE_FAIL:-false}" != true ] || exit 43
    if [ -d /state ] && [ -w /state ]; then
      echo 50 > /state/schema
    fi
    ;;
  healthcheck)
    wget -q -O /dev/null http://127.0.0.1:8080/health/live
    ;;
  serve|web)
    port="${FIXTURE_PORT:-8080}"
    if [ "${FIXTURE_ROLE:-server}" = web ] && [ -z "${FIXTURE_PORT:-}" ]; then
      port=3000
    fi
    mkdir -p /tmp/www/health
    printf '%s\n' "${FIXTURE_RELEASE:-unknown}" > /tmp/www/health/live
    printf '%s\n' "${FIXTURE_RELEASE:-unknown}" > /tmp/www/health/ready
    printf '%s\n' "${FIXTURE_RELEASE:-unknown}" > /tmp/www/sign-in
    exec httpd -f -p "$port" -h /tmp/www
    ;;
  *) exit 64 ;;
esac
