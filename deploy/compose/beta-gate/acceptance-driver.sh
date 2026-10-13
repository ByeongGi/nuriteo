#!/usr/bin/env bash
set -Eeuo pipefail
umask 077

readonly here="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
readonly repository_root="$(cd "$here/../../.." && pwd)"
readonly compose_file="$repository_root/deploy/compose/compose.yaml"
readonly provider_file="$here/compose.providers.yaml"
readonly report_file="${NURITEO_BETA_GATE_REPORT_FILE:?NURITEO_BETA_GATE_REPORT_FILE is required}"
readonly release_commit="${NURITEO_BETA_GATE_RELEASE_COMMIT:?NURITEO_BETA_GATE_RELEASE_COMMIT is required}"
readonly run_root="$(mktemp -d "${TMPDIR:-/tmp}/nuriteo-gate-005-driver.XXXXXX")"
readonly project="nuriteo-gate-005-$(openssl rand -hex 5)"
readonly web_port="${NURITEO_BETA_GATE_WEB_PORT:-19405}"
readonly postgres_port="${NURITEO_BETA_GATE_POSTGRES_PORT:-55495}"
readonly rustfs_port="${NURITEO_BETA_GATE_RUSTFS_PORT:-59495}"
readonly oidc_port="${NURITEO_BETA_GATE_OIDC_PORT:-58496}"
readonly git_port="${NURITEO_BETA_GATE_GIT_PORT:-58497}"
readonly core_port="${NURITEO_BETA_GATE_CORE_PORT:-58498}"
readonly smtp_port="${NURITEO_BETA_GATE_SMTP_PORT:-58499}"
readonly registry_exact_port="${NURITEO_BETA_GATE_REGISTRY_EXACT_PORT:-58500}"
readonly registry_default_port="${NURITEO_BETA_GATE_REGISTRY_DEFAULT_PORT:-58501}"
readonly admin_password='gate-005-admin-ephemeral'
readonly invitee_password='gate-005-invitee-ephemeral'
declare -a compose_command
engine=''

cleanup() {
  if [ "${NURITEO_BETA_GATE_KEEP:-0}" = 1 ]; then
    echo "GATE-005 preserving project ${project} and ${run_root}" >&2
    return
  fi
  compose down --volumes --remove-orphans >/dev/null 2>&1 || true
  rm -rf -- "$run_root"
}
trap cleanup EXIT
interrupted() {
  local status="$1"
  trap - EXIT HUP INT TERM
  cleanup
  exit "$status"
}
trap 'interrupted 129' HUP
trap 'interrupted 130' INT
trap 'interrupted 143' TERM
trap 'status=$?; echo "GATE-005 actual driver failed at line ${BASH_LINENO[0]} (status ${status})" >&2' ERR

select_compose() {
  if command_succeeds_within docker compose version; then compose_command=(docker compose); engine=docker
  elif command -v uvx >/dev/null 2>&1 && command -v podman >/dev/null 2>&1; then
    compose_command=(uvx --from podman-compose==1.5.0 podman-compose --in-pod false); engine=podman
  elif command_succeeds_within podman compose version; then compose_command=(podman compose); engine=podman
  else echo 'GATE-005 requires Docker Compose or Podman Compose' >&2; exit 1; fi
  command_succeeds_within "$engine" info || {
    echo "GATE-005 ${engine} engine is unavailable or did not respond within 15 seconds" >&2
    exit 1
  }
}
command_succeeds_within() {
  python3 - "$@" <<'PY'
import subprocess
import sys

try:
    result = subprocess.run(
        sys.argv[1:],
        stdin=subprocess.DEVNULL,
        stdout=subprocess.DEVNULL,
        stderr=subprocess.DEVNULL,
        timeout=15,
        check=False,
    )
except (OSError, subprocess.TimeoutExpired):
    raise SystemExit(1)
raise SystemExit(result.returncode)
PY
}
compose() { "${compose_command[@]}" -f "$compose_file" -f "$provider_file" --project-name "$project" "$@"; }
collect_compose_logs() {
  local output="$1" service
  : >"$output"
  for service in postgres rustfs storage-init migrate storage-check bootstrap-admin core web \
    oidc-provider smtp-provider git-provider registry-exact-provider registry-default-provider; do
    {
      printf '===== %s =====\n' "$service"
      compose logs "$service"
    } >>"$output" 2>&1
  done
}
container() {
  "$engine" ps --all --quiet \
    --filter "label=com.docker.compose.project=$project" \
    --filter "label=com.docker.compose.service=$1" | head -n 1
}
query() { compose exec -T postgres psql -X --username nuriteo --dbname nuriteo --tuples-only --no-align --set ON_ERROR_STOP=1 --command "$1"; }
wait_job() {
  local service="$1" expected="${2:-0}" id state attempt=0
  until id="$(container "$service")" && [ -n "$id" ]; do attempt=$((attempt+1)); [ "$attempt" -lt 120 ]; sleep 1; done
  while :; do
    state="$($engine inspect --format '{{.State.Status}} {{.State.ExitCode}}' "$id")"
    [ "$state" = "exited $expected" ] && return
    [[ "$state" = exited\ * ]] && { compose logs "$service" >&2; return 1; }
    attempt=$((attempt+1)); [ "$attempt" -lt 180 ]; sleep 1
  done
}
wait_healthy() {
  local service="$1" id status attempt=0
  until id="$(container "$service")" && [ -n "$id" ]; do
    attempt=$((attempt+1)); [ "$attempt" -lt 120 ]; sleep 1
  done
  while :; do
    status="$($engine inspect --format '{{if .State.Health}}{{.State.Health.Status}}{{else}}{{.State.Status}}{{end}}' "$id")"
    [ "$status" = healthy ] && return
    [ "$status" = exited ] && { compose logs "$service" >&2; return 1; }
    attempt=$((attempt+1)); [ "$attempt" -lt 180 ] || { compose logs "$service" >&2; return 1; }; sleep 1
  done
}
wait_web() {
  local attempt=0
  until curl --fail --silent "http://127.0.0.1:${web_port}/" >/dev/null; do
    attempt=$((attempt+1)); [ "$attempt" -lt 180 ] || { compose ps >&2; return 1; }; sleep 1
  done
}
uuid() { python3 -c 'import uuid; print(uuid.uuid4())'; }
write_assertions() { printf '%s\n' "$2" >"$run_root/$1.assertions.json"; }
record() {
  local stage="$1"
  node "$here/record-evidence.mjs" "$stage" "$run_root/$stage.assertions.json" >"$run_root/stages/$stage.json"
}

select_compose
mkdir -p "$run_root/postgres-tls" "$run_root/rustfs-tls" "$run_root/provider-tls/control" "$run_root/provider-tls/git-root" "$run_root/stages"
mkdir -p "$run_root/git-registry"
chmod 0777 "$run_root/git-registry"
printf '%s\n' 'gate-005-db-ephemeral' >"$run_root/postgres-password"
printf '%s\n' 'integration-access' >"$run_root/rustfs-access-key"
printf '%s\n' 'integration-secret-0123456789' >"$run_root/rustfs-secret-key"
printf '%s\n' "$admin_password" >"$run_root/bootstrap-password"
printf '%s\n' "$invitee_password" >"$run_root/invitee-password"
printf '%s\n' 'postgres://nuriteo:gate-005-db-ephemeral@postgres:5432/nuriteo' >"$run_root/database-url"
openssl rand 32 | openssl base64 -A | tr '+/' '-_' | tr -d '=' >"$run_root/preview-signing-key"
printf '\n' >>"$run_root/preview-signing-key"
grep -Eq '^[A-Za-z0-9_-]{43}$' "$run_root/preview-signing-key"
openssl rand -base64 32 >"$run_root/save-idempotency-secret"
openssl rand -base64 32 >"$run_root/master-key"
openssl rand -hex 24 >"$run_root/provider-tls/control/git-token"
openssl rand -hex 24 >"$run_root/provider-tls/control/registry-exact-token"
openssl rand -hex 24 >"$run_root/provider-tls/control/registry-default-token"

openssl req -x509 -newkey rsa:2048 -nodes -days 2 -subj '/CN=GATE-005 PostgreSQL CA' \
  -keyout "$run_root/postgres-tls/ca.key" -out "$run_root/postgres-tls/ca.crt" >/dev/null 2>&1
openssl req -newkey rsa:2048 -nodes -subj '/CN=postgres' -keyout "$run_root/postgres-tls/server.key" \
  -out "$run_root/postgres-tls/server.csr" >/dev/null 2>&1
printf '%s\n' 'subjectAltName=DNS:postgres,DNS:localhost,IP:127.0.0.1' 'extendedKeyUsage=serverAuth' >"$run_root/postgres-tls/server.ext"
openssl x509 -req -days 2 -in "$run_root/postgres-tls/server.csr" -CA "$run_root/postgres-tls/ca.crt" \
  -CAkey "$run_root/postgres-tls/ca.key" -CAcreateserial -extfile "$run_root/postgres-tls/server.ext" \
  -out "$run_root/postgres-tls/server.crt" >/dev/null 2>&1
openssl req -x509 -newkey rsa:2048 -nodes -days 2 -subj '/CN=GATE-005 RustFS CA' \
  -keyout "$run_root/rustfs-ca.key" -out "$run_root/rustfs-tls/ca.crt" >/dev/null 2>&1
openssl req -newkey rsa:2048 -nodes -subj '/CN=rustfs' -keyout "$run_root/rustfs-tls/rustfs_key.pem" \
  -out "$run_root/rustfs.csr" >/dev/null 2>&1
printf '%s\n' 'subjectAltName=DNS:rustfs,DNS:localhost,IP:127.0.0.1' 'extendedKeyUsage=serverAuth' >"$run_root/rustfs.ext"
openssl x509 -req -days 2 -in "$run_root/rustfs.csr" -CA "$run_root/rustfs-tls/ca.crt" \
  -CAkey "$run_root/rustfs-ca.key" -CAcreateserial -extfile "$run_root/rustfs.ext" \
  -out "$run_root/rustfs-tls/rustfs_cert.pem" >/dev/null 2>&1
openssl req -x509 -newkey rsa:2048 -nodes -days 2 -subj '/CN=GATE-005 provider CA' \
  -addext 'basicConstraints=critical,CA:TRUE' -addext 'keyUsage=critical,keyCertSign,cRLSign' \
  -keyout "$run_root/provider-tls/ca.key" -out "$run_root/provider-tls/ca.crt" >/dev/null 2>&1
openssl req -newkey rsa:2048 -nodes -subj '/CN=localhost' -keyout "$run_root/provider-tls/tls.key" \
  -out "$run_root/provider-tls/tls.csr" >/dev/null 2>&1
printf '%s\n' 'subjectAltName=DNS:localhost,IP:127.0.0.1,DNS:oidc-provider,DNS:git-provider,DNS:smtp-provider,DNS:registry-exact-provider,DNS:registry-default-provider' \
  'basicConstraints=critical,CA:FALSE' 'extendedKeyUsage=serverAuth' >"$run_root/provider-tls/tls.ext"
openssl x509 -req -days 2 -in "$run_root/provider-tls/tls.csr" -CA "$run_root/provider-tls/ca.crt" \
  -CAkey "$run_root/provider-tls/ca.key" -CAcreateserial -extfile "$run_root/provider-tls/tls.ext" \
  -out "$run_root/provider-tls/tls.crt" >/dev/null 2>&1
NURITEO_BETA_GATE_PROVIDER_TLS_DIR="$run_root/provider-tls" \
  "$here/stages/oidc-notifications/prepare-provider.sh"
git init --bare "$run_root/provider-tls/git-root/repo.git" >/dev/null
git --git-dir="$run_root/provider-tls/git-root/repo.git" config http.receivepack true
git init "$run_root/git-work" >/dev/null; git -C "$run_root/git-work" config user.name 'GATE-005'; git -C "$run_root/git-work" config user.email 'gate@example.invalid'
printf 'initial\n' >"$run_root/git-work/README.md"; git -C "$run_root/git-work" add README.md; git -C "$run_root/git-work" commit -m initial >/dev/null
git -C "$run_root/git-work" branch -M main; git -C "$run_root/git-work" remote add origin "$run_root/provider-tls/git-root/repo.git"; git -C "$run_root/git-work" push origin main >/dev/null
printf '%s' '{"requests":0,"authorization":0}' >"$run_root/provider-tls/origin.json"; cp "$run_root/provider-tls/origin.json" "$run_root/provider-tls/sink.json"
chmod 644 "$run_root"/*-password "$run_root"/*-key "$run_root/database-url" "$run_root/postgres-tls/server.key" \
  "$run_root/rustfs-tls/rustfs_key.pem" "$run_root/provider-tls/tls.key"

export NURITEO_POSTGRES_PASSWORD_FILE="$run_root/postgres-password"
export NURITEO_POSTGRES_SERVER_CERT_FILE="$run_root/postgres-tls/server.crt"
export NURITEO_POSTGRES_SERVER_KEY_FILE="$run_root/postgres-tls/server.key"
export NURITEO_DATABASE_URL_FILE="$run_root/database-url"
export NURITEO_DATABASE_CA_FILE="$run_root/postgres-tls/ca.crt"
export NURITEO_RUSTFS_ACCESS_KEY_FILE="$run_root/rustfs-access-key"
export NURITEO_RUSTFS_SECRET_KEY_FILE="$run_root/rustfs-secret-key"
export NURITEO_RUSTFS_CA_FILE="$run_root/rustfs-tls/ca.crt"
export NURITEO_RUSTFS_TLS_DIR="$run_root/rustfs-tls"
export NURITEO_BOOTSTRAP_ADMIN_PASSWORD_FILE="$run_root/bootstrap-password"
export NURITEO_PREVIEW_SIGNING_KEY_FILE="$run_root/preview-signing-key"
export NURITEO_SAVE_IDEMPOTENCY_SECRET_FILE="$run_root/save-idempotency-secret"
export NURITEO_MASTER_KEY_FILE="$run_root/master-key"
export NURITEO_MASTER_KEY_VERSION=1
export NURITEO_BOOTSTRAP_ADMIN_EMAIL='admin@example.invalid'
export NURITEO_BOOTSTRAP_ADMIN_NAME='GATE-005 Administrator'
export NURITEO_EXTERNAL_URL="http://127.0.0.1:${web_port}"
export NURITEO_PREVIEW_BASE_DOMAIN='preview.localhost'
export NURITEO_PREVIEW_WILDCARD_READY=true
export NURITEO_WEB_PORT="$web_port"
export NURITEO_POSTGRES_IMAGE="localhost/nuriteo-postgres:gate-005-${release_commit:0:12}"
export NURITEO_SERVER_IMAGE="localhost/nuriteo-server:gate-005-${release_commit:0:12}"
export NURITEO_WEB_IMAGE="localhost/nuriteo-web:gate-005-${release_commit:0:12}"
export NURITEO_BETA_GATE_POSTGRES_PORT="$postgres_port"
export NURITEO_BETA_GATE_RUSTFS_PORT="$rustfs_port"
export NURITEO_BETA_GATE_OIDC_PORT="$oidc_port"
export NURITEO_BETA_GATE_GIT_PORT="$git_port"
export NURITEO_BETA_GATE_CORE_PORT="$core_port"
export NURITEO_BETA_GATE_SMTP_PORT="$smtp_port"
export NURITEO_BETA_GATE_REGISTRY_EXACT_PORT="$registry_exact_port"
export NURITEO_BETA_GATE_REGISTRY_DEFAULT_PORT="$registry_default_port"
export NURITEO_BETA_GATE_PROVIDER_TLS_DIR="$run_root/provider-tls"
export NURITEO_BETA_GATE_HARNESS_DIR="$run_root/git-registry"

compose config >"$run_root/compose.rendered.yaml"
for secret in 'gate-005-db-ephemeral' 'integration-secret-0123456789' "$admin_password" "$invitee_password" \
  'integration-access' "$(cat "$run_root/preview-signing-key")" \
  "$(cat "$run_root/save-idempotency-secret")" "$(cat "$run_root/master-key")" \
  "$(cat "$run_root/provider-tls/control/git-token")" \
  "$(cat "$run_root/provider-tls/control/registry-exact-token")" "$(cat "$run_root/provider-tls/control/registry-default-token")"; do
  ! grep -Fq "$secret" "$run_root/compose.rendered.yaml"
done
for image_service in postgres core web oidc-provider; do
  compose build "$image_service" >>"$run_root/build.log" 2>&1
done
compose --profile gate-harness build gate-harness >>"$run_root/build.log" 2>&1
compose up --detach --no-build --no-deps postgres rustfs oidc-provider smtp-provider \
  git-provider registry-exact-provider registry-default-provider >"$run_root/up.log" 2>&1
wait_healthy postgres
wait_healthy rustfs
for job in storage-init migrate storage-check bootstrap-admin; do
  compose up --detach --no-build --no-deps "$job" >>"$run_root/up.log" 2>&1
  wait_job "$job"
done
compose up --detach --no-build --no-deps core >>"$run_root/up.log" 2>&1
wait_healthy core
compose up --detach --no-build --no-deps web >>"$run_root/up.log" 2>&1
wait_web
for provider in oidc-provider smtp-provider git-provider registry-exact-provider registry-default-provider; do
  test "$($engine inspect --format '{{.State.Running}}' "$(container "$provider")")" = true
done
curl --fail --silent --cacert "$run_root/provider-tls/ca.crt" "https://localhost:${oidc_port}/.well-known/openid-configuration" >/dev/null
curl --silent --output /dev/null --cacert "$run_root/provider-tls/ca.crt" "https://localhost:${git_port}/missing"
test "$($engine inspect --format '{{.State.Running}}' "$(container smtp-provider)")" = true
compose exec -T web /nodejs/bin/node -e '
  const tls=require("node:tls");const socket=tls.connect({host:"smtp-provider",port:8443,rejectUnauthorized:false},()=>socket.write("EHLO gate-005\r\n"));
  let transcript="";socket.on("data",chunk=>{transcript+=chunk;if(transcript.includes("250 AUTH PLAIN"))socket.end()});socket.on("close",()=>{if(!transcript.includes("220 gate-005")||!transcript.includes("250 AUTH PLAIN"))process.exit(1)});socket.on("error",()=>process.exit(1));
'

export NURITEO_BETA_GATE_COMPOSE_PROJECT="$project"
export NURITEO_BETA_GATE_DATABASE_LINEAGE="$(uuid)"
export NURITEO_BETA_GATE_OBJECT_LINEAGE="$(uuid)"
query "CREATE TABLE beta_gate_lineage(database_lineage uuid PRIMARY KEY, object_lineage uuid NOT NULL, release_commit text NOT NULL); INSERT INTO beta_gate_lineage VALUES ('$NURITEO_BETA_GATE_DATABASE_LINEAGE','$NURITEO_BETA_GATE_OBJECT_LINEAGE','$release_commit');" >/dev/null
compose exec -T rustfs /bin/sh -eu -c '
  access="$(cat /run/secrets/rustfs_access_key)"; secret="$(cat /run/secrets/rustfs_secret_key)"
  curl --fail --silent --output /dev/null --cacert /etc/rustfs/tls/ca.crt \
    --aws-sigv4 aws:amz:us-east-1:s3 --user "${access}:${secret}" --request PUT \
    --data-binary "$1" "https://rustfs:9000/nuriteo/beta-gate/$1"
' _ "$NURITEO_BETA_GATE_OBJECT_LINEAGE"

export NURITEO_COMPOSE_BROWSER_PHASE=save
export NURITEO_COMPOSE_EXTERNAL_URL="$NURITEO_EXTERNAL_URL"
export NURITEO_COMPOSE_BROWSER_STATE_FILE="$run_root/browser-state.json"
export NURITEO_COMPOSE_ADMIN_PASSWORD_FILE="$run_root/bootstrap-password"
export NURITEO_COMPOSE_INVITEE_PASSWORD_FILE="$run_root/invitee-password"
export NURITEO_COMPOSE_STORAGE_ACCESS_KEY_FILE="$run_root/rustfs-access-key"
export NURITEO_COMPOSE_STORAGE_SECRET_KEY_FILE="$run_root/rustfs-secret-key"
export NURITEO_COMPOSE_PRIVATE_STORAGE_ENDPOINT='https://rustfs:9000'
export NURITEO_COMPOSE_SMTP_CAPTURE_DIR="$run_root/provider-tls/control"
node --experimental-strip-types "$repository_root/deploy/compose/relay-save-resume-browser.ts" >"$run_root/browser-save.log" 2>&1

query "SELECT json_build_object('organizationId',o.id,'projectId',p.id,'userId',admin.id,'inviteeUserId',invitee.id) FROM organizations o JOIN projects p ON p.owner_organization_id=o.id JOIN users admin ON admin.email='admin@example.invalid' JOIN users invitee ON invitee.email='cmp003-invitee@example.invalid' ORDER BY p.created_at DESC LIMIT 1;" >"$run_root/context.json"
export NURITEO_BETA_GATE_ORIGIN="$NURITEO_EXTERNAL_URL"
export NURITEO_BETA_GATE_CORE_ORIGIN="http://127.0.0.1:${core_port}"
export NURITEO_BETA_GATE_ADMIN_PASSWORD_FILE="$run_root/bootstrap-password"
export NURITEO_BETA_GATE_INVITEE_PASSWORD_FILE="$run_root/invitee-password"
export NURITEO_BETA_GATE_CONTEXT_FILE="$run_root/context.json"
export NURITEO_BETA_GATE_JOURNEY_OUTPUT="$run_root/journey.json"
export NURITEO_BETA_GATE_POST_RESTART_TOKEN_FILE="$run_root/revoked-pat"
node --experimental-strip-types "$here/live-journey.ts" >"$run_root/beta-browser.log" 2>&1

export NURITEO_BETA_GATE_ENGINE="$engine"
export NURITEO_BETA_GATE_POSTGRES_CONTAINER="$(container postgres)"
export NURITEO_BETA_GATE_STAGE_WORK_DIR="$run_root/oidc-notifications"
export NURITEO_BETA_GATE_STAGE_ASSERTIONS="$run_root/oidc-notifications.journey.json"
"$here/stages/oidc-notifications/run.sh" >"$run_root/oidc-notifications.log" 2>&1

export NURITEO_GATE_STAGE_ROOT="$run_root/git-registry"
export NURITEO_GATE_ASSERTION_DIRECTORY="$run_root/git-registry-assertions"
export NURITEO_GATE_PROVIDER_CA_FILE="$run_root/provider-tls/ca.crt"
export NURITEO_GATE_GIT_HOST='git-provider'
export NURITEO_GATE_GIT_PORT=8443
export NURITEO_GATE_GIT_TOKEN="$(cat "$run_root/provider-tls/control/git-token")"
export NURITEO_GATE_GIT_REPOSITORY_URL='https://git-provider:8443/repo.git'
export NURITEO_GATE_GIT_CONTROL_URL="https://localhost:${git_port}"
export NURITEO_GATE_REGISTRY_EXACT_URL='https://registry-exact-provider:8443'
export NURITEO_GATE_REGISTRY_EXACT_TOKEN="$(cat "$run_root/provider-tls/control/registry-exact-token")"
export NURITEO_GATE_REGISTRY_EXACT_HOST='registry-exact-provider'
export NURITEO_GATE_REGISTRY_EXACT_PORT=8443
export NURITEO_GATE_REGISTRY_EXACT_CONTROL_URL="https://localhost:${registry_exact_port}"
export NURITEO_GATE_REGISTRY_DEFAULT_URL='https://registry-default-provider:8443'
export NURITEO_GATE_REGISTRY_DEFAULT_TOKEN="$(cat "$run_root/provider-tls/control/registry-default-token")"
export NURITEO_GATE_REGISTRY_DEFAULT_HOST='registry-default-provider'
export NURITEO_GATE_REGISTRY_DEFAULT_PORT=8443
export NURITEO_GATE_REGISTRY_DEFAULT_CONTROL_URL="https://localhost:${registry_default_port}"
"$here/stages/git-registry/run.sh" >"$run_root/git-registry.log" 2>&1

export NURITEO_BETA_GATE_STAGE_OUTPUT="$run_root/published-preview.journey.json"
"$here/stages/published-preview/run.sh" >"$run_root/published-preview.log" 2>&1
node - "$run_root/journey.json" "$NURITEO_BETA_GATE_STAGE_ASSERTIONS" \
  "$run_root/git-registry-assertions" "$NURITEO_BETA_GATE_STAGE_OUTPUT" <<'NODE'
const fs = require("node:fs");
const [journeyPath, oidcPath, gitRegistryDirectory, previewPath] = process.argv.slice(2);
const journey = JSON.parse(fs.readFileSync(journeyPath, "utf8"));
for (const source of [
  JSON.parse(fs.readFileSync(oidcPath, "utf8")),
  {
    "git-integration": JSON.parse(fs.readFileSync(`${gitRegistryDirectory}/git-integration.assertions.json`, "utf8")),
    "registry-integration": JSON.parse(fs.readFileSync(`${gitRegistryDirectory}/registry-integration.assertions.json`, "utf8")),
  },
  JSON.parse(fs.readFileSync(previewPath, "utf8")),
]) {
  for (const [name, assertions] of Object.entries(source)) {
    if (!Array.isArray(assertions) || assertions.length === 0) throw new Error(`${name} stage did not produce assertions`);
    journey[name] = assertions;
  }
}
fs.writeFileSync(journeyPath, `${JSON.stringify(journey, null, 2)}\n`, { mode: 0o600 });
NODE
node "$here/check-journey.mjs" "$run_root/journey.json"

collect_compose_logs "$run_root/compose-before-restart.log"
compose down
compose up --detach --no-build --no-deps postgres rustfs oidc-provider smtp-provider \
  git-provider registry-exact-provider registry-default-provider >"$run_root/restart.log" 2>&1
wait_healthy postgres
wait_healthy rustfs
for job in storage-init migrate storage-check bootstrap-admin; do
  compose up --detach --no-build --no-deps "$job" >>"$run_root/restart.log" 2>&1
  wait_job "$job"
done
compose up --detach --no-build --no-deps core >>"$run_root/restart.log" 2>&1
wait_healthy core
compose up --detach --no-build --no-deps web >>"$run_root/restart.log" 2>&1
wait_web
test "$(query "SELECT database_lineage::text FROM beta_gate_lineage;")" = "$NURITEO_BETA_GATE_DATABASE_LINEAGE"
object_after_restart="$(compose exec -T rustfs /bin/sh -eu -c '
  access="$(cat /run/secrets/rustfs_access_key)"; secret="$(cat /run/secrets/rustfs_secret_key)"
  curl --fail --silent --cacert /etc/rustfs/tls/ca.crt --aws-sigv4 aws:amz:us-east-1:s3 \
    --user "${access}:${secret}" "https://rustfs:9000/nuriteo/beta-gate/$1"
' _ "$NURITEO_BETA_GATE_OBJECT_LINEAGE")"
test "$object_after_restart" = "$NURITEO_BETA_GATE_OBJECT_LINEAGE"
export NURITEO_COMPOSE_BROWSER_PHASE=resume
node --experimental-strip-types "$repository_root/deploy/compose/relay-save-resume-browser.ts" >"$run_root/browser-resume.log" 2>&1

export NURITEO_GATE_GIT_REGISTRY_STATE="$run_root/git-registry/git-registry-state.json"
export NURITEO_GATE_OIDC_STATE_FILE="$run_root/oidc-notifications/oidc-state.json"
export NURITEO_BETA_GATE_POST_RESTART_OUTPUT="$run_root/same-volume-restart.assertions.json"
node --experimental-strip-types "$here/post-restart-journey.ts" >"$run_root/post-restart-browser.log" 2>&1
  compose --profile gate-harness run --rm --no-deps -T \
  -e 'NURITEO_GATE_HARNESS_COMMAND=registry-fetch' \
  -e 'NURITEO_GATE_REGISTRY_PACKAGE=@gate/exact' \
  -e 'NURITEO_GATE_REGISTRY_METADATA_FILE=/run/gate-state/registry-metadata-after-restart.json' \
  gate-harness >"$run_root/registry-after-restart.log" 2>&1
export NURITEO_BETA_GATE_STAGE_OUTPUT="$run_root/published-preview-after-restart.journey.json"
"$here/stages/published-preview/run.sh" >"$run_root/published-preview-after-restart.log" 2>&1
node - "$run_root/same-volume-restart.assertions.json" <<'NODE'
const fs = require("node:fs");
const file = process.argv[2];
const assertions = JSON.parse(fs.readFileSync(file, "utf8"));
assertions.unshift(
  { kind: "database", name: "database lineage sentinel and saved Project survived Compose down/up", status: "PASS" },
  { kind: "object", name: "saved Bundle resumed after the same-volume restart", status: "PASS" }
);
assertions.push(
  { kind: "process", name: "reactivated exact Registry fetched package metadata with the persisted encrypted credential after restart", status: "PASS" },
  { kind: "browser", name: "public metadata, content and isolated wildcard Preview remained functional after restart", status: "PASS" }
);
fs.writeFileSync(file, `${JSON.stringify(assertions)}\n`, { mode: 0o600 });
NODE

write_assertions clean-install '[{"kind":"container","name":"ordered clean-volume one-shots and healthy Core/Web completed","status":"PASS"}]'
write_assertions alpha-lineage '[{"kind":"database","name":"Alpha migrations, administrator, Project save, and object relay were exercised","status":"PASS"}]'
write_assertions local-user '[{"kind":"browser","name":"invited local user activated and resumed the saved Project","status":"PASS"}]'
for stage in clean-install alpha-lineage local-user same-volume-restart; do record "$stage"; done
node - "$run_root/journey.json" "$run_root" <<'NODE'
const fs=require('node:fs');const [input,root]=process.argv.slice(2);const stages=JSON.parse(fs.readFileSync(input,'utf8'));
for(const [stage,value] of Object.entries(stages))fs.writeFileSync(`${root}/${stage}.assertions.json`,JSON.stringify(value));
NODE
for stage in local-administrator oidc-provider-administration oidc-user mfa-policy team-collaboration instance-policy notifications audit-and-operations access-tokens git-integration registry-integration published-example published-preview; do record "$stage"; done

collect_compose_logs "$run_root/compose-after-restart.log"
scan_secrets() {
  local result
  local -a targets=("$@")
  if rg -n --hidden -F -f <(printf '%s\n' \
    'gate-005-db-ephemeral' 'integration-secret-0123456789' 'gate-smtp-password-ephemeral' \
    'integration-access' 'gate-005-client-secret' "$admin_password" "$invitee_password" \
    "$(cat "$run_root/preview-signing-key")" "$(cat "$run_root/save-idempotency-secret")" \
    "$(cat "$run_root/master-key")" \
    "$(cat "$run_root/provider-tls/control/git-token")" \
    "$(cat "$run_root/provider-tls/control/registry-exact-token")" \
    "$(cat "$run_root/provider-tls/control/registry-default-token")") \
    "${targets[@]}"; then
    result=0
  else
    result=$?
  fi
  if [ "$result" -eq 0 ]; then echo 'GATE-005 secret scan found an ephemeral credential' >&2; return 1; fi
  if [ "$result" -ne 1 ]; then echo "GATE-005 literal secret scan failed (${result})" >&2; return 1; fi
  if rg -n '(nrt_(inv|org_inv)_[A-Za-z0-9._-]+|nur_(pat|prj)_[A-Za-z0-9._-]+|X-Amz-(Credential|Signature)|BEGIN .*PRIVATE KEY)' "${targets[@]}"; then
    result=0
  else
    result=$?
  fi
  if [ "$result" -eq 0 ]; then echo 'GATE-005 secret scan found protected material' >&2; return 1; fi
  if [ "$result" -ne 1 ]; then echo "GATE-005 protected-material scan failed (${result})" >&2; return 1; fi
  return 0
}
scan_targets=("$run_root"/*.log "$run_root"/*.json "$run_root/compose.rendered.yaml" \
  "$run_root/stages")
scan_secrets "${scan_targets[@]}"
write_assertions secret-scan '[{"kind":"process","name":"Core, Web, provider, browser, build, and report-bound logs passed the protected-material scan","status":"PASS"}]'
record secret-scan

node - "$engine" "$release_commit" "$run_root/images.json" postgres "$NURITEO_POSTGRES_IMAGE" server "$NURITEO_SERVER_IMAGE" web "$NURITEO_WEB_IMAGE" <<'NODE'
const {execFileSync}=require('node:child_process');const fs=require('node:fs');const [engine,commit,out,...pairs]=process.argv.slice(2);const images=[];
for(let i=0;i<pairs.length;i+=2){const [name,image]=[pairs[i],pairs[i+1]];const inspect=JSON.parse(execFileSync(engine,['image','inspect',image],{encoding:'utf8'}))[0];if(inspect.Config.Labels?.['org.opencontainers.image.revision']!==commit)throw new Error(`${name} revision label mismatch`);const digest=inspect.Id.startsWith('sha256:')?inspect.Id:`sha256:${inspect.Id}`;if(!/^sha256:[0-9a-f]{64}$/.test(digest))throw new Error(`${name} image digest is invalid`);images.push({name,digest,sourceCommit:commit,sourceCommitLabelVerified:true});}fs.writeFileSync(out,JSON.stringify(images));
NODE
"$engine" ps --all --quiet --filter "label=com.docker.compose.project=$project" \
  | sed '/^$/d' | sort -u \
  | node -e 'const fs=require("node:fs");const ids=fs.readFileSync(0,"utf8").trim().split(/\n/).filter(Boolean);fs.writeFileSync(process.argv[1],JSON.stringify(ids));' "$run_root/containers.json"
export NURITEO_BETA_GATE_STAGE_RESULT_DIR="$run_root/stages"
export NURITEO_BETA_GATE_IMAGE_LEDGER="$run_root/images.json"
export NURITEO_BETA_GATE_CONTAINER_LEDGER="$run_root/containers.json"
node "$here/finalize-report.mjs"
scan_secrets "$run_root/stages" "$run_root/images.json" "$run_root/containers.json" \
  "$(dirname "$report_file")/evidence" "$report_file"
echo "GATE-005 actual aggregate driver passed (${project})"
