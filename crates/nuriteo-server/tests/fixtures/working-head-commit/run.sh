#!/usr/bin/env bash
set -euo pipefail

fixture_dir="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
export RUST_MIN_STACK="${RUST_MIN_STACK:-8388608}"
SAVE_FIXTURE_LABEL="${SAVE_FIXTURE_LABEL:-SAVE-006}" \
SAVE_TEST_NAME=working_head_commit_is_atomic_idempotent_and_fenced \
CARGO_TARGET_DIR="${CARGO_TARGET_DIR:-/private/tmp/nuriteo-save006-target}" \
exec "$fixture_dir/../single-put-save/run.sh"
