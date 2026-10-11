#!/usr/bin/env bash
set -euo pipefail

runtime="${CONTAINER_RUNTIME:-podman}"
image="docker.io/library/postgres@sha256:2d2b8998d31037bf721cfdf764d76ba74171b4fab3431b7f72c27c56ddbdf9e3"
container="nuriteo-inv-003-${RANDOM}"
port="${NURITEO_TEST_DATABASE_PORT:-55449}"
fixture_dir="$(mktemp -d "${TMPDIR:-/tmp}/nuriteo-inv-003.XXXXXX")"
database_password="$(openssl rand -hex 24)"

cleanup() {
  "$runtime" rm --force "$container" >/dev/null 2>&1 || true
  rm -rf "$fixture_dir"
}
trap cleanup EXIT

echo "INV-003 fixture: generating ephemeral TLS material"
openssl req -x509 -newkey rsa:2048 -nodes -days 2 \
  -subj '/CN=Nuriteo Invitation HTTP Test CA' \
  -addext 'basicConstraints=critical,CA:TRUE' \
  -addext 'keyUsage=critical,keyCertSign,cRLSign' \
  -keyout "$fixture_dir/ca.key" -out "$fixture_dir/ca.crt" >/dev/null 2>&1
openssl req -newkey rsa:2048 -nodes -subj '/CN=localhost' \
  -keyout "$fixture_dir/server.key" -out "$fixture_dir/server.csr" >/dev/null 2>&1
printf '%s\n' \
  'subjectAltName=DNS:localhost,IP:127.0.0.1' \
  'extendedKeyUsage=serverAuth' \
  'basicConstraints=critical,CA:FALSE' >"$fixture_dir/server.ext"
openssl x509 -req -days 2 -in "$fixture_dir/server.csr" \
  -CA "$fixture_dir/ca.crt" -CAkey "$fixture_dir/ca.key" -CAcreateserial \
  -extfile "$fixture_dir/server.ext" -out "$fixture_dir/server.crt" >/dev/null 2>&1

echo "INV-003 fixture: starting pinned PostgreSQL"
"$runtime" run --detach --name "$container" \
  --publish "127.0.0.1:${port}:5432" \
  --env POSTGRES_DB=nuriteo \
  --env POSTGRES_USER=nuriteo \
  --env POSTGRES_PASSWORD="$database_password" \
  "$image" >/dev/null

for _ in $(seq 1 60); do
  if "$runtime" exec "$container" pg_isready -U nuriteo -d nuriteo >/dev/null 2>&1; then
    break
  fi
  sleep 1
done
"$runtime" exec "$container" pg_isready -U nuriteo -d nuriteo >/dev/null

echo "INV-003 fixture: enabling custom-CA PostgreSQL TLS"
"$runtime" cp "$fixture_dir/server.crt" "$container:/var/lib/postgresql/server.crt"
"$runtime" cp "$fixture_dir/server.key" "$container:/var/lib/postgresql/server.key"
"$runtime" exec --user root "$container" chown postgres:postgres \
  /var/lib/postgresql/server.crt /var/lib/postgresql/server.key
"$runtime" exec --user root "$container" chmod 600 /var/lib/postgresql/server.key
"$runtime" exec "$container" psql -v ON_ERROR_STOP=1 -U nuriteo -d nuriteo \
  -c "ALTER SYSTEM SET ssl = 'on'" \
  -c "ALTER SYSTEM SET ssl_cert_file = '/var/lib/postgresql/server.crt'" \
  -c "ALTER SYSTEM SET ssl_key_file = '/var/lib/postgresql/server.key'" >/dev/null
"$runtime" restart "$container" >/dev/null

for _ in $(seq 1 60); do
  if "$runtime" exec "$container" pg_isready -U nuriteo -d nuriteo >/dev/null 2>&1; then
    break
  fi
  sleep 1
done
"$runtime" exec "$container" pg_isready -U nuriteo -d nuriteo >/dev/null

echo "INV-003 fixture: running invitation HTTP assertions"
NURITEO_TEST_DATABASE_URL="postgres://nuriteo:${database_password}@localhost:${port}/nuriteo" \
NURITEO_TEST_DATABASE_CA="$fixture_dir/ca.crt" \
CARGO_TARGET_DIR="${CARGO_TARGET_DIR:-/private/tmp/nuriteo-inv003-target}" \
cargo test -p nuriteo-server --test invitation_http \
  invitation_http_slice_is_authorized_atomic_one_time_and_secret_free \
  -- --ignored --exact --nocapture
