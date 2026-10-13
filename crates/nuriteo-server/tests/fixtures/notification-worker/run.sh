#!/usr/bin/env bash
set -eu

fixture_dir=$(CDPATH= cd -- "$(dirname -- "$0")" && pwd)
repo_dir=$(CDPATH= cd -- "$fixture_dir/../../../.." && pwd)
tmp_dir=$(mktemp -d "${TMPDIR:-/tmp}/nuriteo-notification-worker.XXXXXX")
runtime="${CONTAINER_RUNTIME:-podman}"
image="docker.io/library/postgres@sha256:2d2b8998d31037bf721cfdf764d76ba74171b4fab3431b7f72c27c56ddbdf9e3"
container="nuriteo-not-002-${RANDOM}"
database_port="${NURITEO_TEST_DATABASE_PORT:-55465}"
smtp_pid=""

cleanup() {
  if [ -n "$smtp_pid" ]; then
    kill "$smtp_pid" 2>/dev/null || true
    wait "$smtp_pid" 2>/dev/null || true
  fi
  "$runtime" rm --force "$container" >/dev/null 2>&1 || true
  rm -rf "$tmp_dir"
}
trap cleanup EXIT INT TERM

openssl req -x509 -newkey rsa:2048 -nodes -days 1 \
  -subj '/CN=NURITEO Worker Fixture CA' \
  -addext 'basicConstraints=critical,CA:TRUE' \
  -addext 'keyUsage=critical,keyCertSign,cRLSign' \
  -keyout "$tmp_dir/ca.key" -out "$tmp_dir/ca.pem" >/dev/null 2>&1
openssl req -newkey rsa:2048 -nodes -subj '/CN=localhost' \
  -keyout "$tmp_dir/server.key" -out "$tmp_dir/server.csr" >/dev/null 2>&1
printf '%s\n' 'subjectAltName=DNS:localhost,IP:127.0.0.1' \
  'extendedKeyUsage=serverAuth' >"$tmp_dir/server.ext"
openssl x509 -req -days 1 -sha256 -in "$tmp_dir/server.csr" \
  -CA "$tmp_dir/ca.pem" -CAkey "$tmp_dir/ca.key" -CAcreateserial \
  -extfile "$tmp_dir/server.ext" -out "$tmp_dir/server.pem" >/dev/null 2>&1
printf '%s\n' 'fixture-user' >"$tmp_dir/username"
printf '%s\n' 'fixture-password-sensitive' >"$tmp_dir/password"

database_password=$(openssl rand -hex 24)
"$runtime" run --detach --name "$container" \
  --publish "127.0.0.1:${database_port}:5432" \
  --env POSTGRES_DB=nuriteo --env POSTGRES_USER=nuriteo \
  --env POSTGRES_PASSWORD="$database_password" "$image" >/dev/null
attempt=0
until "$runtime" exec "$container" pg_isready -U nuriteo -d nuriteo >/dev/null 2>&1; do
  attempt=$((attempt + 1))
  [ "$attempt" -lt 60 ] || exit 1
  sleep 1
done
"$runtime" cp "$tmp_dir/server.pem" "$container:/var/lib/postgresql/server.crt"
"$runtime" cp "$tmp_dir/server.key" "$container:/var/lib/postgresql/server.key"
"$runtime" exec --user root "$container" chown postgres:postgres \
  /var/lib/postgresql/server.crt /var/lib/postgresql/server.key
"$runtime" exec --user root "$container" chmod 600 /var/lib/postgresql/server.key
"$runtime" exec "$container" psql -v ON_ERROR_STOP=1 -U nuriteo -d nuriteo \
  -c "ALTER SYSTEM SET ssl = 'on'" \
  -c "ALTER SYSTEM SET ssl_cert_file = '/var/lib/postgresql/server.crt'" \
  -c "ALTER SYSTEM SET ssl_key_file = '/var/lib/postgresql/server.key'" >/dev/null
"$runtime" restart "$container" >/dev/null
attempt=0
until "$runtime" exec "$container" pg_isready -U nuriteo -d nuriteo >/dev/null 2>&1; do
  attempt=$((attempt + 1))
  [ "$attempt" -lt 60 ] || exit 1
  sleep 1
done

smtp_port=$(python3 -c 'import socket; s=socket.socket(); s.bind(("127.0.0.1",0)); print(s.getsockname()[1]); s.close()')
python3 "$fixture_dir/server.py" "$smtp_port" "$tmp_dir/server.pem" "$tmp_dir/server.key" \
  >"$tmp_dir/smtp.log" 2>&1 &
smtp_pid=$!
attempt=0
until grep -q '^READY$' "$tmp_dir/smtp.log"; do
  attempt=$((attempt + 1))
  if [ "$attempt" -ge 100 ]; then
    sed -n '1,120p' "$tmp_dir/smtp.log" >&2
    exit 1
  fi
  sleep 0.05
done

cd "$repo_dir"
NURITEO_TEST_DATABASE_URL="postgres://nuriteo:${database_password}@localhost:${database_port}/nuriteo" \
NURITEO_TEST_DATABASE_CA="$tmp_dir/ca.pem" \
NURITEO_MASTER_KEY=AAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA \
NURITEO_MASTER_KEY_VERSION=1 \
NURITEO_SMTP_HOST=localhost NURITEO_SMTP_PORT="$smtp_port" \
NURITEO_SMTP_SECURITY=implicit-tls NURITEO_SMTP_FROM_ADDRESS=noreply@example.test \
NURITEO_SMTP_FROM_NAME='NURITEO "Fixture"' \
NURITEO_SMTP_USERNAME_FILE="$tmp_dir/username" \
NURITEO_SMTP_PASSWORD_FILE="$tmp_dir/password" \
NURITEO_SMTP_CA_FILE="$tmp_dir/ca.pem" NURITEO_SMTP_PREFLIGHT_TIMEOUT_MS=5000 \
cargo test -p nuriteo-server --test notification_worker \
  worker_retries_dead_letters_recovers_and_drains_with_actual_tls_smtp \
  -- --ignored --exact --nocapture

if grep -Eq 'fixture-password-sensitive|fixture-body-sensitive|detail-sensitive' "$tmp_dir/smtp.log"; then
  echo 'sensitive SMTP material leaked to fixture log' >&2
  exit 1
fi
