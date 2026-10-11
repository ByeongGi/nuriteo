#!/usr/bin/env bash
set -euo pipefail

runtime="${CONTAINER_RUNTIME:-podman}"
image="docker.io/library/postgres@sha256:2d2b8998d31037bf721cfdf764d76ba74171b4fab3431b7f72c27c56ddbdf9e3"
container="nuriteo-upg-002-${RANDOM}"
port="${NURITEO_TEST_DATABASE_PORT:-55450}"
fixture_dir="$(mktemp -d "${TMPDIR:-/tmp}/nuriteo-upg-002.XXXXXX")"
repository_root="$(git rev-parse --show-toplevel)"
source_commit="b3abb46aaecb00c8d84307cf1d8c213595c31d67"

cleanup() {
  "$runtime" rm --force "$container" >/dev/null 2>&1 || true
  rm -rf "$fixture_dir"
}
trap cleanup EXIT

openssl req -x509 -newkey rsa:2048 -nodes -days 2 \
  -subj '/CN=Nuriteo Upgrade Preflight Test CA' \
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

"$runtime" run --detach --name "$container" \
  --publish "127.0.0.1:${port}:5432" \
  --env POSTGRES_DB=nuriteo \
  --env POSTGRES_USER=nuriteo \
  --env POSTGRES_PASSWORD=nuriteo-test-password \
  "$image" >/dev/null

for _ in $(seq 1 60); do
  if "$runtime" exec "$container" pg_isready -U nuriteo -d nuriteo >/dev/null 2>&1; then
    break
  fi
  sleep 1
done
"$runtime" exec "$container" pg_isready -U nuriteo -d nuriteo >/dev/null

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

git archive "$source_commit" --output "$fixture_dir/source.tar" -- Cargo.toml Cargo.lock crates compat
mkdir "$fixture_dir/source"
tar -xf "$fixture_dir/source.tar" -C "$fixture_dir/source"
CARGO_TARGET_DIR="$fixture_dir/previous-target" CARGO_INCREMENTAL=0 \
  cargo build --locked --quiet \
  --manifest-path "$fixture_dir/source/Cargo.toml" \
  --package nuriteo-server --bin nuriteo-server
NURITEO_EXTERNAL_URL="http://127.0.0.1:3000" \
NURITEO_DATABASE_URL="postgres://nuriteo:nuriteo-test-password@localhost:${port}/nuriteo" \
NURITEO_DATABASE_CA_FILE="$fixture_dir/ca.crt" \
NURITEO_DATABASE_MIN_CONNECTIONS=0 \
  "$fixture_dir/previous-target/debug/nuriteo-server" migrate \
  | grep -Fx 'database migration complete: schema=ready version=46'

NURITEO_TEST_DATABASE_URL="postgres://nuriteo:nuriteo-test-password@localhost:${port}/nuriteo" \
NURITEO_TEST_DATABASE_CA="$fixture_dir/ca.crt" \
cargo test -p nuriteo-server --test upgrade_preflight_postgres \
  preflight_is_read_only_and_stops_without_interrupting_previous_health \
  -- --ignored --exact --nocapture

NURITEO_EXTERNAL_URL="http://127.0.0.1:3000" \
NURITEO_DATABASE_URL="postgres://nuriteo:nuriteo-test-password@localhost:${port}/nuriteo" \
NURITEO_DATABASE_CA_FILE="$fixture_dir/ca.crt" \
NURITEO_DATABASE_MIN_CONNECTIONS=0 \
  "$fixture_dir/previous-target/debug/nuriteo-server" migrate \
  | grep -Fx 'database migration complete: schema=ready version=46'

NURITEO_TEST_DATABASE_URL="postgres://nuriteo:nuriteo-test-password@localhost:${port}/nuriteo" \
NURITEO_TEST_DATABASE_CA="$fixture_dir/ca.crt" \
cargo test -p nuriteo-server --test upgrade_preflight_postgres \
  migration_46_to_50_preserves_existing_domain_data \
  -- --ignored --exact --nocapture
