#!/usr/bin/env bash
set -euo pipefail
umask 077

runtime="${CONTAINER_RUNTIME:-podman}"
postgres_image='docker.io/library/postgres@sha256:2d2b8998d31037bf721cfdf764d76ba74171b4fab3431b7f72c27c56ddbdf9e3'
rustfs_image='docker.io/rustfs/rustfs@sha256:42edb61d588775f9431ff436216d14392d2234d4eb2ed68321569fbf7245b36b'
origin_port="${NURITEO_TEST_GIT_PORT:-55487}"
sink_port="${NURITEO_TEST_GIT_SINK_PORT:-55488}"
postgres_port="${NURITEO_TEST_DATABASE_PORT:-55489}"
rustfs_port="${NURITEO_TEST_S3_PORT:-55490}"
fixture_dir="$(mktemp -d "${TMPDIR:-/tmp}/nuriteo-git-002.XXXXXX")"
token="$(openssl rand -hex 24)"
server_pid=""
postgres_container="nuriteo-git002-postgres-${RANDOM}"
rustfs_container="nuriteo-git002-rustfs-${RANDOM}"

cleanup() {
  local status="$?"
  if [[ "$status" -ne 0 && -f "$fixture_dir/server.log" ]]; then
    echo '--- smart Git fixture log ---' >&2
    tail -200 "$fixture_dir/server.log" >&2 || true
  fi
  if [[ -n "$server_pid" ]]; then
    kill "$server_pid" >/dev/null 2>&1 || true
    wait "$server_pid" >/dev/null 2>&1 || true
  fi
  "$runtime" rm --force "$postgres_container" >/dev/null 2>&1 || true
  "$runtime" rm --force "$rustfs_container" >/dev/null 2>&1 || true
  rm -rf -- "$fixture_dir"
}
trap cleanup EXIT

command -v "$runtime" >/dev/null
git --version

openssl req -x509 -newkey rsa:2048 -nodes -days 2 \
  -subj '/CN=Nuriteo Git Test CA' \
  -addext 'basicConstraints=critical,CA:TRUE' \
  -addext 'keyUsage=critical,keyCertSign,cRLSign' \
  -keyout "$fixture_dir/ca.key" -out "$fixture_dir/ca.crt" >/dev/null 2>&1
openssl req -newkey rsa:2048 -nodes -subj '/CN=localhost' \
  -keyout "$fixture_dir/server.key" -out "$fixture_dir/server.csr" >/dev/null 2>&1
printf '%s\n' 'subjectAltName=DNS:localhost,IP:127.0.0.1' \
  'keyUsage=critical,digitalSignature,keyEncipherment' \
  'extendedKeyUsage=serverAuth' 'basicConstraints=critical,CA:FALSE' >"$fixture_dir/server.ext"
openssl x509 -req -days 2 -in "$fixture_dir/server.csr" \
  -CA "$fixture_dir/ca.crt" -CAkey "$fixture_dir/ca.key" -CAcreateserial \
  -extfile "$fixture_dir/server.ext" -out "$fixture_dir/server.crt" >/dev/null 2>&1

mkdir -p "$fixture_dir/git-root" "$fixture_dir/work"
git init --bare "$fixture_dir/git-root/repo.git" >/dev/null
git init -b main "$fixture_dir/work" >/dev/null
git -C "$fixture_dir/work" remote add origin "$fixture_dir/git-root/repo.git"
printf 'initial\n' >"$fixture_dir/work/README.md"
git -C "$fixture_dir/work" add README.md
git -C "$fixture_dir/work" -c user.name=Fixture -c user.email=fixture@example.test \
  commit -m initial >/dev/null
git -C "$fixture_dir/work" push origin HEAD:main >/dev/null
git --git-dir="$fixture_dir/git-root/repo.git" config http.receivepack true

python3 "$(dirname "$0")/smart_git_server.py" \
  "$fixture_dir/git-root" "$fixture_dir/work" \
  "$fixture_dir/server.crt" "$fixture_dir/server.key" "$token" \
  "$origin_port" "$sink_port" >"$fixture_dir/server.log" 2>&1 &
server_pid="$!"
for _ in $(seq 1 50); do
  if curl --silent --cacert "$fixture_dir/ca.crt" \
    "https://localhost:${origin_port}/__redirect-auth-count" >/dev/null 2>&1; then
    break
  fi
  sleep 0.1
done

mkdir -p "$fixture_dir/postgres" "$fixture_dir/rustfs"
make_service_cert() {
  local directory="$1" common_name="$2" certificate="$3" key="$4"
  openssl req -x509 -newkey rsa:2048 -nodes -days 2 -subj "/CN=${common_name} CA" \
    -addext 'basicConstraints=critical,CA:TRUE' -addext 'keyUsage=critical,keyCertSign,cRLSign' \
    -keyout "$directory/ca.key" -out "$directory/ca.crt" >/dev/null 2>&1
  openssl req -newkey rsa:2048 -nodes -subj '/CN=localhost' \
    -keyout "$directory/$key" -out "$directory/server.csr" >/dev/null 2>&1
  printf '%s\n' 'subjectAltName=DNS:localhost,IP:127.0.0.1' \
    'basicConstraints=critical,CA:FALSE' 'extendedKeyUsage=serverAuth' >"$directory/server.ext"
  openssl x509 -req -days 2 -in "$directory/server.csr" -CA "$directory/ca.crt" \
    -CAkey "$directory/ca.key" -CAcreateserial -extfile "$directory/server.ext" \
    -out "$directory/$certificate" >/dev/null 2>&1
}
make_service_cert "$fixture_dir/postgres" 'Nuriteo GIT-002 PostgreSQL' server.crt server.key
make_service_cert "$fixture_dir/rustfs" 'Nuriteo GIT-002 RustFS' rustfs_cert.pem rustfs_key.pem

"$runtime" run --detach --name "$postgres_container" --publish "127.0.0.1:${postgres_port}:5432" \
  --env POSTGRES_DB=nuriteo --env POSTGRES_USER=nuriteo --env POSTGRES_PASSWORD=git002-password \
  "$postgres_image" >/dev/null
for _ in $(seq 1 60); do "$runtime" exec "$postgres_container" pg_isready -U nuriteo -d nuriteo >/dev/null 2>&1 && break; sleep 1; done
"$runtime" cp "$fixture_dir/postgres/server.crt" "$postgres_container:/var/lib/postgresql/server.crt"
"$runtime" cp "$fixture_dir/postgres/server.key" "$postgres_container:/var/lib/postgresql/server.key"
"$runtime" exec --user root "$postgres_container" chown postgres:postgres /var/lib/postgresql/server.crt /var/lib/postgresql/server.key
"$runtime" exec --user root "$postgres_container" chmod 600 /var/lib/postgresql/server.key
"$runtime" exec "$postgres_container" psql -v ON_ERROR_STOP=1 -U nuriteo -d nuriteo \
  -c "ALTER SYSTEM SET ssl='on'" -c "ALTER SYSTEM SET ssl_cert_file='/var/lib/postgresql/server.crt'" \
  -c "ALTER SYSTEM SET ssl_key_file='/var/lib/postgresql/server.key'" >/dev/null
"$runtime" restart "$postgres_container" >/dev/null
for _ in $(seq 1 60); do "$runtime" exec "$postgres_container" pg_isready -U nuriteo -d nuriteo >/dev/null 2>&1 && break; sleep 1; done

"$runtime" run --detach --name "$rustfs_container" --publish "127.0.0.1:${rustfs_port}:9000" \
  --volume "$fixture_dir/rustfs:/certs:ro" --env RUSTFS_TLS_PATH=/certs \
  --env RUSTFS_ACCESS_KEY=integration-access --env RUSTFS_SECRET_KEY=integration-secret-0123456789 \
  "$rustfs_image" >/dev/null
for _ in $(seq 1 60); do curl --fail --silent --cacert "$fixture_dir/rustfs/ca.crt" "https://127.0.0.1:${rustfs_port}/health" >/dev/null 2>&1 && break; sleep 1; done

NURITEO_TEST_DATABASE_URL="postgres://nuriteo:git002-password@localhost:${postgres_port}/nuriteo" \
NURITEO_TEST_DATABASE_CA="$fixture_dir/postgres/ca.crt" \
NURITEO_TEST_S3_ENDPOINT="https://127.0.0.1:${rustfs_port}" \
NURITEO_TEST_S3_CA_FILE="$fixture_dir/rustfs/ca.crt" \
NURITEO_TEST_GIT_URL="https://localhost:${origin_port}/repo.git" \
NURITEO_TEST_GIT_REDIRECT_URL="https://localhost:${origin_port}/redirect.git" \
NURITEO_TEST_GIT_CONTROL_URL="https://localhost:${origin_port}" \
NURITEO_TEST_GIT_CA="$fixture_dir/ca.crt" \
NURITEO_TEST_GIT_TOKEN="$token" \
NURITEO_TEST_GIT_REPOSITORY="$fixture_dir/git-root/repo.git" \
CARGO_TARGET_DIR="${CARGO_TARGET_DIR:-/private/tmp/nuriteo-git002-target}" \
cargo test -p nuriteo-server --lib \
  git_operations::tests::actual_https_fixture::production_service_actual_https_journey \
  -- --ignored --exact --nocapture

echo 'GIT-002 actual HTTPS service fixture: PASS'
