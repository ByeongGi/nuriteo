#!/usr/bin/env bash
set -euo pipefail

root="$(cd "$(dirname "${BASH_SOURCE[0]}")/../.." && pwd)"
cd "$root"

pnpm check:self-hosted-support-process
pnpm check:incident-playbook
pnpm check:self-hosted-security-release
pnpm check:self-hosted-support-bundle

printf '%s\n' '{"status":"pass","task":"SUP-004","scenario":"suspected-registry-credential-exposure","states":7,"secretMaterialPresent":false}'
