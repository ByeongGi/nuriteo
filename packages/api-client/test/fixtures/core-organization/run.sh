#!/usr/bin/env bash
set -euo pipefail

runtime="${CONTAINER_RUNTIME:-podman}"
upload_transport="${NURITEO_CLIENT_TEST_SAVE_UPLOAD_TRANSPORT:-direct}"
if [[ "$upload_transport" != "direct" && "$upload_transport" != "relay" ]]; then
  printf '%s\n' 'NURITEO_CLIENT_TEST_SAVE_UPLOAD_TRANSPORT must be direct or relay' >&2
  exit 2
fi
unset NURITEO_CLIENT_TEST_SAVE_UPLOAD_TRANSPORT
external_url_override_set=false
external_url_override=""
if [[ -n "${NURITEO_CLIENT_TEST_EXTERNAL_URL+x}" ]]; then
  external_url_override_set=true
  if ! external_url_override="$(
    mise exec node@22.23.0 -- node \
      packages/api-client/test/fixtures/core-organization/validate-external-origin.mjs
  )"; then
    exit 2
  fi
fi
unset NURITEO_CLIENT_TEST_EXTERNAL_URL
postgres_image="docker.io/library/postgres@sha256:2d2b8998d31037bf721cfdf764d76ba74171b4fab3431b7f72c27c56ddbdf9e3"
rustfs_image="docker.io/rustfs/rustfs@sha256:42edb61d588775f9431ff436216d14392d2234d4eb2ed68321569fbf7245b36b"
postgres_container="nuriteo-client-005-postgres-${RANDOM}"
rustfs_container="nuriteo-client-005-rustfs-${RANDOM}"
postgres_port="${NURITEO_TEST_DATABASE_PORT:-55451}"
rustfs_port="${NURITEO_TEST_S3_PORT:-19011}"
core_port="${NURITEO_TEST_CORE_PORT:-18091}"
external_url="http://127.0.0.1:${core_port}"
if [[ "$external_url_override_set" == true ]]; then
  external_url="$external_url_override"
fi
fixture_dir="$(mktemp -d "${TMPDIR:-/tmp}/nuriteo-client-005.XXXXXX")"
postgres_tls="$fixture_dir/postgres"
rustfs_tls="$fixture_dir/rustfs"
target_dir="${CARGO_TARGET_DIR:-/private/tmp/nuriteo-client005-target}"
server_pid=""
mkdir -p "$postgres_tls" "$rustfs_tls/certs"

cleanup() {
  status=$?
  if [[ -n "$server_pid" ]]; then
    kill -TERM "$server_pid" >/dev/null 2>&1 || true
    wait "$server_pid" >/dev/null 2>&1 || true
  fi
  if [[ "$status" -ne 0 && -s "$fixture_dir/server.stderr" ]]; then
    tail -n 80 "$fixture_dir/server.stderr" >&2
  fi
  if [[ "$status" -ne 0 && -s "$fixture_dir/server.stdout" ]]; then
    tail -n 80 "$fixture_dir/server.stdout" >&2
  fi
  "$runtime" rm --force "$postgres_container" >/dev/null 2>&1 || true
  "$runtime" rm --force "$rustfs_container" >/dev/null 2>&1 || true
  rm -R -- "$fixture_dir"
}
trap cleanup EXIT INT TERM

openssl rand -base64 32 >"$fixture_dir/admin-password"
openssl rand -base64 32 >"$fixture_dir/member-password"
openssl rand -base64 32 >"$fixture_dir/save-idempotency-secret"
printf '%s' 'integration-access' >"$fixture_dir/s3-access-key"
printf '%s' 'integration-secret-0123456789' >"$fixture_dir/s3-secret-key"
database_password="$(openssl rand -hex 24)"

openssl req -x509 -newkey rsa:2048 -nodes -days 2 \
  -subj '/CN=Nuriteo Client PostgreSQL Test CA' \
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
  --publish "127.0.0.1:${postgres_port}:5432" \
  --env POSTGRES_DB=nuriteo \
  --env POSTGRES_USER=nuriteo \
  --env POSTGRES_PASSWORD="$database_password" \
  "$postgres_image" >/dev/null
bucket_ready=false
for _ in $(seq 1 60); do
  if "$runtime" exec "$postgres_container" pg_isready -U nuriteo -d nuriteo >/dev/null 2>&1; then
    break
  fi
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
  if "$runtime" exec "$postgres_container" pg_isready -U nuriteo -d nuriteo >/dev/null 2>&1; then
    break
  fi
  sleep 1
done
"$runtime" exec "$postgres_container" pg_isready -U nuriteo -d nuriteo >/dev/null

openssl req -x509 -newkey rsa:2048 -nodes -days 2 \
  -subj '/CN=Nuriteo Client RustFS Test CA' \
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
  --publish "127.0.0.1:${rustfs_port}:9000" \
  --volume "$rustfs_tls/certs:/certs:ro" \
  --env RUSTFS_TLS_PATH=/certs \
  --env RUSTFS_ACCESS_KEY=integration-access \
  --env RUSTFS_SECRET_KEY=integration-secret-0123456789 \
  "$rustfs_image" >/dev/null
for _ in $(seq 1 60); do
  if curl --fail --silent --show-error --cacert "$rustfs_tls/ca.crt" \
    "https://127.0.0.1:${rustfs_port}/health" >/dev/null 2>&1; then
    break
  fi
  sleep 1
done
curl --fail --silent --show-error --cacert "$rustfs_tls/ca.crt" \
  "https://127.0.0.1:${rustfs_port}/health" >/dev/null
for _ in $(seq 1 60); do
  if curl --fail --silent --request PUT \
    --aws-sigv4 'aws:amz:us-east-1:s3' \
    --user 'integration-access:integration-secret-0123456789' \
    --cacert "$rustfs_tls/ca.crt" \
    "https://127.0.0.1:${rustfs_port}/nuriteo-client-005" >/dev/null 2>&1; then
    bucket_ready=true
    break
  fi
  sleep 0.2
done
if [[ "$bucket_ready" != true ]]; then
  curl --fail --silent --show-error --request PUT \
    --aws-sigv4 'aws:amz:us-east-1:s3' \
    --user 'integration-access:integration-secret-0123456789' \
    --cacert "$rustfs_tls/ca.crt" \
    "https://127.0.0.1:${rustfs_port}/nuriteo-client-005" >/dev/null
fi

export CARGO_TARGET_DIR="$target_dir"
export NURITEO_EXTERNAL_URL="$external_url"
export NURITEO_HTTP_LISTEN_ADDR="127.0.0.1:${core_port}"
export NURITEO_SHUTDOWN_DRAIN_TIMEOUT_MS=2000
export NURITEO_DATABASE_URL="postgres://nuriteo:${database_password}@localhost:${postgres_port}/nuriteo"
export NURITEO_DATABASE_CA_FILE="$postgres_tls/ca.crt"
export NURITEO_DATABASE_MIN_CONNECTIONS=1
export NURITEO_DATABASE_MAX_CONNECTIONS=4
export NURITEO_DATABASE_CONNECT_TIMEOUT_MS=3000
export NURITEO_DATABASE_ACQUIRE_TIMEOUT_MS=1000
export NURITEO_DATABASE_CLOSE_TIMEOUT_MS=2000
export NURITEO_S3_ENDPOINT="https://127.0.0.1:${rustfs_port}"
export NURITEO_S3_REGION=us-east-1
export NURITEO_S3_BUCKET=nuriteo-client-005
export NURITEO_S3_ADDRESSING_STYLE=path
export NURITEO_S3_CREDENTIAL_PROVIDER=static
export NURITEO_S3_ACCESS_KEY_ID_FILE="$fixture_dir/s3-access-key"
export NURITEO_S3_SECRET_ACCESS_KEY_FILE="$fixture_dir/s3-secret-key"
export NURITEO_S3_CA_FILE="$rustfs_tls/ca.crt"
export NURITEO_SAVE_IDEMPOTENCY_SECRET_FILE="$fixture_dir/save-idempotency-secret"
export NURITEO_SAVE_DEFAULT_QUOTA_BYTES=10737418240
export NURITEO_SAVE_UPLOAD_TRANSPORT="$upload_transport"

cargo build --quiet -p nuriteo-server --bin nuriteo-server
server_binary="$target_dir/debug/nuriteo-server"
if [[ "$upload_transport" == "direct" ]]; then
  "$server_binary" storage-configure-browser-upload-cors >/dev/null
fi
"$server_binary" migrate >/dev/null
NURITEO_BOOTSTRAP_ADMIN_EMAIL=admin@example.test \
NURITEO_BOOTSTRAP_ADMIN_NAME='Fixture Administrator' \
NURITEO_BOOTSTRAP_ADMIN_PASSWORD_FILE="$fixture_dir/admin-password" \
  "$server_binary" bootstrap-admin >/dev/null
"$server_binary" serve >"$fixture_dir/server.stdout" 2>"$fixture_dir/server.stderr" &
server_pid=$!

for _ in $(seq 1 80); do
  if ! kill -0 "$server_pid" >/dev/null 2>&1; then
    printf '%s\n' 'Core process exited before readiness' >&2
    exit 1
  fi
  if curl --fail --silent --show-error \
    "http://127.0.0.1:${core_port}/health/ready" >/dev/null 2>&1; then
    break
  fi
  sleep 0.1
done
curl --fail --silent --show-error \
  "http://127.0.0.1:${core_port}/health/ready" >/dev/null

client_environment=(
  "NURITEO_CLIENT_TEST_BASE_URL=http://127.0.0.1:${core_port}"
  "NURITEO_CLIENT_TEST_EMAIL=admin@example.test"
  "NURITEO_CLIENT_TEST_PASSWORD_FILE=$fixture_dir/admin-password"
  "NURITEO_CLIENT_TEST_MEMBER_PASSWORD_FILE=$fixture_dir/member-password"
  "NURITEO_CLIENT_TEST_SAVE_UPLOAD_TRANSPORT=$upload_transport"
  "NURITEO_CLIENT_TEST_CONTAINER_RUNTIME=$runtime"
  "NURITEO_CLIENT_TEST_POSTGRES_CONTAINER=$postgres_container"
  "NODE_EXTRA_CA_CERTS=$rustfs_tls/ca.crt"
)
if [[ "$external_url_override_set" == true ]]; then
  client_environment+=("NURITEO_CLIENT_TEST_EXTERNAL_URL=$external_url_override")
fi
env "${client_environment[@]}" \
  mise exec node@22.23.0 -- node \
    "${CLIENT_LIVE_CONTRACT:-packages/api-client/test/organization-live-contract.ts}"
