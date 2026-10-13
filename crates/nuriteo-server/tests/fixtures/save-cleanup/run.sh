#!/usr/bin/env bash
set -euo pipefail

runtime="${CONTAINER_RUNTIME:-podman}"
postgres_image="docker.io/library/postgres@sha256:2d2b8998d31037bf721cfdf764d76ba74171b4fab3431b7f72c27c56ddbdf9e3"
rustfs_image="docker.io/rustfs/rustfs@sha256:42edb61d588775f9431ff436216d14392d2234d4eb2ed68321569fbf7245b36b"
suffix="${RANDOM}"
postgres_container="nuriteo-save-009-pg-${suffix}"
rustfs_container="nuriteo-save-009-s3-${suffix}"
fixture_dir="$(mktemp -d "${TMPDIR:-/tmp}/nuriteo-save-009.XXXXXX")"
postgres_password="$(openssl rand -hex 24)"

free_port() {
  node -e "const n=require('net').createServer();n.listen(0,'127.0.0.1',()=>{console.log(n.address().port);n.close()})"
}

postgres_port="${NURITEO_TEST_DATABASE_PORT:-$(free_port)}"
rustfs_port="${NURITEO_TEST_S3_PORT:-$(free_port)}"

cleanup() {
  "$runtime" rm --force "$postgres_container" >/dev/null 2>&1 || true
  "$runtime" rm --force "$rustfs_container" >/dev/null 2>&1 || true
  rm -rf -- "$fixture_dir"
}
trap cleanup EXIT INT TERM

if [ "$runtime" = podman ]; then
  podman machine start >/dev/null 2>&1 || true
fi

mkdir -p "$fixture_dir/postgres" "$fixture_dir/rustfs"

openssl req -x509 -newkey rsa:2048 -nodes -days 2 \
  -subj '/CN=Nuriteo SAVE-009 PostgreSQL CA' \
  -addext 'basicConstraints=critical,CA:TRUE' \
  -addext 'keyUsage=critical,keyCertSign,cRLSign' \
  -keyout "$fixture_dir/postgres/ca.key" -out "$fixture_dir/postgres/ca.crt" >/dev/null 2>&1
openssl req -newkey rsa:2048 -nodes -subj '/CN=localhost' \
  -keyout "$fixture_dir/postgres/server.key" -out "$fixture_dir/postgres/server.csr" >/dev/null 2>&1
printf '%s\n' 'subjectAltName=DNS:localhost,IP:127.0.0.1' 'extendedKeyUsage=serverAuth' \
  >"$fixture_dir/postgres/server.ext"
openssl x509 -req -days 2 -in "$fixture_dir/postgres/server.csr" \
  -CA "$fixture_dir/postgres/ca.crt" -CAkey "$fixture_dir/postgres/ca.key" -CAcreateserial \
  -extfile "$fixture_dir/postgres/server.ext" -out "$fixture_dir/postgres/server.crt" >/dev/null 2>&1

openssl req -x509 -newkey rsa:2048 -nodes -days 2 \
  -subj '/CN=Nuriteo SAVE-009 RustFS CA' \
  -addext 'basicConstraints=critical,CA:TRUE' \
  -addext 'keyUsage=critical,keyCertSign,cRLSign' \
  -keyout "$fixture_dir/rustfs/ca.key" -out "$fixture_dir/rustfs/ca.crt" >/dev/null 2>&1
openssl req -newkey rsa:2048 -nodes -subj '/CN=localhost' \
  -keyout "$fixture_dir/rustfs/rustfs_key.pem" -out "$fixture_dir/rustfs/server.csr" >/dev/null 2>&1
printf '%s\n' 'subjectAltName=DNS:localhost,IP:127.0.0.1' 'extendedKeyUsage=serverAuth' \
  >"$fixture_dir/rustfs/server.ext"
openssl x509 -req -days 2 -in "$fixture_dir/rustfs/server.csr" \
  -CA "$fixture_dir/rustfs/ca.crt" -CAkey "$fixture_dir/rustfs/ca.key" -CAcreateserial \
  -extfile "$fixture_dir/rustfs/server.ext" -out "$fixture_dir/rustfs/rustfs_cert.pem" >/dev/null 2>&1

echo 'SAVE-009 fixture: starting pinned PostgreSQL and RustFS'
"$runtime" run --detach --name "$postgres_container" \
  --publish "127.0.0.1:${postgres_port}:5432" \
  --env POSTGRES_DB=nuriteo --env POSTGRES_USER=nuriteo \
  --env POSTGRES_PASSWORD="$postgres_password" "$postgres_image" >/dev/null
"$runtime" run --detach --name "$rustfs_container" \
  --publish "127.0.0.1:${rustfs_port}:9000" \
  --volume "$fixture_dir/rustfs:/certs:ro" --env RUSTFS_TLS_PATH=/certs \
  --env RUSTFS_ACCESS_KEY=save009-access \
  --env RUSTFS_SECRET_KEY=save009-secret-0123456789 "$rustfs_image" >/dev/null

for _ in $(seq 1 60); do
  if "$runtime" exec "$postgres_container" pg_isready -U nuriteo -d nuriteo >/dev/null 2>&1; then break; fi
  sleep 1
done
"$runtime" exec "$postgres_container" pg_isready -U nuriteo -d nuriteo >/dev/null
"$runtime" cp "$fixture_dir/postgres/server.crt" "$postgres_container:/var/lib/postgresql/server.crt"
"$runtime" cp "$fixture_dir/postgres/server.key" "$postgres_container:/var/lib/postgresql/server.key"
"$runtime" exec --user root "$postgres_container" chown postgres:postgres /var/lib/postgresql/server.crt /var/lib/postgresql/server.key
"$runtime" exec --user root "$postgres_container" chmod 600 /var/lib/postgresql/server.key
"$runtime" exec "$postgres_container" psql -v ON_ERROR_STOP=1 -U nuriteo -d nuriteo \
  -c "ALTER SYSTEM SET ssl = 'on'" \
  -c "ALTER SYSTEM SET ssl_cert_file = '/var/lib/postgresql/server.crt'" \
  -c "ALTER SYSTEM SET ssl_key_file = '/var/lib/postgresql/server.key'" >/dev/null
"$runtime" restart "$postgres_container" >/dev/null

for _ in $(seq 1 60); do
  postgres_ready=0
  rustfs_ready=0
  "$runtime" exec "$postgres_container" pg_isready -U nuriteo -d nuriteo >/dev/null 2>&1 && postgres_ready=1
  curl --fail --silent --cacert "$fixture_dir/rustfs/ca.crt" \
    "https://127.0.0.1:${rustfs_port}/health" >/dev/null 2>&1 && rustfs_ready=1
  if [ "$postgres_ready" -eq 1 ] && [ "$rustfs_ready" -eq 1 ]; then break; fi
  sleep 1
done
"$runtime" exec "$postgres_container" pg_isready -U nuriteo -d nuriteo >/dev/null
curl --fail --silent --cacert "$fixture_dir/rustfs/ca.crt" \
  "https://127.0.0.1:${rustfs_port}/health" >/dev/null

echo 'SAVE-009 fixture: running atomic session and bounded bearer assertions'
NURITEO_TEST_DATABASE_URL="postgres://nuriteo:${postgres_password}@localhost:${postgres_port}/nuriteo" \
NURITEO_TEST_DATABASE_CA="$fixture_dir/postgres/ca.crt" \
NURITEO_TEST_S3_ENDPOINT="https://127.0.0.1:${rustfs_port}" \
NURITEO_TEST_S3_CA_FILE="$fixture_dir/rustfs/ca.crt" \
CARGO_TARGET_DIR="${CARGO_TARGET_DIR:-/private/tmp/nuriteo-save009-target}" \
cargo test -p nuriteo-server --test save_cleanup \
  cleanup_is_bounded_persisted_redacted_and_restart_safe -- --ignored --exact --nocapture
NURITEO_TEST_DATABASE_URL="postgres://nuriteo:${postgres_password}@localhost:${postgres_port}/nuriteo" \
NURITEO_TEST_DATABASE_CA="$fixture_dir/postgres/ca.crt" \
NURITEO_TEST_S3_ENDPOINT="https://127.0.0.1:${rustfs_port}" \
NURITEO_TEST_S3_CA_FILE="$fixture_dir/rustfs/ca.crt" \
CARGO_TARGET_DIR="${CARGO_TARGET_DIR:-/private/tmp/nuriteo-save009-target}" \
cargo test -p nuriteo-server --test save_cleanup \
  stale_canonical_materialization_aborts_persisted_multipart -- --ignored --exact --nocapture
