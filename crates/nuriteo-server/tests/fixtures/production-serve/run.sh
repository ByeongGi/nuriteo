#!/usr/bin/env bash
set -euo pipefail

runtime="${CONTAINER_RUNTIME:-podman}"
postgres_image="docker.io/library/postgres@sha256:2d2b8998d31037bf721cfdf764d76ba74171b4fab3431b7f72c27c56ddbdf9e3"
rustfs_image="docker.io/rustfs/rustfs@sha256:42edb61d588775f9431ff436216d14392d2234d4eb2ed68321569fbf7245b36b"
postgres_container="nuriteo-srv-004-postgres-${RANDOM}"
rustfs_container="nuriteo-srv-004-rustfs-${RANDOM}"
postgres_port="${NURITEO_TEST_DATABASE_PORT:-55436}"
rustfs_port="${NURITEO_TEST_S3_PORT:-19003}"
fixture_dir="$(mktemp -d "${TMPDIR:-/tmp}/nuriteo-srv-004.XXXXXX")"
postgres_tls="$fixture_dir/postgres"
rustfs_tls="$fixture_dir/rustfs"
mkdir -p "$postgres_tls" "$rustfs_tls/certs"

cleanup() {
  "$runtime" rm --force "$postgres_container" >/dev/null 2>&1 || true
  "$runtime" rm --force "$rustfs_container" >/dev/null 2>&1 || true
  rm -rf -- "$fixture_dir"
}
trap cleanup EXIT INT TERM

openssl req -x509 -newkey rsa:2048 -nodes -days 2 \
  -subj '/CN=Nuriteo Serve PostgreSQL Test CA' \
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
  --env POSTGRES_PASSWORD=nuriteo-test-password \
  "$postgres_image" >/dev/null
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
  -subj '/CN=Nuriteo Serve RustFS Test CA' \
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

NURITEO_TEST_DATABASE_URL="postgres://nuriteo:nuriteo-test-password@localhost:${postgres_port}/nuriteo" \
NURITEO_TEST_DATABASE_CA="$postgres_tls/ca.crt" \
NURITEO_TEST_S3_ENDPOINT="https://127.0.0.1:${rustfs_port}" \
NURITEO_TEST_S3_CA_FILE="$rustfs_tls/ca.crt" \
cargo test -p nuriteo-server --test serve_backends --all-features \
  production_binary_serves_drains_and_never_mutates_backends \
  -- --ignored --exact --nocapture
