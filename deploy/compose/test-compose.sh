#!/usr/bin/env bash
set -Eeuo pipefail

repository_root="$(cd "$(dirname "${BASH_SOURCE[0]}")/../.." && pwd)"
compose_file="$repository_root/deploy/compose/compose.yaml"
project="nuriteo-cmp-003-${RANDOM}"
failure_project="${project}-failure"
fixture_root="$(mktemp -d "${TMPDIR:-/tmp}/nuriteo-cmp-003.XXXXXX")"
web_port="${NURITEO_COMPOSE_SMOKE_PORT:-19303}"
rendered="$fixture_root/compose.rendered.yaml"
bootstrap_password='compose-bootstrap-secret-7e3bc2f41a'
browser_state="$fixture_root/browser-state.json"

select_compose() {
  case "${NURITEO_COMPOSE_PROVIDER:-auto}" in
    docker) compose_command=(docker compose); engine=docker ;;
    podman) compose_command=(podman compose); engine=podman ;;
    uvx) compose_command=(uvx --from podman-compose==1.5.0 podman-compose --in-pod false); engine=podman ;;
    auto)
      if docker compose version >/dev/null 2>&1; then
        compose_command=(docker compose); engine=docker
      elif podman compose version >/dev/null 2>&1; then
        compose_command=(podman compose); engine=podman
      elif command -v podman-compose >/dev/null 2>&1; then
        compose_command=(podman-compose); engine=podman
      else
        echo "no Compose provider found" >&2
        exit 1
      fi
      ;;
    *) echo "unsupported NURITEO_COMPOSE_PROVIDER" >&2; exit 1 ;;
  esac
}

compose() { "${compose_command[@]}" --file "$compose_file" --project-name "$project" "$@"; }
failure_compose() { "${compose_command[@]}" --file "$compose_file" --project-name "$failure_project" "$@"; }

service_container() {
  local project_name="$1" service="$2" containers
  containers="$($engine ps --all \
    --filter "label=com.docker.compose.project=${project_name}" \
    --filter "label=com.docker.compose.service=${service}" \
    --format '{{.ID}}')"
  [ -n "$containers" ] || return 1
  if [[ "$containers" == *$'\n'* ]]; then
    echo "multiple containers found for ${project_name}/${service}" >&2
    return 1
  fi
  printf '%s\n' "$containers"
}

assert_service_not_running() {
  local project_name="$1" service="$2" containers running
  containers="$($engine ps --all \
    --filter "label=com.docker.compose.project=${project_name}" \
    --filter "label=com.docker.compose.service=${service}" \
    --format '{{.ID}}')"
  if [ -z "$containers" ]; then
    return 0
  fi
  if [[ "$containers" == *$'\n'* ]]; then
    echo "multiple containers found for ${project_name}/${service}" >&2
    return 1
  fi
  running="$($engine inspect --format '{{.State.Running}}' "$containers")"
  if [ "$running" = true ]; then
    echo "$service ran after failed one-shot" >&2
    return 1
  fi
}

remove_compatibility_web() {
  "$engine" rm --force "${project}-web-compat" >/dev/null 2>&1 || true
}

start_stack() {
  local core_container web_container web_status compatibility_web attempt job compose_status
  set +e
  compose_status=0
  compose up --detach --no-build || compose_status=$?
  set -e
  if [ "$compose_status" -eq 0 ]; then
    return 0
  fi

  # podman-compose 1.5.0 can return an internal dependency-start error after
  # Core becomes healthy. Recheck every one-shot before using the explicit
  # no-deps Web leaf path because this provider does not distinguish a stopped
  # dependency from one that completed successfully.
  [ "$engine" = podman ] || return 1
  for job in storage-init storage-check migrate bootstrap-admin; do
    wait_for_job "$job" 0
  done
  core_container="$(service_container "$project" core)"
  attempt=0
  until [ "$($engine inspect --format '{{.State.Health.Status}}' "$core_container")" = healthy ]; do
    attempt=$((attempt + 1)); [ "$attempt" -lt 60 ] || return 1; sleep 1
  done
  if web_container="$(service_container "$project" web)"; then
    web_status="$($engine inspect --format '{{.State.Status}}' "$web_container")"
    if [ "$web_status" = running ]; then
      return 0
    fi
    "$engine" rm --force "$web_container" >/dev/null
  fi
  compatibility_web="${project}-web-compat"
  remove_compatibility_web
  compose run --no-deps --detach --service-ports --name "$compatibility_web" web >/dev/null
}

cleanup() {
  if [ "${NURITEO_COMPOSE_KEEP:-0}" = 1 ]; then
    echo "preserving Compose projects: $project $failure_project" >&2
    return
  fi
  remove_compatibility_web
  compose down --volumes --remove-orphans >/dev/null 2>&1 || true
  failure_compose down --volumes --remove-orphans >/dev/null 2>&1 || true
  rm -rf -- "$fixture_root"
}

wait_for_web() {
  local attempt=0
  until curl --fail --silent "http://127.0.0.1:${web_port}/" >"$fixture_root/web.html"; do
    attempt=$((attempt + 1))
    if [ "$attempt" -ge 120 ]; then compose ps >&2 || true; return 1; fi
    sleep 1
  done
}

wait_for_job() {
  local service="$1" expected="$2" attempt=0 container status
  until container="$(service_container "$project" "$service")"; do
    attempt=$((attempt + 1)); [ "$attempt" -lt 120 ] || return 1; sleep 1
  done
  while :; do
    status="$($engine inspect --format '{{.State.Status}} {{.State.ExitCode}}' "$container")"
    case "$status" in
      "exited $expected") return 0 ;;
      exited\ *) echo "$service exited unexpectedly: $status" >&2; compose logs "$service" >&2; return 1 ;;
    esac
    attempt=$((attempt + 1)); [ "$attempt" -lt 120 ] || return 1; sleep 1
  done
}

query() {
  compose exec -T postgres psql --username nuriteo --dbname nuriteo --tuples-only --no-align --set ON_ERROR_STOP=1 --command "$1"
}

assert_no_bundled_cors() {
  compose exec -T rustfs /bin/sh -eu -c '
    access="$(cat /run/secrets/rustfs_access_key)"; secret="$(cat /run/secrets/rustfs_secret_key)"
    response="$(mktemp /tmp/nuriteo-cors-check.XXXXXX)"; trap '\''rm -f "$response"'\'' EXIT
    status="$(curl --silent --output "$response" --write-out "%{http_code}" \
      --cacert /etc/rustfs/tls/ca.crt --aws-sigv4 aws:amz:us-east-1:s3 \
      --user "${access}:${secret}" https://rustfs:9000/nuriteo?cors)"
    test "$status" = 404
    grep -q "<Code>NoSuchCORSConfiguration</Code>" "$response"
  '
}

install_exact_legacy_cors() {
  compose exec -T rustfs /bin/sh -eu -c '
    origin="$1"; access="$(cat /run/secrets/rustfs_access_key)"; secret="$(cat /run/secrets/rustfs_secret_key)"
    cors="$(mktemp /tmp/nuriteo-legacy-cors.XXXXXX)"; trap '\''rm -f "$cors"'\'' EXIT
    {
      printf "%s" "<CORSConfiguration><CORSRule><ID>nuriteo-browser-upload-v1</ID><AllowedOrigin>"
      printf "%s" "$origin"
      printf "%s" "</AllowedOrigin><AllowedMethod>PUT</AllowedMethod><AllowedHeader>content-type</AllowedHeader><AllowedHeader>x-amz-checksum-sha256</AllowedHeader><AllowedHeader>x-amz-sdk-checksum-algorithm</AllowedHeader><ExposeHeader>etag</ExposeHeader><ExposeHeader>x-amz-checksum-sha256</ExposeHeader><MaxAgeSeconds>300</MaxAgeSeconds></CORSRule></CORSConfiguration>"
    } >"$cors"
    status="$(curl --silent --output /dev/null --write-out "%{http_code}" \
      --cacert /etc/rustfs/tls/ca.crt --aws-sigv4 aws:amz:us-east-1:s3 \
      --user "${access}:${secret}" --header "Content-Type: application/xml" \
      --request PUT --data-binary "@$cors" https://rustfs:9000/nuriteo?cors)"
    test "$status" = 200
  ' _ "$NURITEO_EXTERNAL_URL"
}

install_drifted_legacy_cors() {
  compose exec -T rustfs /bin/sh -eu -c '
    origin="$1"; access="$(cat /run/secrets/rustfs_access_key)"; secret="$(cat /run/secrets/rustfs_secret_key)"
    cors="$(mktemp /tmp/nuriteo-drift-cors.XXXXXX)"; trap '\''rm -f "$cors"'\'' EXIT
    {
      printf "%s" "<CORSConfiguration><CORSRule><ID>nuriteo-browser-upload-v1</ID><AllowedOrigin>"
      printf "%s" "$origin"
      printf "%s" "</AllowedOrigin><AllowedMethod>PUT</AllowedMethod><AllowedMethod>GET</AllowedMethod><AllowedHeader>content-type</AllowedHeader><AllowedHeader>x-amz-checksum-sha256</AllowedHeader><AllowedHeader>x-amz-sdk-checksum-algorithm</AllowedHeader><ExposeHeader>etag</ExposeHeader><ExposeHeader>x-amz-checksum-sha256</ExposeHeader><MaxAgeSeconds>300</MaxAgeSeconds></CORSRule></CORSConfiguration>"
    } >"$cors"
    status="$(curl --silent --output /dev/null --write-out "%{http_code}" \
      --cacert /etc/rustfs/tls/ca.crt --aws-sigv4 aws:amz:us-east-1:s3 \
      --user "${access}:${secret}" --header "Content-Type: application/xml" \
      --request PUT --data-binary "@$cors" https://rustfs:9000/nuriteo?cors)"
    test "$status" = 200
  ' _ "$NURITEO_EXTERNAL_URL"
}

read_bundled_cors() {
  compose exec -T rustfs /bin/sh -eu -c '
    access="$(cat /run/secrets/rustfs_access_key)"; secret="$(cat /run/secrets/rustfs_secret_key)"
    curl --fail --silent --cacert /etc/rustfs/tls/ca.crt \
      --aws-sigv4 aws:amz:us-east-1:s3 --user "${access}:${secret}" \
      https://rustfs:9000/nuriteo?cors
  '
}

run_browser_phase() {
  local phase="$1" output secret status=0
  output="$fixture_root/browser-${phase}.log"
  NURITEO_COMPOSE_BROWSER_PHASE="$phase" \
    NURITEO_COMPOSE_EXTERNAL_URL="$NURITEO_EXTERNAL_URL" \
    NURITEO_COMPOSE_BROWSER_STATE_FILE="$browser_state" \
    NURITEO_COMPOSE_ADMIN_PASSWORD_FILE="$NURITEO_BOOTSTRAP_ADMIN_PASSWORD_FILE" \
    NURITEO_COMPOSE_INVITEE_PASSWORD_FILE="$fixture_root/invitee-password" \
    NURITEO_COMPOSE_STORAGE_ACCESS_KEY_FILE="$NURITEO_RUSTFS_ACCESS_KEY_FILE" \
    NURITEO_COMPOSE_STORAGE_SECRET_KEY_FILE="$NURITEO_RUSTFS_SECRET_KEY_FILE" \
    NURITEO_COMPOSE_PRIVATE_STORAGE_ENDPOINT='https://rustfs:9000' \
    node --experimental-strip-types "$repository_root/deploy/compose/relay-save-resume-browser.ts" \
      >"$output" 2>&1 || status=$?
  for secret in 'compose-db-password-7e3bc2' 'COMPOSEACCESS7E3BC2' \
    'compose-rustfs-secret-7e3bc2f41a' "$bootstrap_password" \
    "$invitee_password" "$preview_signing_key" "$save_idempotency_secret" \
    'nrt_inv_' 'nrt_org_inv_' 'X-Amz-'; do
    if grep -Fq -- "$secret" "$output"; then
      echo "compose browser output exposed a secret" >&2
      return 1
    fi
  done
  if [ "$status" -ne 0 ]; then
    grep -E '^compose bundled relay browser (save|resume) phase failed \([a-z-]+\)$' "$output" >&2 || \
      echo "compose browser ${phase} phase failed" >&2
    return 1
  fi
  grep -Fqx "compose bundled relay browser ${phase} phase passed" "$output"
}

select_compose
trap cleanup EXIT HUP INT TERM
trap 'status=$?; echo "compose acceptance failed at line ${BASH_LINENO[0]} (status ${status})" >&2' ERR

mkdir -p "$fixture_root/postgres-tls" "$fixture_root/rustfs-tls"
printf '%s\n' 'compose-db-password-7e3bc2' >"$fixture_root/postgres-password"
printf '%s\n' 'COMPOSEACCESS7E3BC2' >"$fixture_root/rustfs-access-key"
printf '%s\n' 'compose-rustfs-secret-7e3bc2f41a' >"$fixture_root/rustfs-secret-key"
printf '%s\n' "$bootstrap_password" >"$fixture_root/bootstrap-password"
printf '%s\n' 'compose-invitee-secret-7e3bc2f41a' >"$fixture_root/invitee-password"
printf '%s\n' 'postgres://nuriteo:compose-db-password-7e3bc2@postgres:5432/nuriteo' >"$fixture_root/database-url"
openssl rand -base64 32 | tr '+/' '-_' | tr -d '=\n' >"$fixture_root/preview-signing-key"
openssl rand -base64 32 >"$fixture_root/save-idempotency-secret"
openssl rand -base64 32 >"$fixture_root/master-key"
chmod 644 "$fixture_root/postgres-password" "$fixture_root/rustfs-access-key" \
  "$fixture_root/rustfs-secret-key" "$fixture_root/bootstrap-password" "$fixture_root/database-url"
chmod 600 "$fixture_root/invitee-password"
# Docker Compose local file secrets preserve source readability. Core/Web run as uid 65532,
# while the mode-0700 fixture root keeps these disposable values private from other host users.
chmod 644 "$fixture_root/preview-signing-key"
chmod 644 "$fixture_root/save-idempotency-secret"
chmod 644 "$fixture_root/master-key"

openssl req -x509 -newkey rsa:2048 -nodes -keyout "$fixture_root/postgres-tls/ca.key" \
  -out "$fixture_root/postgres-tls/ca.crt" -days 2 -subj '/CN=nuriteo-compose-postgres-ca' \
  -addext 'basicConstraints=critical,CA:TRUE' -addext 'keyUsage=critical,keyCertSign,cRLSign' >/dev/null 2>&1
openssl req -newkey rsa:2048 -nodes -keyout "$fixture_root/postgres-tls/server.key" \
  -out "$fixture_root/postgres-tls/server.csr" -subj '/CN=postgres' >/dev/null 2>&1
printf '%s\n' 'subjectAltName=DNS:postgres' 'basicConstraints=critical,CA:FALSE' \
  'keyUsage=critical,digitalSignature,keyEncipherment' 'extendedKeyUsage=serverAuth' >"$fixture_root/postgres-tls/server.ext"
openssl x509 -req -in "$fixture_root/postgres-tls/server.csr" -CA "$fixture_root/postgres-tls/ca.crt" \
  -CAkey "$fixture_root/postgres-tls/ca.key" -CAcreateserial -out "$fixture_root/postgres-tls/server.crt" \
  -days 2 -extfile "$fixture_root/postgres-tls/server.ext" >/dev/null 2>&1

openssl req -x509 -newkey rsa:2048 -nodes -keyout "$fixture_root/rustfs-ca.key" \
  -out "$fixture_root/rustfs-tls/ca.crt" -days 2 -subj '/CN=nuriteo-compose-rustfs-ca' \
  -addext 'basicConstraints=critical,CA:TRUE' -addext 'keyUsage=critical,keyCertSign,cRLSign' >/dev/null 2>&1
openssl req -newkey rsa:2048 -nodes -keyout "$fixture_root/rustfs-tls/rustfs_key.pem" \
  -out "$fixture_root/rustfs-server.csr" -subj '/CN=rustfs' >/dev/null 2>&1
printf '%s\n' 'subjectAltName=DNS:rustfs' 'basicConstraints=critical,CA:FALSE' \
  'keyUsage=critical,digitalSignature,keyEncipherment' 'extendedKeyUsage=serverAuth' >"$fixture_root/rustfs-server.ext"
openssl x509 -req -in "$fixture_root/rustfs-server.csr" -CA "$fixture_root/rustfs-tls/ca.crt" \
  -CAkey "$fixture_root/rustfs-ca.key" -CAcreateserial -out "$fixture_root/rustfs-tls/rustfs_cert.pem" \
  -days 2 -extfile "$fixture_root/rustfs-server.ext" >/dev/null 2>&1
chmod 600 "$fixture_root/postgres-tls/server.key"
# RustFS runs as uid 10001 and reads this bind-mounted disposable key directly.
# The fixture root remains mode 0700, so this does not expose the key outside the fixture owner.
chmod 644 "$fixture_root/rustfs-tls/rustfs_key.pem"

export NURITEO_POSTGRES_PASSWORD_FILE="$fixture_root/postgres-password"
export NURITEO_POSTGRES_SERVER_CERT_FILE="$fixture_root/postgres-tls/server.crt"
export NURITEO_POSTGRES_SERVER_KEY_FILE="$fixture_root/postgres-tls/server.key"
export NURITEO_DATABASE_URL_FILE="$fixture_root/database-url"
export NURITEO_DATABASE_CA_FILE="$fixture_root/postgres-tls/ca.crt"
export NURITEO_RUSTFS_ACCESS_KEY_FILE="$fixture_root/rustfs-access-key"
export NURITEO_RUSTFS_SECRET_KEY_FILE="$fixture_root/rustfs-secret-key"
export NURITEO_RUSTFS_CA_FILE="$fixture_root/rustfs-tls/ca.crt"
export NURITEO_RUSTFS_TLS_DIR="$fixture_root/rustfs-tls"
export NURITEO_BOOTSTRAP_ADMIN_PASSWORD_FILE="$fixture_root/bootstrap-password"
export NURITEO_PREVIEW_SIGNING_KEY_FILE="$fixture_root/preview-signing-key"
export NURITEO_SAVE_IDEMPOTENCY_SECRET_FILE="$fixture_root/save-idempotency-secret"
export NURITEO_MASTER_KEY_FILE="$fixture_root/master-key"
export NURITEO_MASTER_KEY_VERSION=1
export NURITEO_SAVE_DEFAULT_QUOTA_BYTES='10737418240'
export NURITEO_BOOTSTRAP_ADMIN_EMAIL='admin@example.invalid'
export NURITEO_BOOTSTRAP_ADMIN_NAME='Compose Administrator'
export NURITEO_EXTERNAL_URL="http://127.0.0.1:${web_port}"
export NURITEO_PREVIEW_BASE_DOMAIN='preview.localhost'
export NURITEO_PREVIEW_WILDCARD_READY='true'
export NURITEO_WEB_PORT="$web_port"
export NURITEO_POSTGRES_IMAGE="${NURITEO_POSTGRES_IMAGE:-localhost/nuriteo-postgres:cmp-003}"
export NURITEO_SERVER_IMAGE="${NURITEO_SERVER_IMAGE:-localhost/nuriteo-server:cmp-003}"
export NURITEO_WEB_IMAGE="${NURITEO_WEB_IMAGE:-localhost/nuriteo-web:cmp-003}"

compose config >"$rendered"
preview_signing_key="$(cat "$fixture_root/preview-signing-key")"
save_idempotency_secret="$(cat "$fixture_root/save-idempotency-secret")"
master_key="$(cat "$fixture_root/master-key")"
invitee_password="$(cat "$fixture_root/invitee-password")"
for secret in 'compose-db-password-7e3bc2' 'COMPOSEACCESS7E3BC2' 'compose-rustfs-secret-7e3bc2f41a' "$bootstrap_password" "$preview_signing_key" "$save_idempotency_secret" "$master_key"; do
  if grep -Fq -- "$secret" "$rendered"; then echo "rendered Compose exposed a secret" >&2; exit 1; fi
done

if [ "${NURITEO_COMPOSE_SKIP_APP_BUILD:-0}" = 1 ]; then
  compose build postgres
else
  compose build postgres core web
fi
start_stack
for job in storage-init storage-check migrate bootstrap-admin; do wait_for_job "$job" 0; done
wait_for_web
grep -q '<title>NURITEO</title>' "$fixture_root/web.html"
assert_no_bundled_cors
web_container="$(service_container "$project" web)"
"$engine" exec "$web_container" /nodejs/bin/node -e '
  Promise.all(["live", "ready"].map((kind) => fetch(`http://core:8080/health/${kind}`)))
    .then(async ([live, ready]) => {
      const liveBody = await live.json(); const readyBody = await ready.json();
      if (live.status !== 200 || liveBody.status !== "live" || ready.status !== 200 || readyBody.status !== "ready") process.exit(1);
    }).catch(() => process.exit(1));
'
test "$(query "SELECT COUNT(*) FROM users WHERE is_instance_admin;")" = '1'
test "$(query "SELECT COUNT(*) FROM local_password_credentials;")" = '1'
test "$(query "SELECT COUNT(*) FROM audit_events WHERE action_code = 'instance_admin.bootstrap_created';")" = '1'
test "$(query "SELECT COUNT(*) FROM _sqlx_migrations WHERE success;")" = "$(query "SELECT COUNT(*) FROM _sqlx_migrations;")"
run_browser_phase save
test "$(query "SELECT COUNT(*) FROM bundles;")" = '1'
test "$(query "SELECT COUNT(*) FROM projects WHERE working_head_bundle_id IS NOT NULL;")" = '1'
install_exact_legacy_cors

query "CREATE TABLE compose_sentinel (value text PRIMARY KEY); INSERT INTO compose_sentinel VALUES ('metadata-survived');" >/dev/null
compose exec -T rustfs /bin/sh -eu -c '
  access="$(cat /run/secrets/rustfs_access_key)"; secret="$(cat /run/secrets/rustfs_secret_key)"
  status="$(curl --silent --output /dev/null --write-out "%{http_code}" --cacert /etc/rustfs/tls/ca.crt \
    --aws-sigv4 aws:amz:us-east-1:s3 --user "${access}:${secret}" --request PUT \
    --header "Content-Length: 15" --data-binary object-survived https://rustfs:9000/nuriteo/sentinel.txt)"
  test "$status" = 200
'

remove_compatibility_web
compose down
start_stack
for job in storage-init storage-check migrate bootstrap-admin; do wait_for_job "$job" 0; done
wait_for_web
assert_no_bundled_cors
run_browser_phase resume
test "$(query 'SELECT value FROM compose_sentinel;')" = 'metadata-survived'
test "$(query "SELECT COUNT(*) FROM users WHERE is_instance_admin;")" = '1'
test "$(query "SELECT COUNT(*) FROM audit_events WHERE action_code = 'instance_admin.bootstrap_created';")" = '1'
compose logs bootstrap-admin | grep -q 'bootstrap-admin already-initialized'
object="$(compose exec -T rustfs /bin/sh -eu -c '
  access="$(cat /run/secrets/rustfs_access_key)"; secret="$(cat /run/secrets/rustfs_secret_key)"
  curl --fail --silent --cacert /etc/rustfs/tls/ca.crt --aws-sigv4 aws:amz:us-east-1:s3 \
    --user "${access}:${secret}" https://rustfs:9000/nuriteo/sentinel.txt
')"
test "$object" = 'object-survived'
for secret in 'compose-db-password-7e3bc2' 'COMPOSEACCESS7E3BC2' \
  'compose-rustfs-secret-7e3bc2f41a' "$bootstrap_password" \
  "$invitee_password" "$preview_signing_key" "$save_idempotency_secret" \
  'nrt_inv_' 'nrt_org_inv_' 'X-Amz-'; do
  if compose logs 2>&1 | grep -Fq -- "$secret"; then echo "logs exposed a secret" >&2; exit 1; fi
done

# A non-exact operator policy is never treated as the legacy bundled rule. The
# one-shot must fail closed before Core/Web start, and the policy bytes must be
# unchanged so an operator can resolve the drift deliberately.
install_drifted_legacy_cors
read_bundled_cors >"$fixture_root/drift-cors-before.xml"
remove_compatibility_web
compose down
if [ "$engine" = podman ]; then
  compose up --detach --no-build storage-init >"$fixture_root/drift-up.log" 2>&1 || true
else
  compose up --detach --no-build >"$fixture_root/drift-up.log" 2>&1 || true
fi
wait_for_job storage-init 1
compose logs storage-init 2>&1 | grep -q 'storage-init failed (legacy-cors-drift)'
for service in core web; do assert_service_not_running "$project" "$service" || exit $?; done
read_bundled_cors >"$fixture_root/drift-cors-after.xml"
cmp "$fixture_root/drift-cors-before.xml" "$fixture_root/drift-cors-after.xml"

printf '\n' >"$fixture_root/bootstrap-password"
export NURITEO_WEB_PORT="$((web_port + 1))"
if [ "$engine" = podman ]; then
  # podman-compose 1.5.0 does not enforce completed-successfully when a full
  # graph is requested. Exercise the failing one-shot and its prerequisites,
  # then prove the leaf containers were never created. Docker qualification
  # uses the native full graph below with no compatibility fallback.
  failure_compose up --detach --no-build bootstrap-admin || true
else
  failure_compose up --detach --no-build || true
fi
attempt=0
while :; do
  container="$(service_container "$failure_project" bootstrap-admin 2>/dev/null || true)"
  if [ -n "$container" ]; then
    state="$($engine inspect --format '{{.State.Status}} {{.State.ExitCode}}' "$container")"
    case "$state" in exited\ 0) echo 'failure bootstrap unexpectedly succeeded' >&2; exit 1 ;; exited\ *) break ;; esac
  fi
  attempt=$((attempt + 1)); [ "$attempt" -lt 120 ] || { echo 'failure bootstrap timed out' >&2; exit 1; }; sleep 1
done
failure_compose logs bootstrap-admin 2>&1 | grep -q 'bootstrap-admin failed (input)'
for service in core web; do assert_service_not_running "$failure_project" "$service" || exit $?; done

if [ "$engine" = podman ]; then
  echo 'compose relay acceptance ok (clean install, invite, organization workspace, isolated preview, save, restart, fresh-context resume, persistence, targeted drifted-CORS and failed-one-shot rejection (provider compatibility))'
else
  echo 'compose relay acceptance ok (clean install, invite, organization workspace, isolated preview, save, restart, fresh-context resume, persistence, drifted CORS and failed-one-shot dependency gates)'
fi
