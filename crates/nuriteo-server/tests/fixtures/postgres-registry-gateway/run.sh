#!/usr/bin/env bash
set -euo pipefail
runtime="${CONTAINER_RUNTIME:-podman}"
image="docker.io/library/postgres@sha256:2d2b8998d31037bf721cfdf764d76ba74171b4fab3431b7f72c27c56ddbdf9e3"
container="nuriteo-reg-001-${RANDOM}"
database_port="${NURITEO_TEST_DATABASE_PORT:-55480}"
registry_port="${NURITEO_TEST_REGISTRY_PORT:-58450}"
fixture_dir="$(mktemp -d "${TMPDIR:-/tmp}/nuriteo-reg-001.XXXXXX")"
database_password="$(openssl rand -hex 24)"
server_pid=""
cleanup(){ if [[ -n "$server_pid" ]];then kill "$server_pid" >/dev/null 2>&1||true;fi;"$runtime" rm --force "$container" >/dev/null 2>&1||true;rm -rf "$fixture_dir"; }
trap cleanup EXIT
openssl req -x509 -newkey rsa:2048 -nodes -days 2 -subj '/CN=Nuriteo Registry CA' -addext 'basicConstraints=critical,CA:TRUE' -addext 'keyUsage=critical,keyCertSign,cRLSign' -keyout "$fixture_dir/ca.key" -out "$fixture_dir/ca.crt" >/dev/null 2>&1
openssl req -newkey rsa:2048 -nodes -subj '/CN=localhost' -keyout "$fixture_dir/server.key" -out "$fixture_dir/server.csr" >/dev/null 2>&1
printf '%s\n' 'subjectAltName=DNS:localhost,IP:127.0.0.1' 'extendedKeyUsage=serverAuth' 'basicConstraints=critical,CA:FALSE' >"$fixture_dir/server.ext"
openssl x509 -req -days 2 -in "$fixture_dir/server.csr" -CA "$fixture_dir/ca.crt" -CAkey "$fixture_dir/ca.key" -CAcreateserial -extfile "$fixture_dir/server.ext" -out "$fixture_dir/server.crt" >/dev/null 2>&1
cp "$fixture_dir/server.crt" "$fixture_dir/postgres.crt";cp "$fixture_dir/server.key" "$fixture_dir/postgres.key"
printf '%s' normal >"$fixture_dir/mode";touch "$fixture_dir/requests"
REGISTRY_CONTROL_DIR="$fixture_dir" REGISTRY_PORT="$registry_port" REGISTRY_CERT="$fixture_dir/server.crt" REGISTRY_KEY="$fixture_dir/server.key" python3 "$(dirname "$0")/server.py" & server_pid="$!"
"$runtime" run --detach --name "$container" --publish "127.0.0.1:${database_port}:5432" --env POSTGRES_DB=nuriteo --env POSTGRES_USER=nuriteo --env POSTGRES_PASSWORD="$database_password" "$image" >/dev/null
for _ in $(seq 1 60);do "$runtime" exec "$container" pg_isready -U nuriteo -d nuriteo >/dev/null 2>&1&&break;sleep 1;done
"$runtime" cp "$fixture_dir/postgres.crt" "$container:/var/lib/postgresql/server.crt";"$runtime" cp "$fixture_dir/postgres.key" "$container:/var/lib/postgresql/server.key"
"$runtime" exec --user root "$container" chown postgres:postgres /var/lib/postgresql/server.crt /var/lib/postgresql/server.key;"$runtime" exec --user root "$container" chmod 600 /var/lib/postgresql/server.key
"$runtime" exec "$container" psql -v ON_ERROR_STOP=1 -U nuriteo -d nuriteo -c "ALTER SYSTEM SET ssl = 'on'" -c "ALTER SYSTEM SET ssl_cert_file = '/var/lib/postgresql/server.crt'" -c "ALTER SYSTEM SET ssl_key_file = '/var/lib/postgresql/server.key'" >/dev/null
"$runtime" restart "$container" >/dev/null
for _ in $(seq 1 60);do "$runtime" exec "$container" pg_isready -U nuriteo -d nuriteo >/dev/null 2>&1&&break;sleep 1;done
for _ in $(seq 1 60);do curl --silent --cacert "$fixture_dir/ca.crt" -H 'Authorization: Bearer default-token' "https://localhost:${registry_port}/default/-/ping" >/dev/null 2>&1&&break;sleep 1;done
NURITEO_TEST_DATABASE_URL="postgres://nuriteo:${database_password}@localhost:${database_port}/nuriteo" NURITEO_TEST_DATABASE_CA="$fixture_dir/ca.crt" NURITEO_TEST_REGISTRY_PORT="$registry_port" NURITEO_TEST_REGISTRY_CA="$fixture_dir/ca.crt" NURITEO_TEST_REGISTRY_CONTROL_DIR="$fixture_dir" cargo test -p nuriteo-server --lib registry_gateway::tests::actual_gateway_is_tls_pinned_scope_exact_and_never_falls_back -- --ignored --exact --nocapture
