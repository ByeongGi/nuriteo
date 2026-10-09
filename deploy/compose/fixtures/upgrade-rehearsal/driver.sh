#!/bin/sh
set -eu

command=${1:-serve}
case "$command" in
  upgrade-preflight)
    [ "${FIXTURE_PREFLIGHT_FAIL:-false}" != true ] || exit 42
    echo '{"status":"upgrade-required","currentMigration":46,"targetMigration":48}'
    ;;
  storage-check)
    echo '{"status":"ready","format":"project-bundle-v1"}'
    ;;
  migrate)
    [ "${FIXTURE_MIGRATE_FAIL:-false}" != true ] || exit 43
    echo 48 > /state/schema
    ;;
  healthcheck)
    wget -q -O /dev/null http://127.0.0.1:8080/health
    ;;
  serve|web)
    mkdir -p /tmp/www
    printf '%s\n' "${FIXTURE_RELEASE:-unknown}" > /tmp/www/health
    printf '%s\n' "${FIXTURE_RELEASE:-unknown}" > /tmp/www/sign-in
    exec httpd -f -p "${FIXTURE_PORT:-8080}" -h /tmp/www
    ;;
  *) exit 64 ;;
esac
