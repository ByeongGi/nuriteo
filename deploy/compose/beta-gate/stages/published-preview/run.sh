#!/usr/bin/env bash
set -Eeuo pipefail
umask 077

readonly here="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
readonly repository_root="$(cd "$here/../../../../.." && pwd)"
readonly compose_file="$repository_root/deploy/compose/compose.yaml"
readonly provider_file="$repository_root/deploy/compose/beta-gate/compose.providers.yaml"
readonly project="${NURITEO_BETA_GATE_COMPOSE_PROJECT:?NURITEO_BETA_GATE_COMPOSE_PROJECT is required}"
readonly origin="${NURITEO_BETA_GATE_ORIGIN:?NURITEO_BETA_GATE_ORIGIN is required}"
readonly context_file="${NURITEO_BETA_GATE_CONTEXT_FILE:?NURITEO_BETA_GATE_CONTEXT_FILE is required}"
readonly output="${NURITEO_BETA_GATE_STAGE_OUTPUT:?NURITEO_BETA_GATE_STAGE_OUTPUT is required}"
readonly database_lineage="${NURITEO_BETA_GATE_DATABASE_LINEAGE:?NURITEO_BETA_GATE_DATABASE_LINEAGE is required}"
readonly object_lineage="${NURITEO_BETA_GATE_OBJECT_LINEAGE:?NURITEO_BETA_GATE_OBJECT_LINEAGE is required}"
readonly run_root="$(mktemp -d "${TMPDIR:-/tmp}/nuriteo-gate-005-published-preview.XXXXXX")"
declare -a compose_command

cleanup() {
  case "$run_root" in
    "${TMPDIR:-/tmp}"/nuriteo-gate-005-published-preview.*) rm -rf -- "$run_root" ;;
    *) echo 'refusing to remove an unexpected stage directory' >&2 ;;
  esac
}
trap cleanup EXIT HUP INT TERM

if docker compose version >/dev/null 2>&1; then
  compose_command=(docker compose)
elif command -v uvx >/dev/null 2>&1 && command -v podman >/dev/null 2>&1; then
  compose_command=(uvx --from podman-compose==1.5.0 podman-compose --in-pod false)
elif podman compose version >/dev/null 2>&1; then
  compose_command=(podman compose)
else
  echo 'published-preview requires Docker Compose or Podman Compose' >&2
  exit 1
fi

compose() {
  "${compose_command[@]}" -f "$compose_file" -f "$provider_file" --project-name "$project" "$@"
}

query() {
  compose exec -T postgres psql -X --username nuriteo --dbname nuriteo \
    --tuples-only --no-align --set ON_ERROR_STOP=1 --command "$1"
}

read -r project_id project_version_id < <(node - "$context_file" <<'NODE'
const fs = require("node:fs");
const context = JSON.parse(fs.readFileSync(process.argv[2], "utf8"));
const uuid = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/u;
if (!uuid.test(context.projectId) || !uuid.test(context.projectVersionId)) {
  throw new Error("gate Project context is invalid");
}
process.stdout.write(`${context.projectId} ${context.projectVersionId}\n`);
NODE
)

lineage_before="$(query "SELECT database_lineage::text || '|' || object_lineage::text FROM beta_gate_lineage;")"
test "$lineage_before" = "${database_lineage}|${object_lineage}"

query "SELECT json_build_object(\
  'publicId',example.public_id,\
  'versionNumber',version.version_number,\
  'projectId',example.project_id,\
  'projectVersionId',version.project_version_id) \
FROM published_examples example \
JOIN published_example_versions version ON version.example_id=example.id \
WHERE example.project_id='${project_id}'::uuid \
  AND version.project_version_id='${project_version_id}'::uuid \
  AND example.state='published' \
ORDER BY example.created_at DESC LIMIT 1;" >"$run_root/identity.json"

node - "$run_root/identity.json" "$project_id" "$project_version_id" <<'NODE'
const fs = require("node:fs");
const [file, projectId, projectVersionId] = process.argv.slice(2);
const identity = JSON.parse(fs.readFileSync(file, "utf8"));
if (!/^[A-Za-z0-9_-]{43}$/u.test(identity.publicId)
    || !Number.isSafeInteger(identity.versionNumber)
    || identity.versionNumber < 1
    || identity.projectId !== projectId
    || identity.projectVersionId !== projectVersionId) {
  throw new Error("published example does not belong to the gate Project Version");
}
NODE

NURITEO_BETA_GATE_PUBLISHED_IDENTITY_FILE="$run_root/identity.json" \
NURITEO_BETA_GATE_STAGE_OUTPUT="$run_root/stage.json" \
node --experimental-strip-types "$here/journey.ts"

lineage_after="$(query "SELECT database_lineage::text || '|' || object_lineage::text FROM beta_gate_lineage;")"
test "$lineage_after" = "$lineage_before"
mv "$run_root/stage.json" "$output"

node - "$output" <<'NODE'
const fs = require("node:fs");
const result = JSON.parse(fs.readFileSync(process.argv[2], "utf8"));
const assertions = result["published-preview"];
if (!Array.isArray(assertions) || assertions.length < 4
    || assertions.some((item) => item?.status !== "PASS")) {
  throw new Error("published-preview did not produce passing stage assertions");
}
NODE

echo 'GATE-005 published-preview same-lineage browser stage passed'
