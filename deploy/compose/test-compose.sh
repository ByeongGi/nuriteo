#!/usr/bin/env bash
set -Eeuo pipefail

repository_root="$(cd "$(dirname "${BASH_SOURCE[0]}")/../.." && pwd)"
compose_file="$repository_root/deploy/compose/compose.yaml"
project="nuriteo-cmp-001-${RANDOM}"
fixture_root="$(mktemp -d "${TMPDIR:-/tmp}/nuriteo-cmp-001.XXXXXX")"
web_port="${NURITEO_COMPOSE_SMOKE_PORT:-19303}"
rendered="$fixture_root/compose.rendered.yaml"

select_compose() {
  case "${NURITEO_COMPOSE_PROVIDER:-auto}" in
    docker) compose_command=(docker compose) ;;
    podman) compose_command=(podman compose) ;;
    uvx) compose_command=(uvx --from podman-compose==1.5.0 podman-compose) ;;
    auto)
      if docker compose version >/dev/null 2>&1; then
        compose_command=(docker compose)
      elif podman compose version >/dev/null 2>&1; then
        compose_command=(podman compose)
      elif command -v podman-compose >/dev/null 2>&1; then
        compose_command=(podman-compose)
      else
        echo "no Compose provider found; set NURITEO_COMPOSE_PROVIDER=uvx for the isolated test provider" >&2
        exit 1
      fi
      ;;
    *) echo "unsupported NURITEO_COMPOSE_PROVIDER" >&2; exit 1 ;;
  esac
}

compose() {
  "${compose_command[@]}" --file "$compose_file" --project-name "$project" "$@"
}

cleanup() {
  compose down --volumes --remove-orphans >/dev/null 2>&1 || true
  rm -rf -- "$fixture_root"
}

select_compose
trap cleanup EXIT HUP INT TERM
trap 'status=$?; echo "compose smoke failed at line ${BASH_LINENO[0]} (status ${status})" >&2' ERR

mkdir -p "$fixture_root/postgres-tls" "$fixture_root/rustfs-tls"
printf '%s\n' 'compose-db-password-7e3bc2' >"$fixture_root/postgres-password"
printf '%s\n' 'COMPOSEACCESS7E3BC2' >"$fixture_root/rustfs-access-key"
printf '%s\n' 'compose-rustfs-secret-7e3bc2f41a' >"$fixture_root/rustfs-secret-key"
printf '%s\n' \
  'postgres://nuriteo:compose-db-password-7e3bc2@postgres:5432/nuriteo' \
  >"$fixture_root/database-url"
chmod 644 "$fixture_root/postgres-password" "$fixture_root/rustfs-access-key" \
  "$fixture_root/rustfs-secret-key" "$fixture_root/database-url"

openssl req -x509 -newkey rsa:2048 -nodes \
  -keyout "$fixture_root/postgres-tls/ca.key" -out "$fixture_root/postgres-tls/ca.crt" -days 2 \
  -subj '/CN=nuriteo-cmp-001-postgres-ca' \
  -addext 'basicConstraints=critical,CA:TRUE' \
  -addext 'keyUsage=critical,keyCertSign,cRLSign' >/dev/null 2>&1
openssl req -newkey rsa:2048 -nodes \
  -keyout "$fixture_root/postgres-tls/server.key" -out "$fixture_root/postgres-tls/server.csr" \
  -subj '/CN=postgres' >/dev/null 2>&1
printf '%s\n' \
  'subjectAltName=DNS:postgres' \
  'basicConstraints=critical,CA:FALSE' \
  'keyUsage=critical,digitalSignature,keyEncipherment' \
  'extendedKeyUsage=serverAuth' >"$fixture_root/postgres-tls/server.ext"
openssl x509 -req -in "$fixture_root/postgres-tls/server.csr" \
  -CA "$fixture_root/postgres-tls/ca.crt" -CAkey "$fixture_root/postgres-tls/ca.key" -CAcreateserial \
  -out "$fixture_root/postgres-tls/server.crt" -days 2 \
  -extfile "$fixture_root/postgres-tls/server.ext" >/dev/null 2>&1
chmod 644 "$fixture_root/postgres-tls/ca.crt"

openssl req -x509 -newkey rsa:2048 -nodes \
  -keyout "$fixture_root/ca.key" -out "$fixture_root/rustfs-tls/ca.crt" -days 2 \
  -subj '/CN=nuriteo-cmp-001-test-ca' \
  -addext 'basicConstraints=critical,CA:TRUE' \
  -addext 'keyUsage=critical,keyCertSign,cRLSign' >/dev/null 2>&1
openssl req -newkey rsa:2048 -nodes \
  -keyout "$fixture_root/rustfs-tls/rustfs_key.pem" -out "$fixture_root/server.csr" \
  -subj '/CN=rustfs' >/dev/null 2>&1
printf '%s\n' \
  'subjectAltName=DNS:rustfs' \
  'basicConstraints=critical,CA:FALSE' \
  'keyUsage=critical,digitalSignature,keyEncipherment' \
  'extendedKeyUsage=serverAuth' >"$fixture_root/server.ext"
openssl x509 -req -in "$fixture_root/server.csr" \
  -CA "$fixture_root/rustfs-tls/ca.crt" -CAkey "$fixture_root/ca.key" -CAcreateserial \
  -out "$fixture_root/rustfs-tls/rustfs_cert.pem" -days 2 -extfile "$fixture_root/server.ext" \
  >/dev/null 2>&1
chmod 600 "$fixture_root/rustfs-tls/rustfs_key.pem"

export NURITEO_POSTGRES_PASSWORD_FILE="$fixture_root/postgres-password"
export NURITEO_DATABASE_URL_FILE="$fixture_root/database-url"
export NURITEO_DATABASE_CA_FILE="$fixture_root/postgres-tls/ca.crt"
export NURITEO_RUSTFS_ACCESS_KEY_FILE="$fixture_root/rustfs-access-key"
export NURITEO_RUSTFS_SECRET_KEY_FILE="$fixture_root/rustfs-secret-key"
export NURITEO_RUSTFS_CA_FILE="$fixture_root/rustfs-tls/ca.crt"
export NURITEO_RUSTFS_TLS_DIR="$fixture_root/rustfs-tls"
export NURITEO_EXTERNAL_URL="http://127.0.0.1:${web_port}"
export NURITEO_WEB_PORT="$web_port"
export NURITEO_SERVER_IMAGE="localhost/nuriteo-server:cmp-001"
export NURITEO_WEB_IMAGE="localhost/nuriteo-web:cmp-001"

compose config >"$rendered"
if grep -Fq 'compose-db-password-7e3bc2' "$rendered" || \
  grep -Fq 'COMPOSEACCESS7E3BC2' "$rendered" || \
  grep -Fq 'compose-rustfs-secret-7e3bc2f41a' "$rendered"; then
  echo "rendered Compose configuration exposed a credential" >&2
  exit 1
fi

compose build core web
compose up --no-start --no-build core
compose up --detach postgres rustfs web

attempt=0
until compose exec -T postgres pg_isready --username nuriteo --dbname nuriteo >/dev/null 2>&1; do
  attempt=$((attempt + 1))
  if [ "$attempt" -ge 60 ]; then
    compose ps >&2 || true
    echo "PostgreSQL readiness timed out" >&2
    exit 1
  fi
  sleep 1
done

compose exec -T --user root postgres /bin/sh -c \
  'umask 077; cat > /var/lib/postgresql/server.crt' \
  <"$fixture_root/postgres-tls/server.crt"
compose exec -T --user root postgres /bin/sh -c \
  'umask 077; cat > /var/lib/postgresql/server.key' \
  <"$fixture_root/postgres-tls/server.key"
compose exec -T --user root postgres chown postgres:postgres \
  /var/lib/postgresql/server.crt /var/lib/postgresql/server.key
compose exec -T --user root postgres chmod 600 /var/lib/postgresql/server.key
compose exec -T postgres psql --username nuriteo --dbname nuriteo --set ON_ERROR_STOP=1 \
  --command "ALTER SYSTEM SET ssl = 'on'" \
  --command "ALTER SYSTEM SET ssl_cert_file = '/var/lib/postgresql/server.crt'" \
  --command "ALTER SYSTEM SET ssl_key_file = '/var/lib/postgresql/server.key'" >/dev/null
compose restart postgres
attempt=0
until compose exec -T postgres pg_isready --username nuriteo --dbname nuriteo >/dev/null 2>&1; do
  attempt=$((attempt + 1))
  if [ "$attempt" -ge 60 ]; then
    compose ps >&2 || true
    echo "TLS PostgreSQL restart timed out" >&2
    exit 1
  fi
  sleep 1
done

attempt=0
until compose exec -T rustfs curl --fail --silent --cacert /etc/rustfs/tls/ca.crt \
  https://rustfs:9000/health >/dev/null 2>&1; do
  attempt=$((attempt + 1))
  if [ "$attempt" -ge 60 ]; then
    compose ps >&2 || true
    echo "RustFS readiness timed out" >&2
    exit 1
  fi
  sleep 1
done

attempt=0
until curl --fail --silent "http://127.0.0.1:${web_port}/" >"$fixture_root/web.html"; do
  attempt=$((attempt + 1))
  if [ "$attempt" -ge 60 ]; then
    compose ps >&2 || true
    echo "Web readiness timed out" >&2
    exit 1
  fi
  sleep 1
done
grep -q 'Web shell running' "$fixture_root/web.html"
css_path="$(grep -Eo '/_next/static/css/[^" ]+\.css' "$fixture_root/web.html" | sed -n '1p')"
test -n "$css_path"
test "$(curl --silent --output /dev/null --write-out '%{http_code}' "http://127.0.0.1:${web_port}${css_path}")" = "200"

compose exec -T postgres psql --username nuriteo --dbname nuriteo --set ON_ERROR_STOP=1 \
  --command 'CREATE TABLE compose_sentinel (value text PRIMARY KEY);' >/dev/null
compose exec -T postgres psql --username nuriteo --dbname nuriteo --set ON_ERROR_STOP=1 \
  --command "INSERT INTO compose_sentinel VALUES ('metadata-survived');" >/dev/null

compose exec -T rustfs /bin/sh -eu -c '
  access="$(cat /run/secrets/rustfs_access_key)"
  secret="$(cat /run/secrets/rustfs_secret_key)"
  auth="${access}:${secret}"
  bucket_status="$(curl --silent --output /dev/null --write-out "%{http_code}" \
    --cacert /etc/rustfs/tls/ca.crt \
    --aws-sigv4 aws:amz:us-east-1:s3 --user "$auth" \
    --request PUT https://rustfs:9000/nuriteo)"
  test "$bucket_status" = "200" || {
    echo "RustFS bucket create returned HTTP ${bucket_status}" >&2
    exit 1
  }
  object_status="$(curl --silent --output /dev/null \
    --write-out "%{http_code}" --cacert /etc/rustfs/tls/ca.crt \
    --aws-sigv4 aws:amz:us-east-1:s3 --user "$auth" \
    --request PUT --header "Content-Length: 15" --data-binary object-survived \
    https://rustfs:9000/nuriteo/sentinel.txt)"
  test "$object_status" = "200" || {
    echo "RustFS object put returned HTTP ${object_status}" >&2
    exit 1
  }
'

compose start core
attempt=0
until compose exec -T web /nodejs/bin/node -e '
  fetch("http://core:8080/health/live")
    .then(async (response) => {
      const body = await response.text();
      if (response.status !== 200 || body !== "{\"status\":\"live\"}") process.exit(1);
    })
    .catch(() => process.exit(1));
'; do
  attempt=$((attempt + 1))
  if [ "$attempt" -ge 60 ]; then
    compose ps >&2 || true
    compose logs core 2>&1 | sed -n '/nuriteo-server: serve failed (/p' >&2 || true
    echo "Core liveness timed out" >&2
    exit 1
  fi
  sleep 1
done
compose exec -T web /nodejs/bin/node -e '
  fetch("http://core:8080/health/ready")
    .then(async (response) => {
      const body = await response.json();
      if (
        response.status !== 503 ||
        body.status !== "unavailable" ||
        body.category !== "schema-pending" ||
        Object.keys(body).length !== 2
      ) process.exit(1);
    })
    .catch(() => process.exit(1));
'

compose stop core web rustfs postgres
compose start postgres rustfs web

attempt=0
until compose exec -T postgres pg_isready --username nuriteo --dbname nuriteo >/dev/null 2>&1; do
  attempt=$((attempt + 1))
  if [ "$attempt" -ge 60 ]; then
    compose ps >&2 || true
    echo "PostgreSQL restart timed out" >&2
    exit 1
  fi
  sleep 1
done

attempt=0
until compose exec -T rustfs curl --fail --silent --cacert /etc/rustfs/tls/ca.crt \
  https://rustfs:9000/health >/dev/null 2>&1; do
  attempt=$((attempt + 1))
  if [ "$attempt" -ge 60 ]; then
    compose ps >&2 || true
    echo "RustFS restart timed out" >&2
    exit 1
  fi
  sleep 1
done

metadata="$(compose exec -T postgres psql --username nuriteo --dbname nuriteo \
  --tuples-only --no-align --command 'SELECT value FROM compose_sentinel;')"
test "$metadata" = "metadata-survived"

object="$(compose exec -T rustfs /bin/sh -eu -c '
  access="$(cat /run/secrets/rustfs_access_key)"
  secret="$(cat /run/secrets/rustfs_secret_key)"
  curl --fail --silent --cacert /etc/rustfs/tls/ca.crt \
    --aws-sigv4 aws:amz:us-east-1:s3 --user "${access}:${secret}" \
    https://rustfs:9000/nuriteo/sentinel.txt
')"
test "$object" = "object-survived"

curl --fail --silent "http://127.0.0.1:${web_port}/" >/dev/null
compose start core
attempt=0
until compose exec -T web /nodejs/bin/node -e '
  fetch("http://core:8080/health/live")
    .then((response) => process.exit(response.status === 200 ? 0 : 1))
    .catch(() => process.exit(1));
'; do
  attempt=$((attempt + 1))
  if [ "$attempt" -ge 60 ]; then
    compose ps >&2 || true
    compose logs core 2>&1 | sed -n '/nuriteo-server: serve failed (/p' >&2 || true
    echo "Core restart liveness timed out" >&2
    exit 1
  fi
  sleep 1
done
compose exec -T web /nodejs/bin/node -e '
  fetch("http://core:8080/health/ready")
    .then(async (response) => {
      const body = await response.json();
      process.exit(
        response.status === 503 && body.category === "schema-pending" ? 0 : 1
      );
    })
    .catch(() => process.exit(1));
'

echo "compose smoke ok (Web/Core DNS, expected pending readiness, persistence across stop/start)"
