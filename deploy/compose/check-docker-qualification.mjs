import assert from "node:assert/strict";
import fs from "node:fs";

const workflow = fs.readFileSync(".github/workflows/docker-compose-qualification.yml", "utf8");
const runner = fs.readFileSync("deploy/compose/docker-qualification-ci.sh", "utf8");
const fixture = fs.readFileSync("deploy/compose/test-compose.sh", "utf8");

for (const trigger of ["pull_request:", "paths:", "workflow_dispatch:"]) {
  assert(workflow.includes(trigger), `qualification workflow missing trigger contract: ${trigger}`);
}
for (const path of [
  '".github/workflows/docker-compose-qualification.yml"',
  '"deploy/compose/**"',
  '"deploy/docker/**"',
  '"crates/nuriteo-server/**"',
  '"apps/web/**"'
]) {
  assert(workflow.includes(path), `qualification workflow missing path filter: ${path}`);
}
assert.match(workflow, /^permissions:\n  contents: read$/mu);
assert.match(workflow, /^concurrency:\n  group: docker-compose-qualification-/mu);
assert.match(workflow, /if: github\.event_name == 'workflow_dispatch'/u);
assert.match(workflow, /runs-on: ubuntu-24\.04/u);
assert.match(workflow, /timeout-minutes: 75/u);
assert.match(workflow, /if: failure\(\)[\s\S]*docker-qualification-ci\.sh diagnostics/u);
assert.match(workflow, /if: always\(\)[\s\S]*docker-qualification-ci\.sh cleanup/u);
assert.match(workflow, /if: steps\.cleanup\.outcome == 'failure'[\s\S]*docker-qualification-ci\.sh diagnostics/u);
assert.match(workflow, /actions\/upload-artifact@v4[\s\S]*if-no-files-found: error/u);

for (const bound of [
  "readonly pull_timeout=10m",
  "readonly build_timeout=35m",
  "readonly acceptance_timeout=35m",
  "readonly diagnostics_timeout=2m",
  "readonly cleanup_timeout=8m"
]) {
  assert(runner.includes(bound), `qualification runner missing hard bound: ${bound}`);
}
assert.match(runner, /docker compose version --short/u);
assert.match(runner, /docker info --format '\{\{\.OSType\}\}'/u);
assert.match(runner, /NURITEO_COMPOSE_PROVIDER=docker/u);
assert.doesNotMatch(runner, /\bpodman(?:-compose)?\b/u);
assert.match(runner, /docker compose[\s\S]*pull --ignore-buildable rustfs storage-init/u);
assert.match(runner, /docker compose[\s\S]*build --pull postgres core web/u);
assert.match(runner, /docker builder prune --all --force/u);
assert.match(runner, /docker volume ls --format/u);
assert.match(runner, /docker network ls --format/u);
assert.match(runner, /grep -Fqx "\$expected_success"/u);
assert.match(runner, /project\\tservice\\tstate\\texit_code\\thealth/u);
assert.match(runner, /fixture_failure=%s/u);
assert.match(runner, /run_bounded "\$pull_timeout" pull-internal/u);
assert.match(runner, /run_bounded "\$diagnostics_timeout" collect-state/u);
assert.match(runner, /run_bounded "\$cleanup_timeout" cleanup-internal/u);
assert.doesNotMatch(runner, /docker (?:compose )?logs\b/u);
assert.doesNotMatch(runner, /cat "\$raw_log"|tee .*raw/u);
assert.match(fixture, /echo 'compose acceptance ok \(clean install, idempotent restart, persistence, failed-one-shot gate\)'/u);

console.log("Docker Compose v2 qualification workflow contract ok (manual actual lane, bounded allowlisted diagnostics)");
