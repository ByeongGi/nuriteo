#!/usr/bin/env bash
set -Eeuo pipefail

repository_root="$(cd "$(dirname "${BASH_SOURCE[0]}")/../.." && pwd)"
compose_file="$repository_root/deploy/compose/compose.yaml"
script_path="$repository_root/deploy/compose/docker-qualification-ci.sh"
artifact_root="${NURITEO_QUALIFICATION_ARTIFACTS:-$repository_root/artifacts/docker-compose}"
temporary_root="${NURITEO_QUALIFICATION_TMP_ROOT:-${TMPDIR:-/tmp}/nuriteo-compose-qualification}"
expected_success='compose relay acceptance ok (clean install, invite, organization workspace, isolated preview, save, restart, fresh-context resume, persistence, drifted CORS and failed-one-shot dependency gates)'

readonly pull_timeout=10m
readonly build_timeout=35m
readonly acceptance_timeout=35m
readonly diagnostics_timeout=2m
readonly cleanup_timeout=8m

main() {
  case "${1:-}" in
    preflight) preflight ;;
    pull) run_bounded "$pull_timeout" pull-internal ;;
    build) build_images ;;
    acceptance) run_acceptance ;;
    diagnostics) run_bounded "$diagnostics_timeout" collect-state ;;
    cleanup) run_bounded "$cleanup_timeout" cleanup-internal ;;
    self-test) self_test ;;
    pull-internal) pull_images ;;
    collect-state) collect_state ;;
    cleanup-internal) cleanup_impl ;;
    *) echo "usage: $0 {preflight|pull|build|acceptance|diagnostics|cleanup|self-test}" >&2; exit 2 ;;
  esac
}

run_bounded() {
  local bound="$1" command="$2"
  timeout --signal=TERM --kill-after=30s "$bound" "$script_path" "$command"
}

preflight() {
  local compose_version operating_system
  timeout --signal=TERM --kill-after=10s 1m docker version >/dev/null
  compose_version="$(timeout --signal=TERM --kill-after=10s 1m docker compose version --short)"
  [[ "$compose_version" =~ ^v?2\. ]] || {
    echo "Docker Compose v2 is required; received ${compose_version}" >&2
    exit 1
  }
  operating_system="$(timeout --signal=TERM --kill-after=10s 1m docker info --format '{{.OSType}}')"
  [ "$operating_system" = linux ] || {
    echo "the official qualification requires a Linux Docker Engine" >&2
    exit 1
  }
  echo "Docker Compose qualification runtime ready: ${compose_version} (${operating_system})"
}

pull_images() {
  local image
  preflight
  with_placeholder_compose_environment \
    timeout --signal=TERM --kill-after=30s "$pull_timeout" \
    docker compose --file "$compose_file" pull --ignore-buildable rustfs storage-init
  while IFS= read -r image; do
    timeout --signal=TERM --kill-after=30s "$pull_timeout" docker pull "$image"
  done < <(pinned_build_images)
}

build_images() {
  preflight
  with_placeholder_compose_environment \
    timeout --signal=TERM --kill-after=30s "$build_timeout" \
    docker compose --file "$compose_file" build --pull postgres core web
}

run_acceptance() {
  local raw_log="$temporary_root/acceptance.raw.log" status
  mkdir -p "$artifact_root" "$temporary_root"
  chmod 700 "$temporary_root"

  set +e
  TMPDIR="$temporary_root" \
    NURITEO_COMPOSE_PROVIDER=docker \
    NURITEO_COMPOSE_KEEP=1 \
    timeout --signal=TERM --kill-after=30s "$acceptance_timeout" \
    "$repository_root/deploy/compose/test-compose.sh" >"$raw_log" 2>&1
  status=$?
  set -e

  write_acceptance_summary "$raw_log" "$status" >"$artifact_root/acceptance-summary.txt"
  if [ "$status" -eq 0 ] && grep -Fqx "$expected_success" "$raw_log"; then
    rm -f -- "$raw_log"
    echo "$expected_success"
    return 0
  fi
  rm -f -- "$raw_log"
  echo "Docker Compose acceptance failed; allowlisted diagnostics will be uploaded" >&2
  return 1
}

write_acceptance_summary() {
  local raw_log="$1" status="$2" marker
  printf 'fixture_exit_status=%s\n' "$status"
  marker="$(grep -Eo 'compose acceptance failed at line [0-9]+ \(status [0-9]+\)' "$raw_log" | tail -n 1 || true)"
  [ -z "$marker" ] || printf 'fixture_failure=%s\n' "$marker"
  marker="$(grep -Eo '(bootstrap-admin|storage-check|migrate|storage-init) failed \([a-z-]+\)' "$raw_log" | tail -n 1 || true)"
  [ -z "$marker" ] || printf 'stable_category=%s\n' "$marker"
}

collect_state() {
  local container project service state exit_code health found=0
  mkdir -p "$artifact_root"
  printf 'project\tservice\tstate\texit_code\thealth\n' >"$artifact_root/service-state.tsv"
  while IFS= read -r container; do
    project="$(docker inspect --format '{{index .Config.Labels "com.docker.compose.project"}}' "$container")"
    service="$(docker inspect --format '{{index .Config.Labels "com.docker.compose.service"}}' "$container")"
    [[ "$project" =~ ^nuriteo-cmp-003-[0-9]+(-failure)?$ ]] || continue
    case "$service" in
      postgres|rustfs|storage-init|storage-check|migrate|bootstrap-admin|core|web) ;;
      *) continue ;;
    esac
    state="$(docker inspect --format '{{.State.Status}}' "$container")"
    exit_code="$(docker inspect --format '{{.State.ExitCode}}' "$container")"
    health="$(docker inspect --format '{{if .State.Health}}{{.State.Health.Status}}{{else}}none{{end}}' "$container")"
    [[ "$state" =~ ^(created|running|paused|restarting|removing|exited|dead)$ ]] || state=unknown
    [[ "$exit_code" =~ ^[0-9]+$ ]] || exit_code=unknown
    [[ "$health" =~ ^(none|starting|healthy|unhealthy)$ ]] || health=unknown
    printf '%s\t%s\t%s\t%s\t%s\n' "$project" "$service" "$state" "$exit_code" "$health" \
      >>"$artifact_root/service-state.tsv"
    found=1
  done < <(docker ps --all --quiet)
  [ "$found" -eq 1 ] || echo 'no CMP-003 Compose project reached container creation' >"$artifact_root/no-projects.txt"
}

cleanup_impl() {
  local project
  set +e
  while IFS= read -r project; do
    [[ "$project" =~ ^nuriteo-cmp-003-[0-9]+(-failure)?$ ]] || continue
    timeout --signal=TERM --kill-after=10s 3m \
      bash -c 'docker ps --all --quiet --filter "label=com.docker.compose.project=$1" | xargs --no-run-if-empty docker rm --force' _ "$project"
    with_placeholder_compose_environment \
      timeout --signal=TERM --kill-after=10s 3m \
      docker compose --file "$compose_file" --project-name "$project" down --volumes --remove-orphans
  done < <(compose_projects)
  timeout --signal=TERM --kill-after=10s 3m \
    docker image rm --force localhost/nuriteo-postgres:cmp-003 \
      localhost/nuriteo-server:cmp-003 localhost/nuriteo-web:cmp-003
  timeout --signal=TERM --kill-after=10s 5m docker builder prune --all --force
  rm -f -- "$temporary_root/acceptance.raw.log"
  find "$temporary_root" -mindepth 1 -maxdepth 1 -name 'nuriteo-cmp-003.*' -exec rm -rf -- {} +
  docker system df || true
  set -e
}

compose_projects() {
  {
    docker ps --all --format '{{.Label "com.docker.compose.project"}}'
    docker volume ls --format '{{.Label "com.docker.compose.project"}}'
    docker network ls --format '{{.Label "com.docker.compose.project"}}'
  } \
    | sort -u \
    | grep '^nuriteo-cmp-003-' || true
}

pinned_build_images() {
  local files=(
    "$repository_root/deploy/compose/postgres.Dockerfile"
    "$repository_root/deploy/docker/server.Dockerfile"
    "$repository_root/deploy/docker/web.Dockerfile"
  )
  [ "$#" -eq 0 ] || files=("$@")
  awk '
    FNR == 1 { delete aliases }
    toupper($1) == "FROM" {
      image = $2
      if (!(image in aliases)) print image
      for (field = 3; field < NF; field++) {
        if (toupper($field) == "AS") aliases[$(field + 1)] = 1
      }
    }
  ' "${files[@]}" \
    | sort -u
}

with_placeholder_compose_environment() {
  NURITEO_POSTGRES_PASSWORD_FILE=/dev/null \
  NURITEO_POSTGRES_SERVER_CERT_FILE=/dev/null \
  NURITEO_POSTGRES_SERVER_KEY_FILE=/dev/null \
  NURITEO_DATABASE_URL_FILE=/dev/null \
  NURITEO_DATABASE_CA_FILE=/dev/null \
  NURITEO_RUSTFS_ACCESS_KEY_FILE=/dev/null \
  NURITEO_RUSTFS_SECRET_KEY_FILE=/dev/null \
  NURITEO_RUSTFS_CA_FILE=/dev/null \
  NURITEO_RUSTFS_TLS_DIR=/tmp \
  NURITEO_BOOTSTRAP_ADMIN_PASSWORD_FILE=/dev/null \
  NURITEO_PREVIEW_SIGNING_KEY_FILE=/dev/null \
  NURITEO_SAVE_IDEMPOTENCY_SECRET_FILE=/dev/null \
  NURITEO_MASTER_KEY_FILE=/dev/null \
  NURITEO_MASTER_KEY_VERSION=1 \
  NURITEO_BOOTSTRAP_ADMIN_EMAIL=admin@example.invalid \
  NURITEO_BOOTSTRAP_ADMIN_NAME=Qualification \
  NURITEO_EXTERNAL_URL=http://127.0.0.1:19303 \
  NURITEO_PREVIEW_BASE_DOMAIN=preview.example.invalid \
  NURITEO_POSTGRES_IMAGE=localhost/nuriteo-postgres:cmp-003 \
  NURITEO_SERVER_IMAGE=localhost/nuriteo-server:cmp-003 \
  NURITEO_WEB_IMAGE=localhost/nuriteo-web:cmp-003 \
    "$@"
}

self_test() {
  local self_test_root raw summary pinned
  self_test_root="$(mktemp -d "${TMPDIR:-/tmp}/nuriteo-compose-qualification-self-test.XXXXXX")"
  raw="$self_test_root/raw"
  summary="$self_test_root/summary"
  printf '%s\n' \
    'compose-bootstrap-secret-7e3bc2f41a' \
    'bootstrap-admin failed (input)' \
    'compose acceptance failed at line 247 (status 1)' >"$raw"
  write_acceptance_summary "$raw" 1 >"$summary"
  grep -Fqx 'fixture_exit_status=1' "$summary"
  grep -Fqx 'fixture_failure=compose acceptance failed at line 247 (status 1)' "$summary"
  grep -Fqx 'stable_category=bootstrap-admin failed (input)' "$summary"
  ! grep -Fq 'compose-bootstrap-secret-7e3bc2f41a' "$summary"
  printf '%s\n' \
    'FROM registry.example/base@sha256:111 AS dependencies' \
    'FROM dependencies AS builder' \
    'FROM registry.example/runtime@sha256:222 AS runtime' \
    >"$self_test_root/Dockerfile.one"
  printf '%s\n' \
    'FROM registry.example/other@sha256:333 AS builder' \
    'FROM builder AS runtime' \
    >"$self_test_root/Dockerfile.two"
  pinned="$(pinned_build_images \
    "$self_test_root/Dockerfile.one" "$self_test_root/Dockerfile.two")"
  [ "$pinned" = $'registry.example/base@sha256:111\nregistry.example/other@sha256:333\nregistry.example/runtime@sha256:222' ]
  rm -rf -- "$self_test_root"
  echo 'Docker qualification allowlisted summary self-test ok'
}

main "$@"
