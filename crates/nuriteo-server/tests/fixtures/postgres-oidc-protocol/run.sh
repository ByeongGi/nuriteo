#!/usr/bin/env bash
set -euo pipefail

runtime="${CONTAINER_RUNTIME:-podman}"
image="docker.io/library/postgres@sha256:2d2b8998d31037bf721cfdf764d76ba74171b4fab3431b7f72c27c56ddbdf9e3"
container="nuriteo-oidc-002-${RANDOM}"
database_port="${NURITEO_TEST_DATABASE_PORT:-55470}"
oidc_port="${NURITEO_TEST_OIDC_PORT:-58443}"
fixture_dir="$(mktemp -d "${TMPDIR:-/tmp}/nuriteo-oidc-002.XXXXXX")"
database_password="$(openssl rand -hex 24)"
server_pid=""

cleanup() {
  if [[ -n "$server_pid" ]]; then kill "$server_pid" >/dev/null 2>&1 || true; fi
  "$runtime" rm --force "$container" >/dev/null 2>&1 || true
  rm -rf "$fixture_dir"
}
trap cleanup EXIT

openssl req -x509 -newkey rsa:2048 -nodes -days 2 \
  -subj '/CN=Nuriteo OIDC Protocol CA' \
  -addext 'basicConstraints=critical,CA:TRUE' \
  -addext 'keyUsage=critical,keyCertSign,cRLSign' \
  -keyout "$fixture_dir/ca.key" -out "$fixture_dir/ca.crt" >/dev/null 2>&1
openssl req -newkey rsa:2048 -nodes -subj '/CN=localhost' \
  -keyout "$fixture_dir/server.key" -out "$fixture_dir/server.csr" >/dev/null 2>&1
printf '%s\n' 'subjectAltName=DNS:localhost,IP:127.0.0.1' \
  'extendedKeyUsage=serverAuth' 'basicConstraints=critical,CA:FALSE' >"$fixture_dir/server.ext"
openssl x509 -req -days 2 -in "$fixture_dir/server.csr" \
  -CA "$fixture_dir/ca.crt" -CAkey "$fixture_dir/ca.key" -CAcreateserial \
  -extfile "$fixture_dir/server.ext" -out "$fixture_dir/server.crt" >/dev/null 2>&1
cp "$fixture_dir/server.crt" "$fixture_dir/postgres.crt"
cp "$fixture_dir/server.key" "$fixture_dir/postgres.key"
printf '%s' normal >"$fixture_dir/mode"
printf '%s' 0 >"$fixture_dir/delay"
touch "$fixture_dir/requests"
printf '%s' normal >"$fixture_dir/token_mode"
printf '%s' unused >"$fixture_dir/nonce"
printf '%s' unused >"$fixture_dir/pkce_challenge"
printf '%s' fixture-subject >"$fixture_dir/subject"
: >"$fixture_dir/email"
openssl genpkey -algorithm RSA -pkeyopt rsa_keygen_bits:2048 -out "$fixture_dir/jwt.key" >/dev/null 2>&1
modulus_hex="$(openssl rsa -in "$fixture_dir/jwt.key" -noout -modulus | cut -d= -f2)"
modulus="$(python3 -c 'import base64,sys; print(base64.urlsafe_b64encode(bytes.fromhex(sys.argv[1])).rstrip(b"=").decode())' "$modulus_hex")"
printf '%s' "{\"keys\":[{\"kty\":\"RSA\",\"use\":\"sig\",\"alg\":\"RS256\",\"kid\":\"fixture\",\"n\":\"${modulus}\",\"e\":\"AQAB\"}]}" >"$fixture_dir/jwks.json"

issuer="https://localhost:${oidc_port}"
OIDC_CONTROL_DIR="$fixture_dir" OIDC_ISSUER="$issuer" OIDC_PORT="$oidc_port" \
OIDC_CERT="$fixture_dir/server.crt" OIDC_KEY="$fixture_dir/server.key" \
python3 "$(dirname "$0")/server.py" &
server_pid="$!"

"$runtime" run --detach --name "$container" --publish "127.0.0.1:${database_port}:5432" \
  --env POSTGRES_DB=nuriteo --env POSTGRES_USER=nuriteo \
  --env POSTGRES_PASSWORD="$database_password" "$image" >/dev/null
for _ in $(seq 1 60); do
  "$runtime" exec "$container" pg_isready -U nuriteo -d nuriteo >/dev/null 2>&1 && break
  sleep 1
done
"$runtime" cp "$fixture_dir/postgres.crt" "$container:/var/lib/postgresql/server.crt"
"$runtime" cp "$fixture_dir/postgres.key" "$container:/var/lib/postgresql/server.key"
"$runtime" exec --user root "$container" chown postgres:postgres /var/lib/postgresql/server.crt /var/lib/postgresql/server.key
"$runtime" exec --user root "$container" chmod 600 /var/lib/postgresql/server.key
"$runtime" exec "$container" psql -v ON_ERROR_STOP=1 -U nuriteo -d nuriteo \
  -c "ALTER SYSTEM SET ssl = 'on'" \
  -c "ALTER SYSTEM SET ssl_cert_file = '/var/lib/postgresql/server.crt'" \
  -c "ALTER SYSTEM SET ssl_key_file = '/var/lib/postgresql/server.key'" >/dev/null
"$runtime" restart "$container" >/dev/null
for _ in $(seq 1 60); do
  "$runtime" exec "$container" pg_isready -U nuriteo -d nuriteo >/dev/null 2>&1 && break
  sleep 1
done
for _ in $(seq 1 60); do
  curl --silent --cacert "$fixture_dir/ca.crt" "$issuer/.well-known/openid-configuration" >/dev/null 2>&1 && break
  sleep 1
done

NURITEO_TEST_DATABASE_URL="postgres://nuriteo:${database_password}@localhost:${database_port}/nuriteo" \
NURITEO_TEST_DATABASE_CA="$fixture_dir/ca.crt" \
NURITEO_TEST_OIDC_ISSUER="$issuer" \
NURITEO_TEST_OIDC_CA="$fixture_dir/ca.crt" \
NURITEO_TEST_OIDC_CONTROL_DIR="$fixture_dir" \
cargo test -p nuriteo-server --lib \
  oidc::tests::actual_protocol_validation_is_pinned_bounded_and_generation_fenced \
  -- --ignored --exact --nocapture
printf '%s' "{\"keys\":[{\"kty\":\"RSA\",\"use\":\"sig\",\"alg\":\"RS256\",\"kid\":\"fixture\",\"n\":\"${modulus}\",\"e\":\"AQAB\"}]}" >"$fixture_dir/jwks.json"
printf '%s' normal >"$fixture_dir/mode"
printf '%s' normal >"$fixture_dir/token_mode"
NURITEO_TEST_DATABASE_URL="postgres://nuriteo:${database_password}@localhost:${database_port}/nuriteo" \
NURITEO_TEST_DATABASE_CA="$fixture_dir/ca.crt" \
NURITEO_TEST_OIDC_ISSUER="$issuer" \
NURITEO_TEST_OIDC_CA="$fixture_dir/ca.crt" \
NURITEO_TEST_OIDC_CONTROL_DIR="$fixture_dir" \
cargo test -p nuriteo-server --lib \
  oidc::tests::actual_authorization_code_pkce_is_one_time_and_rotation_fenced \
  -- --ignored --exact --nocapture
printf '%s' normal >"$fixture_dir/token_mode"
printf '%s' fixture-subject >"$fixture_dir/subject"
: >"$fixture_dir/email"
NURITEO_TEST_DATABASE_URL="postgres://nuriteo:${database_password}@localhost:${database_port}/nuriteo" \
NURITEO_TEST_DATABASE_CA="$fixture_dir/ca.crt" \
NURITEO_TEST_OIDC_ISSUER="$issuer" \
NURITEO_TEST_OIDC_CA="$fixture_dir/ca.crt" \
NURITEO_TEST_OIDC_CONTROL_DIR="$fixture_dir" \
cargo test -p nuriteo-server --lib \
  oidc::tests::actual_invited_identity_linking_is_provisioned_and_atomic \
  -- --ignored --exact --nocapture
