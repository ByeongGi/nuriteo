#!/usr/bin/env bash
set -Eeuo pipefail

repository_root="$(cd "$(dirname "${BASH_SOURCE[0]}")/../.." && pwd)"
compose_file="$repository_root/deploy/compose/compose.yaml"
dev_compose_file="$repository_root/deploy/compose/compose.dev.yaml"
state_root="${NURITEO_DEV_STATE_DIR:-$repository_root/.local/nuriteo-compose}"
project="${NURITEO_DEV_PROJECT:-nuriteo-dev}"
web_port="${NURITEO_DEV_WEB_PORT:-3000}"
postgres_port="${NURITEO_DEV_POSTGRES_PORT:-15432}"
rustfs_port="${NURITEO_DEV_RUSTFS_PORT:-19000}"
marker="$state_root/.nuriteo-dev-state"
compose_command=()
engine=""

fail() {
  echo "nuriteo dev stack: $*" >&2
  exit 1
}

validate_settings() {
  [[ "$project" =~ ^[a-z0-9][a-z0-9_-]*$ ]] || fail "invalid project name: $project"
  local name value
  for name in WEB POSTGRES RUSTFS; do
    case "$name" in
      WEB) value="$web_port" ;;
      POSTGRES) value="$postgres_port" ;;
      RUSTFS) value="$rustfs_port" ;;
    esac
    [[ "$value" =~ ^[0-9]+$ ]] || fail "NURITEO_DEV_${name}_PORT must be numeric"
    (( value >= 1 && value <= 65535 )) || fail "NURITEO_DEV_${name}_PORT must be between 1 and 65535"
  done
  [ "$state_root" != "/" ] || fail "state directory cannot be /"
  [ "$state_root" != "$repository_root" ] || fail "state directory cannot be the repository root"
}

select_compose() {
  if docker compose version >/dev/null 2>&1; then
    compose_command=(docker compose)
    engine=docker
  elif podman compose version >/dev/null 2>&1; then
    compose_command=(podman compose)
    engine=podman
  elif command -v podman-compose >/dev/null 2>&1; then
    compose_command=(podman-compose)
    engine=podman
  elif command -v podman >/dev/null 2>&1 && command -v uvx >/dev/null 2>&1; then
    compose_command=(uvx --from podman-compose==1.5.0 podman-compose --in-pod false)
    engine=podman
  else
    fail "Docker Compose v2 or Podman with uvx/podman-compose is required"
  fi
}

verify_engine() {
  if ! "$engine" info >/dev/null 2>&1; then
    if [ "$engine" = podman ]; then
      fail "Podman is not running; start its machine or service before retrying"
    fi
    fail "Docker Engine is not running"
  fi
}

compose() {
  "${compose_command[@]}" --file "$compose_file" --project-name "$project" "$@"
}

dev_compose() {
  "${compose_command[@]}" --file "$compose_file" --file "$dev_compose_file" --project-name "$project" "$@"
}

random_hex() {
  openssl rand -hex "$1"
}

random_base64() {
  openssl rand -base64 32 | tr -d '\n'
}

random_base64url() {
  openssl rand -base64 32 | tr '+/' '-_' | tr -d '=\n'
}

write_secret_if_missing() {
  local path="$1" value="$2"
  if [ ! -s "$path" ]; then
    printf '%s\n' "$value" >"$path"
  fi
  chmod 0644 "$path"
}

generate_postgres_tls() {
  local directory="$state_root/postgres-tls"
  if [ -s "$directory/ca.crt" ] && [ -s "$directory/server.crt" ] && [ -s "$directory/server.key" ] &&
    openssl x509 -in "$directory/server.crt" -noout -ext subjectAltName 2>/dev/null | grep -Fq 'IP Address:127.0.0.1'; then
    return
  fi
  mkdir -p "$directory"
  openssl req -x509 -newkey rsa:2048 -nodes \
    -keyout "$directory/ca.key" -out "$directory/ca.crt" -days 825 \
    -subj '/CN=nuriteo-dev-postgres-ca' \
    -addext 'basicConstraints=critical,CA:TRUE' \
    -addext 'keyUsage=critical,keyCertSign,cRLSign' >/dev/null 2>&1
  openssl req -newkey rsa:2048 -nodes \
    -keyout "$directory/server.key" -out "$directory/server.csr" \
    -subj '/CN=postgres' >/dev/null 2>&1
  printf '%s\n' \
    'subjectAltName=DNS:postgres,DNS:localhost,IP:127.0.0.1' \
    'basicConstraints=critical,CA:FALSE' \
    'keyUsage=critical,digitalSignature,keyEncipherment' \
    'extendedKeyUsage=serverAuth' >"$directory/server.ext"
  openssl x509 -req -in "$directory/server.csr" \
    -CA "$directory/ca.crt" -CAkey "$directory/ca.key" -CAcreateserial \
    -out "$directory/server.crt" -days 825 -extfile "$directory/server.ext" >/dev/null 2>&1
  chmod 0600 "$directory/ca.key" "$directory/server.key"
  chmod 0644 "$directory/ca.crt" "$directory/server.crt"
}

generate_rustfs_tls() {
  local directory="$state_root/rustfs-tls"
  if [ -s "$directory/ca.crt" ] && [ -s "$directory/rustfs_cert.pem" ] && [ -s "$directory/rustfs_key.pem" ] &&
    openssl x509 -in "$directory/rustfs_cert.pem" -noout -ext subjectAltName 2>/dev/null | grep -Fq 'IP Address:127.0.0.1'; then
    return
  fi
  mkdir -p "$directory"
  openssl req -x509 -newkey rsa:2048 -nodes \
    -keyout "$directory/ca.key" -out "$directory/ca.crt" -days 825 \
    -subj '/CN=nuriteo-dev-rustfs-ca' \
    -addext 'basicConstraints=critical,CA:TRUE' \
    -addext 'keyUsage=critical,keyCertSign,cRLSign' >/dev/null 2>&1
  openssl req -newkey rsa:2048 -nodes \
    -keyout "$directory/rustfs_key.pem" -out "$directory/server.csr" \
    -subj '/CN=rustfs' >/dev/null 2>&1
  printf '%s\n' \
    'subjectAltName=DNS:rustfs,DNS:localhost,IP:127.0.0.1' \
    'basicConstraints=critical,CA:FALSE' \
    'keyUsage=critical,digitalSignature,keyEncipherment' \
    'extendedKeyUsage=serverAuth' >"$directory/server.ext"
  openssl x509 -req -in "$directory/server.csr" \
    -CA "$directory/ca.crt" -CAkey "$directory/ca.key" -CAcreateserial \
    -out "$directory/rustfs_cert.pem" -days 825 -extfile "$directory/server.ext" >/dev/null 2>&1
  chmod 0600 "$directory/ca.key"
  chmod 0644 "$directory/ca.crt" "$directory/rustfs_cert.pem" "$directory/rustfs_key.pem"
}

initialize() {
  command -v openssl >/dev/null 2>&1 || fail "openssl is required"
  mkdir -p "$state_root"
  chmod 0700 "$state_root"
  : >"$marker"
  chmod 0600 "$marker"

  write_secret_if_missing "$state_root/postgres-password" "$(random_hex 24)"
  write_secret_if_missing "$state_root/rustfs-access-key" "$(random_hex 12)"
  write_secret_if_missing "$state_root/rustfs-secret-key" "$(random_hex 32)"
  write_secret_if_missing "$state_root/bootstrap-admin-password" "$(random_hex 24)"
  write_secret_if_missing "$state_root/preview-signing-key" "$(random_base64url)"
  write_secret_if_missing "$state_root/save-idempotency-secret" "$(random_base64)"
  write_secret_if_missing "$state_root/master-key" "$(random_base64)"

  printf 'postgres://nuriteo:%s@postgres:5432/nuriteo\n' \
    "$(cat "$state_root/postgres-password")" >"$state_root/database-url"
  printf 'postgres://nuriteo:%s@127.0.0.1:%s/nuriteo\n' \
    "$(cat "$state_root/postgres-password")" "$postgres_port" >"$state_root/database-url-host"
  chmod 0644 "$state_root/database-url"
  chmod 0644 "$state_root/database-url-host"
  generate_postgres_tls
  generate_rustfs_tls
  echo "local development state initialized: $state_root"
}

require_initialized() {
  [ -f "$marker" ] || fail "stack is not initialized; run pnpm dev:stack:init"
}

export_compose_environment() {
  require_initialized
  export NURITEO_POSTGRES_PASSWORD_FILE="$state_root/postgres-password"
  export NURITEO_POSTGRES_SERVER_CERT_FILE="$state_root/postgres-tls/server.crt"
  export NURITEO_POSTGRES_SERVER_KEY_FILE="$state_root/postgres-tls/server.key"
  export NURITEO_DATABASE_URL_FILE="$state_root/database-url"
  export NURITEO_DATABASE_CA_FILE="$state_root/postgres-tls/ca.crt"
  export NURITEO_RUSTFS_ACCESS_KEY_FILE="$state_root/rustfs-access-key"
  export NURITEO_RUSTFS_SECRET_KEY_FILE="$state_root/rustfs-secret-key"
  export NURITEO_RUSTFS_CA_FILE="$state_root/rustfs-tls/ca.crt"
  export NURITEO_RUSTFS_TLS_DIR="$state_root/rustfs-tls"
  export NURITEO_BOOTSTRAP_ADMIN_PASSWORD_FILE="$state_root/bootstrap-admin-password"
  export NURITEO_PREVIEW_SIGNING_KEY_FILE="$state_root/preview-signing-key"
  export NURITEO_SAVE_IDEMPOTENCY_SECRET_FILE="$state_root/save-idempotency-secret"
  export NURITEO_MASTER_KEY_FILE="$state_root/master-key"
  export NURITEO_MASTER_KEY_VERSION=1
  export NURITEO_BOOTSTRAP_ADMIN_EMAIL="${NURITEO_DEV_ADMIN_EMAIL:-admin@example.test}"
  export NURITEO_BOOTSTRAP_ADMIN_NAME="${NURITEO_DEV_ADMIN_NAME:-Local Administrator}"
  export NURITEO_EXTERNAL_URL="http://127.0.0.1:$web_port"
  export NURITEO_PREVIEW_BASE_DOMAIN="preview.localhost"
  export NURITEO_PREVIEW_WILDCARD_READY=true
  export NURITEO_WEB_BIND_IP=127.0.0.1
  export NURITEO_WEB_PORT="$web_port"
  export NURITEO_DEV_POSTGRES_PORT="$postgres_port"
  export NURITEO_DEV_RUSTFS_PORT="$rustfs_port"
  export NURITEO_LOG_FORMAT="${NURITEO_LOG_FORMAT:-text}"
  export NURITEO_POSTGRES_IMAGE="${NURITEO_POSTGRES_IMAGE:-localhost/nuriteo-postgres:dev}"
  export NURITEO_SERVER_IMAGE="${NURITEO_SERVER_IMAGE:-localhost/nuriteo-server:dev}"
  export NURITEO_WEB_IMAGE="${NURITEO_WEB_IMAGE:-localhost/nuriteo-web:dev}"
}

service_container() {
  "$engine" ps --all \
    --filter "label=com.docker.compose.project=$project" \
    --filter "label=com.docker.compose.service=$1" \
    --format '{{.ID}}' | head -n 1
}

wait_for_job() {
  local service="$1" attempt=0 container status
  while [ "$attempt" -lt 120 ]; do
    container="$(service_container "$service")"
    if [ -n "$container" ]; then
      status="$($engine inspect --format '{{.State.Status}} {{.State.ExitCode}}' "$container")"
      case "$status" in
        "exited 0") return 0 ;;
        exited\ *) compose logs "$service" >&2; fail "$service failed: $status" ;;
      esac
    fi
    attempt=$((attempt + 1))
    sleep 1
  done
  fail "$service did not complete within 120 seconds"
}

wait_for_command() {
  local name="$1"; shift
  local attempt=0
  until "$@" >/dev/null 2>&1; do
    attempt=$((attempt + 1))
    [ "$attempt" -lt 120 ] || fail "$name did not become ready within 120 seconds"
    sleep 1
  done
}

up() {
  initialize
  select_compose
  verify_engine
  export_compose_environment
  compose config >/dev/null

  if [ "${NURITEO_DEV_SKIP_BUILD:-0}" != 1 ]; then
    compose build postgres core web
  fi
  compose up --detach --no-deps postgres rustfs
  wait_for_command PostgreSQL compose exec -T postgres pg_isready --username nuriteo --dbname nuriteo
  wait_for_command RustFS compose exec -T rustfs curl --fail --silent --cacert /etc/rustfs/tls/ca.crt https://rustfs:9000/health

  local job
  for job in storage-init storage-check migrate bootstrap-admin; do
    compose up --detach --no-deps "$job"
    wait_for_job "$job"
  done

  compose up --detach --no-deps core
  wait_for_command Core compose exec -T core /usr/local/bin/nuriteo-server healthcheck
  compose up --detach --no-deps web
  wait_for_command Web curl --fail --silent "http://127.0.0.1:$web_port/"
  credentials
}

infra() {
  initialize
  select_compose
  verify_engine
  export_compose_environment
  dev_compose config >/dev/null

  compose down --remove-orphans >/dev/null 2>&1 || true
  if [ "${NURITEO_DEV_SKIP_BUILD:-0}" != 1 ]; then
    dev_compose build postgres
  fi
  dev_compose up --detach --no-deps postgres rustfs
  wait_for_command PostgreSQL dev_compose exec -T postgres pg_isready --username nuriteo --dbname nuriteo
  wait_for_command RustFS dev_compose exec -T rustfs curl --fail --silent --cacert /etc/rustfs/tls/ca.crt https://rustfs:9000/health
  dev_compose up --detach --no-deps storage-init
  wait_for_job storage-init
  echo "local infrastructure ready on PostgreSQL $postgres_port and RustFS $rustfs_port"
}

credentials() {
  require_initialized
  printf 'URL:      http://127.0.0.1:%s\n' "$web_port"
  printf 'Email:    %s\n' "${NURITEO_DEV_ADMIN_EMAIL:-admin@example.test}"
  printf 'Password: %s\n' "$(cat "$state_root/bootstrap-admin-password")"
  printf 'State:    %s\n' "$state_root"
}

status() {
  select_compose
  verify_engine
  export_compose_environment
  compose ps
}

logs() {
  select_compose
  verify_engine
  export_compose_environment
  compose logs --tail=200 --follow "$@"
}

down() {
  select_compose
  verify_engine
  export_compose_environment
  compose down --remove-orphans
  echo "local stack stopped; PostgreSQL and RustFS volumes were preserved"
}

reset() {
  [ "${1:-}" = "--yes" ] || fail "reset deletes local volumes and credentials; rerun with --yes"
  require_initialized
  select_compose
  verify_engine
  export_compose_environment
  compose down --volumes --remove-orphans
  [ -f "$marker" ] || fail "refusing to remove an unmarked state directory"
  rm -rf -- "$state_root"
  echo "local stack data and credentials removed"
}

usage() {
  cat <<'EOF'
Usage: deploy/compose/dev-stack.sh <command>

Commands:
  init             Create stable local credentials and TLS material
  infra            Start host-accessible PostgreSQL and RustFS for live development
  up               Build and start PostgreSQL, RustFS, Core, and Web
  status           Show Compose service state
  logs [services]  Follow the latest service logs
  credentials      Print the local URL and administrator credentials
  down             Stop services while preserving data volumes
  reset --yes      Delete services, data volumes, and local credentials
EOF
}

validate_settings
action="${1:-}"
if [ "$#" -gt 0 ]; then shift; fi
case "$action" in
  init) initialize ;;
  infra) infra ;;
  up) up ;;
  status) status ;;
  logs) logs "$@" ;;
  credentials) credentials ;;
  down) down ;;
  reset) reset "$@" ;;
  *) usage; [ -z "$action" ] || exit 1 ;;
esac
