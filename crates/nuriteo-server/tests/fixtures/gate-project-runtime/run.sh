#!/usr/bin/env bash
set -euo pipefail

script_dir="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
repo_root="$(cd "$script_dir/../../../../../" && pwd)"
browser_fixture="$repo_root/apps/web/test/gate-project-runtime-browser.test.ts"
node_executable="$(mise which node@22.23.0)"

cd "$repo_root"

echo 'GATE-003: building production Next.js standalone and content-addressed Runtime assets'
mise exec node@22.23.0 pnpm@11.15.1 -- pnpm --filter @nuriteo/web build

echo 'GATE-003: running actual Core/PostgreSQL to production Web/Runtime/Preview browser journey'
NURITEO_GATE_TEST_NAME=project_runtime_gate_runs_actual_core_and_browser_journey \
NURITEO_TEST_GATE_PROJECT_RUNTIME_BROWSER="$browser_fixture" \
NURITEO_TEST_NODE_EXECUTABLE="$node_executable" \
  "$repo_root/crates/nuriteo-server/tests/fixtures/gate-collaboration/run.sh"

echo 'GATE-003: PASS'
