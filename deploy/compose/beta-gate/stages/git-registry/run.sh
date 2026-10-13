#!/usr/bin/env bash
set -Eeuo pipefail
umask 077

readonly here="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
readonly repository_root="$(cd "$here/../../../../.." && pwd)"
readonly compose_file="${NURITEO_GATE_COMPOSE_FILE:-$repository_root/deploy/compose/compose.yaml}"
readonly provider_file="${NURITEO_GATE_PROVIDER_COMPOSE_FILE:-$repository_root/deploy/compose/beta-gate/compose.providers.yaml}"
readonly project="${NURITEO_BETA_GATE_COMPOSE_PROJECT:?NURITEO_BETA_GATE_COMPOSE_PROJECT is required}"
stage_root="$(python3 -c 'import os,sys; print(os.path.realpath(sys.argv[1]))' "${NURITEO_GATE_STAGE_ROOT:?NURITEO_GATE_STAGE_ROOT is required}")"
readonly harness_directory="$(python3 -c 'import os,sys; print(os.path.realpath(sys.argv[1]))' "${NURITEO_BETA_GATE_HARNESS_DIR:?NURITEO_BETA_GATE_HARNESS_DIR is required}")"
readonly state_file="$stage_root/git-registry-state.json"
assertion_directory="$(python3 -c 'import os,sys; print(os.path.realpath(sys.argv[1]))' "${NURITEO_GATE_ASSERTION_DIRECTORY:-$stage_root}")"
readonly harness_service="${NURITEO_GATE_HARNESS_SERVICE:-gate-harness}"
declare -a compose_command

[[ -f "$repository_root/Cargo.toml" && -d "$repository_root/deploy/compose/beta-gate" ]] || {
  echo 'Git/Registry stage could not resolve the repository root' >&2
  exit 2
}
[[ -f "$compose_file" && -f "$provider_file" ]] || {
  echo 'Git/Registry stage Compose inputs are missing' >&2
  exit 2
}
[[ "$harness_directory" = "$stage_root" ]] || {
  echo 'NURITEO_BETA_GATE_HARNESS_DIR must equal NURITEO_GATE_STAGE_ROOT' >&2
  exit 2
}

required=(
  NURITEO_BETA_GATE_ORIGIN NURITEO_BETA_GATE_ADMIN_PASSWORD_FILE
  NURITEO_BETA_GATE_CONTEXT_FILE NURITEO_BETA_GATE_DATABASE_LINEAGE
  NURITEO_BETA_GATE_OBJECT_LINEAGE NURITEO_GATE_PROVIDER_CA_FILE
  NURITEO_GATE_GIT_HOST NURITEO_GATE_GIT_PORT NURITEO_GATE_GIT_TOKEN
  NURITEO_GATE_GIT_REPOSITORY_URL NURITEO_GATE_GIT_CONTROL_URL
  NURITEO_GATE_REGISTRY_EXACT_URL NURITEO_GATE_REGISTRY_EXACT_TOKEN
  NURITEO_GATE_REGISTRY_EXACT_CONTROL_URL
  NURITEO_GATE_REGISTRY_DEFAULT_URL NURITEO_GATE_REGISTRY_DEFAULT_TOKEN
  NURITEO_GATE_REGISTRY_DEFAULT_CONTROL_URL
)
for name in "${required[@]}"; do
  [[ -n "${!name:-}" ]] || { echo "${name} is required" >&2; exit 2; }
done

if docker compose version >/dev/null 2>&1; then compose_command=(docker compose)
elif command -v uvx >/dev/null 2>&1 && command -v podman >/dev/null 2>&1; then
  compose_command=(uvx --from podman-compose==1.5.0 podman-compose --in-pod false)
elif podman compose version >/dev/null 2>&1; then compose_command=(podman compose)
else echo 'Git/Registry stage requires Docker Compose or Podman Compose' >&2; exit 1; fi
compose() { "${compose_command[@]}" -f "$compose_file" -f "$provider_file" --project-name "$project" "$@"; }
query() { compose exec -T postgres psql -X --username nuriteo --dbname nuriteo --tuples-only --no-align --set ON_ERROR_STOP=1 --command "$1"; }
harness() {
  compose --profile gate-harness run --rm --no-deps -T \
    -e "NURITEO_GATE_HARNESS_COMMAND=$1" \
    -e 'NURITEO_GATE_REGISTRY_PACKAGE=@gate/exact' \
    -e 'NURITEO_GATE_REGISTRY_METADATA_FILE=/run/gate-state/registry-metadata.json' \
    "$harness_service"
}
browser_phase() {
  NURITEO_GATE_GIT_REGISTRY_PHASE="$1" \
  NURITEO_GATE_GIT_REGISTRY_STATE="$state_file" \
  node --experimental-strip-types "$here/browser-stage.ts"
}
provider_stats() {
  NURITEO_GATE_PROVIDER_FETCH_ORIGIN="$1" \
  NURITEO_GATE_PROVIDER_FETCH_OUTPUT="$2" \
  node "$here/fetch-provider.mjs" stats
}
read_lineage_object() {
  compose exec -T rustfs /bin/sh -eu -c '
    access="$(cat /run/secrets/rustfs_access_key)"; secret="$(cat /run/secrets/rustfs_secret_key)"
    curl --fail --silent --cacert /etc/rustfs/tls/ca.crt --aws-sigv4 aws:amz:us-east-1:s3 \
      --user "${access}:${secret}" "https://rustfs:9000/nuriteo/beta-gate/$1"
  ' _ "$NURITEO_BETA_GATE_OBJECT_LINEAGE"
}

mkdir -p "$stage_root" "$assertion_directory"
query "$(<"$here/sentinels.sql")" >"$stage_root/sentinels-before.json"
read_lineage_object >"$stage_root/object-lineage-before"
[[ "$(<"$stage_root/object-lineage-before")" = "$NURITEO_BETA_GATE_OBJECT_LINEAGE" ]]

admin_identity="$(query "SELECT user_row.id::text||'|'||session.id::text FROM users user_row JOIN sessions session ON session.user_id=user_row.id WHERE user_row.is_instance_admin AND user_row.status='active' AND session.revoked_at IS NULL AND session.idle_expires_at>CURRENT_TIMESTAMP AND session.absolute_expires_at>CURRENT_TIMESTAMP AND session.last_reauthenticated_at>=CURRENT_TIMESTAMP-INTERVAL '15 minutes' ORDER BY session.last_reauthenticated_at DESC LIMIT 1;")"
IFS='|' read -r admin_user_id admin_session_id <<<"$admin_identity"
[[ -n "$admin_user_id" && -n "$admin_session_id" ]]

browser_phase configure
browser_phase exercise
harness registry-fetch >"$stage_root/registry-fetch.result"

NURITEO_GATE_REGISTRY_METADATA_FILE="$stage_root/registry-metadata.json" \
NURITEO_GATE_PROVIDER_FETCH_ORIGIN="$NURITEO_GATE_REGISTRY_EXACT_CONTROL_URL" \
NURITEO_GATE_PROVIDER_TOKEN="$NURITEO_GATE_REGISTRY_EXACT_TOKEN" \
NURITEO_GATE_PROVIDER_FETCH_OUTPUT="$stage_root/registry-package.tgz" \
node "$here/fetch-provider.mjs" tarball

provider_stats "$NURITEO_GATE_REGISTRY_DEFAULT_CONTROL_URL" "$stage_root/registry-default-before-no-fallback.json"
browser_phase disable-exact
harness registry-expect-no-fallback >"$stage_root/registry-no-fallback.result"
provider_stats "$NURITEO_GATE_REGISTRY_DEFAULT_CONTROL_URL" "$stage_root/registry-default-after-no-fallback.json"
provider_stats "$NURITEO_GATE_REGISTRY_EXACT_CONTROL_URL" "$stage_root/registry-exact-stats.json"
provider_stats "$NURITEO_GATE_GIT_CONTROL_URL" "$stage_root/git-stats.json"

project_id="$(node -e 'const fs=require("node:fs");const value=JSON.parse(fs.readFileSync(process.argv[1],"utf8"));if(typeof value.projectId!=="string")process.exit(1);process.stdout.write(value.projectId)' "$NURITEO_BETA_GATE_CONTEXT_FILE")"
compose exec -T postgres psql -X --username nuriteo --dbname nuriteo --tuples-only --no-align --set ON_ERROR_STOP=1 \
  --set "project_id=$project_id" <"$here/git-lineage.sql" >"$stage_root/git-lineage.json"
git_object_key="$(node -e 'const fs=require("node:fs");const value=JSON.parse(fs.readFileSync(process.argv[1],"utf8"));if(typeof value.objectKey!=="string")process.exit(1);process.stdout.write(value.objectKey)' "$stage_root/git-lineage.json")"
compose exec -T rustfs /bin/sh -eu -c '
  access="$(cat /run/secrets/rustfs_access_key)"; secret="$(cat /run/secrets/rustfs_secret_key)"
  curl --fail --silent --output /dev/null --cacert /etc/rustfs/tls/ca.crt --aws-sigv4 aws:amz:us-east-1:s3 \
    --user "${access}:${secret}" "https://rustfs:9000/nuriteo/$1"
' _ "$git_object_key"

query "$(<"$here/sentinels.sql")" >"$stage_root/sentinels-after.json"
read_lineage_object >"$stage_root/object-lineage-after"
[[ "$(<"$stage_root/object-lineage-after")" = "$(<"$stage_root/object-lineage-before")" ]]

NURITEO_GATE_SENTINELS_BEFORE="$stage_root/sentinels-before.json" \
NURITEO_GATE_SENTINELS_AFTER="$stage_root/sentinels-after.json" \
NURITEO_GATE_GIT_DB_ASSERTION="$stage_root/git-lineage.json" \
NURITEO_GATE_PROJECT_ID="$project_id" \
NURITEO_GATE_GIT_OBJECT_EXISTS=true \
NURITEO_GATE_GIT_STATS="$stage_root/git-stats.json" \
NURITEO_GATE_REGISTRY_EXACT_STATS="$stage_root/registry-exact-stats.json" \
NURITEO_GATE_REGISTRY_DEFAULT_BEFORE_NO_FALLBACK="$stage_root/registry-default-before-no-fallback.json" \
NURITEO_GATE_REGISTRY_DEFAULT_AFTER_NO_FALLBACK="$stage_root/registry-default-after-no-fallback.json" \
NURITEO_GATE_REGISTRY_METADATA_FILE="$stage_root/registry-metadata.json" \
NURITEO_GATE_REGISTRY_TARBALL_FILE="$stage_root/registry-package.tgz" \
NURITEO_GATE_REGISTRY_PACKAGE='@gate/exact' \
NURITEO_GATE_ASSERTION_DIRECTORY="$assertion_directory" \
node "$here/assertions.mjs"

echo 'GATE-005 Git and Registry live stages passed'
