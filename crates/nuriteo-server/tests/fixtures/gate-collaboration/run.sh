#!/usr/bin/env bash
set -euo pipefail
umask 077

runtime="${CONTAINER_RUNTIME:-podman}"
postgres_image="docker.io/library/postgres@sha256:2d2b8998d31037bf721cfdf764d76ba74171b4fab3431b7f72c27c56ddbdf9e3"
rustfs_image="docker.io/rustfs/rustfs@sha256:42edb61d588775f9431ff436216d14392d2234d4eb2ed68321569fbf7245b36b"
postgres_container="nuriteo-gate-002-postgres-${RANDOM}"
rustfs_container="nuriteo-gate-002-rustfs-${RANDOM}"
postgres_requested_port="${NURITEO_TEST_DATABASE_PORT:-}"
rustfs_requested_port="${NURITEO_TEST_S3_PORT:-}"
postgres_publish="127.0.0.1:${postgres_requested_port}:5432"
rustfs_publish="127.0.0.1:${rustfs_requested_port}:9000"
fixture_dir="$(mktemp -d "${TMPDIR:-/tmp}/nuriteo-gate-002.XXXXXX")"

cleanup() {
  "$runtime" rm --force "$postgres_container" >/dev/null 2>&1 || true
  "$runtime" rm --force "$rustfs_container" >/dev/null 2>&1 || true
  rm -rf -- "$fixture_dir"
}

exit_after_cleanup() {
  local status="$1"
  trap - EXIT INT TERM
  cleanup
  exit "$status"
}

trap cleanup EXIT
trap 'exit_after_cleanup 130' INT
trap 'exit_after_cleanup 143' TERM

postgres_tls="$fixture_dir/postgres"
rustfs_tls="$fixture_dir/rustfs"
database_password="$(openssl rand -hex 24)"
bootstrap_password_file="$fixture_dir/bootstrap-password"
save_idempotency_secret_file="$fixture_dir/save-idempotency-secret"
gate_test_name="${NURITEO_GATE_TEST_NAME:-collaboration_gate_runs_actual_core_postgres_and_rustfs_journey}"

mkdir -p "$postgres_tls" "$rustfs_tls/certs"
printf '%s' 'gate bootstrap password 0123456789' >"$bootstrap_password_file"
openssl rand -base64 32 | tr -d '\n' >"$save_idempotency_secret_file"
chmod 600 "$bootstrap_password_file" "$save_idempotency_secret_file"

bound_port() {
  local container="$1"
  local container_port="$2"
  local requested_port="$3"
  if [[ -n "$requested_port" ]]; then
    printf '%s' "$requested_port"
    return
  fi
  local binding
  local selected_port
  binding="$("$runtime" port "$container" "${container_port}/tcp")"
  selected_port="${binding##*:}"
  if [[ ! "$selected_port" =~ ^[0-9]+$ ]]; then
    echo "could not resolve ephemeral host port for ${container}:${container_port}" >&2
    return 1
  fi
  printf '%s' "$selected_port"
}

command -v "$runtime" >/dev/null
command -v openssl >/dev/null
command -v curl >/dev/null

echo 'GATE-002 actual Core: generating ephemeral custom-CA services'
openssl req -x509 -newkey rsa:2048 -nodes -days 2 \
  -subj '/CN=Nuriteo G2 PostgreSQL Test CA' \
  -addext 'basicConstraints=critical,CA:TRUE' \
  -addext 'keyUsage=critical,keyCertSign,cRLSign' \
  -keyout "$postgres_tls/ca.key" -out "$postgres_tls/ca.crt" >/dev/null 2>&1
openssl req -newkey rsa:2048 -nodes -subj '/CN=localhost' \
  -keyout "$postgres_tls/server.key" -out "$postgres_tls/server.csr" >/dev/null 2>&1
printf '%s\n' \
  'subjectAltName=DNS:localhost,IP:127.0.0.1' \
  'extendedKeyUsage=serverAuth' \
  'basicConstraints=critical,CA:FALSE' >"$postgres_tls/server.ext"
openssl x509 -req -days 2 -in "$postgres_tls/server.csr" \
  -CA "$postgres_tls/ca.crt" -CAkey "$postgres_tls/ca.key" -CAcreateserial \
  -extfile "$postgres_tls/server.ext" -out "$postgres_tls/server.crt" >/dev/null 2>&1

"$runtime" run --detach --name "$postgres_container" \
  --publish "$postgres_publish" \
  --env POSTGRES_DB=nuriteo \
  --env POSTGRES_USER=nuriteo \
  --env POSTGRES_PASSWORD="$database_password" \
  "$postgres_image" >/dev/null
postgres_port="$(bound_port "$postgres_container" 5432 "$postgres_requested_port")"
for _ in $(seq 1 60); do
  "$runtime" exec "$postgres_container" pg_isready -U nuriteo -d nuriteo >/dev/null 2>&1 && break
  sleep 1
done
"$runtime" exec "$postgres_container" pg_isready -U nuriteo -d nuriteo >/dev/null
"$runtime" cp "$postgres_tls/server.crt" "$postgres_container:/var/lib/postgresql/server.crt"
"$runtime" cp "$postgres_tls/server.key" "$postgres_container:/var/lib/postgresql/server.key"
"$runtime" exec --user root "$postgres_container" chown postgres:postgres \
  /var/lib/postgresql/server.crt /var/lib/postgresql/server.key
"$runtime" exec --user root "$postgres_container" chmod 600 /var/lib/postgresql/server.key
"$runtime" exec "$postgres_container" psql -v ON_ERROR_STOP=1 -U nuriteo -d nuriteo \
  -c "ALTER SYSTEM SET ssl = 'on'" \
  -c "ALTER SYSTEM SET ssl_cert_file = '/var/lib/postgresql/server.crt'" \
  -c "ALTER SYSTEM SET ssl_key_file = '/var/lib/postgresql/server.key'" >/dev/null
"$runtime" restart "$postgres_container" >/dev/null
for _ in $(seq 1 60); do
  "$runtime" exec "$postgres_container" pg_isready -U nuriteo -d nuriteo >/dev/null 2>&1 && break
  sleep 1
done
"$runtime" exec "$postgres_container" pg_isready -U nuriteo -d nuriteo >/dev/null

openssl req -x509 -newkey rsa:2048 -nodes -days 2 \
  -subj '/CN=Nuriteo G2 RustFS Test CA' \
  -addext 'basicConstraints=critical,CA:TRUE' \
  -addext 'keyUsage=critical,keyCertSign,cRLSign' \
  -keyout "$rustfs_tls/ca.key" -out "$rustfs_tls/ca.crt" >/dev/null 2>&1
openssl req -newkey rsa:2048 -nodes -subj '/CN=localhost' \
  -keyout "$rustfs_tls/certs/rustfs_key.pem" -out "$rustfs_tls/server.csr" >/dev/null 2>&1
printf '%s\n' \
  'subjectAltName=DNS:localhost,IP:127.0.0.1' \
  'basicConstraints=critical,CA:FALSE' \
  'keyUsage=critical,digitalSignature,keyEncipherment' \
  'extendedKeyUsage=serverAuth' >"$rustfs_tls/server.ext"
openssl x509 -req -days 2 -in "$rustfs_tls/server.csr" \
  -CA "$rustfs_tls/ca.crt" -CAkey "$rustfs_tls/ca.key" -CAcreateserial \
  -extfile "$rustfs_tls/server.ext" -out "$rustfs_tls/certs/rustfs_cert.pem" >/dev/null 2>&1
"$runtime" run --rm --volume "$rustfs_tls/certs:/certs:ro" --entrypoint rustfs \
  "$rustfs_image" tls inspect --path /certs >/dev/null
"$runtime" run --detach --name "$rustfs_container" \
  --publish "$rustfs_publish" \
  --volume "$rustfs_tls/certs:/certs:ro" \
  --env RUSTFS_TLS_PATH=/certs \
  --env RUSTFS_ACCESS_KEY=integration-access \
  --env RUSTFS_SECRET_KEY=integration-secret-0123456789 \
  "$rustfs_image" >/dev/null
rustfs_port="$(bound_port "$rustfs_container" 9000 "$rustfs_requested_port")"
for _ in $(seq 1 60); do
  if curl --fail --silent --show-error --cacert "$rustfs_tls/ca.crt" \
    "https://127.0.0.1:${rustfs_port}/health" >/dev/null 2>&1; then
    break
  fi
  sleep 1
done
curl --fail --silent --show-error --cacert "$rustfs_tls/ca.crt" \
  "https://127.0.0.1:${rustfs_port}/health" >/dev/null

echo 'GATE-002 actual Core: running bootstrap-to-collaboration journey'
NURITEO_TEST_DATABASE_URL="postgres://nuriteo:${database_password}@localhost:${postgres_port}/nuriteo" \
NURITEO_TEST_DATABASE_CA="$postgres_tls/ca.crt" \
NURITEO_TEST_S3_ENDPOINT="https://127.0.0.1:${rustfs_port}" \
NURITEO_TEST_S3_CA_FILE="$rustfs_tls/ca.crt" \
NURITEO_TEST_BOOTSTRAP_PASSWORD_FILE="$bootstrap_password_file" \
NURITEO_TEST_SAVE_IDEMPOTENCY_SECRET_FILE="$save_idempotency_secret_file" \
NURITEO_TEST_GATE_PROJECT_RUNTIME_BROWSER="${NURITEO_TEST_GATE_PROJECT_RUNTIME_BROWSER:-}" \
NURITEO_TEST_NODE_EXECUTABLE="${NURITEO_TEST_NODE_EXECUTABLE:-node}" \
CARGO_TARGET_DIR="${CARGO_TARGET_DIR:-/private/tmp/nuriteo-gate002-target}" \
cargo test -p nuriteo-server --test gate_collaboration --all-features \
  "$gate_test_name" \
  -- --ignored --exact --nocapture

echo 'GATE-002 actual Core: PASS'
