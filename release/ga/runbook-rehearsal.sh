#!/usr/bin/env bash
set -euo pipefail

root="$(cd "$(dirname "${BASH_SOURCE[0]}")/../.." && pwd)"
cd "$root"

node deploy/compose/check-compose.mjs
charts/nuriteo/tests/check-chart.sh
node deploy/compose/check-upgrade.mjs
cargo test -p nuriteo-server backup:: --lib
pnpm check:incident-playbook
pnpm check:self-hosted-support-bundle
pnpm check:self-hosted-runbooks

printf '%s\n' '{"status":"pass","task":"SUP-003","runbooks":5,"mode":"contract-and-focused-execution"}'
