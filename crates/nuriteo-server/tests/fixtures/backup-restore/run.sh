#!/usr/bin/env bash
set -euo pipefail

runtime="${CONTAINER_RUNTIME:-podman}"
runtime_path="$(command -v "$runtime")"
postgres_image="docker.io/library/postgres@sha256:2d2b8998d31037bf721cfdf764d76ba74171b4fab3431b7f72c27c56ddbdf9e3"
rustfs_image="docker.io/rustfs/rustfs@sha256:42edb61d588775f9431ff436216d14392d2234d4eb2ed68321569fbf7245b36b"
postgres_container="nuriteo-bkp-004-postgres"
rustfs_container="nuriteo-bkp-004-rustfs"
postgres_port="${NURITEO_TEST_DATABASE_PORT:-55449}"
rustfs_port="${NURITEO_TEST_S3_PORT:-19004}"
fixture_dir="$(mktemp -d "${TMPDIR:-/tmp}/nuriteo-bkp-004.XXXXXX")"
script_dir="$(cd "$(dirname "$0")" && pwd)"
postgres_cert_dir="$fixture_dir/postgres-certs"
rustfs_cert_dir="$fixture_dir/rustfs-certs"
scratch_dir="$fixture_dir/scratch"
wrapper_dir="$fixture_dir/wrappers"
mkdir -p "$postgres_cert_dir" "$rustfs_cert_dir" "$scratch_dir" "$wrapper_dir"

cleanup() {
  status=$?
  if [[ $status -ne 0 ]]; then
    "$runtime" logs "$postgres_container" >&2 || true
    "$runtime" logs "$rustfs_container" >&2 || true
  fi
  "$runtime" rm --force "$postgres_container" "$rustfs_container" >/dev/null 2>&1 || true
  rm -rf -- "$fixture_dir"
}
trap cleanup EXIT INT TERM

openssl req -x509 -newkey rsa:2048 -nodes -days 2 \
  -subj '/CN=Nuriteo Backup Restore Test CA' \
  -addext 'basicConstraints=critical,CA:TRUE' \
  -addext 'keyUsage=critical,keyCertSign,cRLSign' \
  -keyout "$fixture_dir/ca.key" -out "$fixture_dir/ca.crt" >/dev/null 2>&1
openssl req -newkey rsa:2048 -nodes -subj '/CN=localhost' \
  -keyout "$postgres_cert_dir/server.key" -out "$fixture_dir/postgres.csr" >/dev/null 2>&1
printf '%s\n' 'subjectAltName=DNS:localhost,IP:127.0.0.1' 'extendedKeyUsage=serverAuth' \
  'basicConstraints=critical,CA:FALSE' >"$fixture_dir/server.ext"
openssl x509 -req -days 2 -in "$fixture_dir/postgres.csr" \
  -CA "$fixture_dir/ca.crt" -CAkey "$fixture_dir/ca.key" -CAcreateserial \
  -extfile "$fixture_dir/server.ext" -out "$postgres_cert_dir/server.crt" >/dev/null 2>&1
openssl req -newkey rsa:2048 -nodes -subj '/CN=localhost' \
  -keyout "$rustfs_cert_dir/rustfs_key.pem" -out "$fixture_dir/rustfs.csr" >/dev/null 2>&1
openssl x509 -req -days 2 -in "$fixture_dir/rustfs.csr" \
  -CA "$fixture_dir/ca.crt" -CAkey "$fixture_dir/ca.key" -CAcreateserial \
  -extfile "$fixture_dir/server.ext" -out "$rustfs_cert_dir/rustfs_cert.pem" >/dev/null 2>&1

"$runtime" run --detach --name "$postgres_container" \
  --publish "127.0.0.1:${postgres_port}:5432" \
  --env POSTGRES_DB=nuriteo --env POSTGRES_USER=nuriteo \
  --env POSTGRES_PASSWORD=nuriteo-test-password "$postgres_image" >/dev/null
for _ in $(seq 1 60); do
  if "$runtime" exec "$postgres_container" pg_isready -U nuriteo -d nuriteo >/dev/null 2>&1; then break; fi
  sleep 1
done
"$runtime" exec "$postgres_container" pg_isready -U nuriteo -d nuriteo >/dev/null
"$runtime" cp "$postgres_cert_dir/server.crt" "$postgres_container:/var/lib/postgresql/server.crt"
"$runtime" cp "$postgres_cert_dir/server.key" "$postgres_container:/var/lib/postgresql/server.key"
"$runtime" exec --user root "$postgres_container" chown postgres:postgres \
  /var/lib/postgresql/server.crt /var/lib/postgresql/server.key
"$runtime" exec --user root "$postgres_container" chmod 600 /var/lib/postgresql/server.key
"$runtime" exec "$postgres_container" psql -v ON_ERROR_STOP=1 -U nuriteo -d nuriteo \
  -c "CREATE DATABASE nuriteo_restore" \
  -c "ALTER SYSTEM SET ssl = 'on'" \
  -c "ALTER SYSTEM SET ssl_cert_file = '/var/lib/postgresql/server.crt'" \
  -c "ALTER SYSTEM SET ssl_key_file = '/var/lib/postgresql/server.key'" >/dev/null
"$runtime" restart "$postgres_container" >/dev/null
for _ in $(seq 1 60); do
  if "$runtime" exec "$postgres_container" pg_isready -U nuriteo -d nuriteo >/dev/null 2>&1; then break; fi
  sleep 1
done

sse_s3_master_key="$(openssl rand -base64 32 | tr -d '\n')"
"$runtime" run --detach --name "$rustfs_container" \
  --publish "127.0.0.1:${rustfs_port}:9000" \
  --volume "$rustfs_cert_dir:/certs:ro" \
  --env RUSTFS_TLS_PATH=/certs \
  --env RUSTFS_ACCESS_KEY=nuriteo-restore-access \
  --env RUSTFS_SECRET_KEY=nuriteo-restore-secret-0123456789 \
  --env RUSTFS_SSE_S3_MASTER_KEY="$sse_s3_master_key" "$rustfs_image" >/dev/null
for _ in $(seq 1 60); do
  if curl --fail --silent --cacert "$fixture_dir/ca.crt" \
    "https://127.0.0.1:${rustfs_port}/health" >/dev/null 2>&1; then break; fi
  sleep 1
done
curl --fail --silent --cacert "$fixture_dir/ca.crt" \
  "https://127.0.0.1:${rustfs_port}/health" >/dev/null

cp "$script_dir/pg-dump-wrapper.sh" "$script_dir/pg-restore-wrapper.sh" "$wrapper_dir/"
printf '%s' "$runtime_path" >"$wrapper_dir/runtime-path"
printf '%s' "$postgres_container" >"$wrapper_dir/container-name"
chmod +x "$wrapper_dir/pg-dump-wrapper.sh" "$wrapper_dir/pg-restore-wrapper.sh"

database_url="postgres://nuriteo:nuriteo-test-password@localhost:${postgres_port}/nuriteo"
restore_database_url="postgres://nuriteo:nuriteo-test-password@localhost:${postgres_port}/nuriteo_restore"
s3_endpoint="https://127.0.0.1:${rustfs_port}"
common_access_key='nuriteo-restore-access'
common_secret_key='nuriteo-restore-secret-0123456789'

NURITEO_DATABASE_URL="$database_url" \
NURITEO_DATABASE_CA_FILE="$fixture_dir/ca.crt" \
NURITEO_PG_DUMP_PATH="$wrapper_dir/pg-dump-wrapper.sh" \
NURITEO_S3_ENDPOINT="$s3_endpoint" NURITEO_S3_REGION=us-east-1 \
NURITEO_S3_BUCKET=nuriteo-primary NURITEO_S3_ADDRESSING_STYLE=path \
NURITEO_S3_CREDENTIAL_PROVIDER=static NURITEO_S3_ACCESS_KEY_ID="$common_access_key" \
NURITEO_S3_SECRET_ACCESS_KEY="$common_secret_key" NURITEO_S3_CA_FILE="$fixture_dir/ca.crt" \
NURITEO_BACKUP_S3_ENDPOINT="$s3_endpoint" NURITEO_BACKUP_S3_REGION=us-east-1 \
NURITEO_BACKUP_S3_BUCKET=nuriteo-backup NURITEO_BACKUP_S3_PREFIX=instance-1/backups \
NURITEO_BACKUP_S3_ADDRESSING_STYLE=path NURITEO_BACKUP_S3_SSE=s3 \
NURITEO_BACKUP_S3_ACCESS_KEY_ID="$common_access_key" \
NURITEO_BACKUP_S3_SECRET_ACCESS_KEY="$common_secret_key" \
NURITEO_BACKUP_S3_CA_FILE="$fixture_dir/ca.crt" \
NURITEO_RESTORE_DATABASE_URL="$restore_database_url" \
NURITEO_RESTORE_DATABASE_CA_FILE="$fixture_dir/ca.crt" \
NURITEO_RESTORE_PG_RESTORE_PATH="$wrapper_dir/pg-restore-wrapper.sh" \
NURITEO_RESTORE_S3_ENDPOINT="$s3_endpoint" NURITEO_RESTORE_S3_REGION=us-east-1 \
NURITEO_RESTORE_S3_BUCKET=nuriteo-restore NURITEO_RESTORE_S3_ADDRESSING_STYLE=path \
NURITEO_RESTORE_S3_CREDENTIAL_PROVIDER=static \
NURITEO_RESTORE_S3_ACCESS_KEY_ID="$common_access_key" \
NURITEO_RESTORE_S3_SECRET_ACCESS_KEY="$common_secret_key" \
NURITEO_RESTORE_S3_CA_FILE="$fixture_dir/ca.crt" \
NURITEO_BACKUP_SCRATCH_DIR="$scratch_dir" NURITEO_TEST_S3_CA_FILE="$fixture_dir/ca.crt" \
RUST_MIN_STACK=16777216 \
cargo test -p nuriteo-server --test backup_restore \
  encrypted_backup_restores_into_isolated_database_and_bucket -- --ignored --exact --nocapture
