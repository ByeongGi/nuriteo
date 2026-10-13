#!/bin/sh
set -eu

root="$(CDPATH= cd -- "$(dirname -- "$0")/.." && pwd)"
cd "$root"

node tooling/checks/check-self-hosted-dependency-policy.ts
cargo deny check advisories licenses sources
pnpm audit --prod --audit-level high

printf '%s\n' '{"status":"pass","task":"SEC-002","cargoAudit":true,"cargoDeny":true,"pnpmAudit":true}'
