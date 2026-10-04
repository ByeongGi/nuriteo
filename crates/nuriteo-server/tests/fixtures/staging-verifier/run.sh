#!/usr/bin/env bash
set -euo pipefail

fixture_dir="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
SAVE_FIXTURE_LABEL=SAVE-005 \
SAVE_TEST_NAME=staging_verifier_accepts_golden_and_rejects_malicious_objects \
CARGO_TARGET_DIR="${CARGO_TARGET_DIR:-/private/tmp/nuriteo-save005-target}" \
exec "$fixture_dir/../single-put-save/run.sh"
