#!/usr/bin/env bash
set -euo pipefail

fixture_dir="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
SAVE_FIXTURE_LABEL=SAVE-004 \
SAVE_TEST_NAME=multipart_save_is_bounded_exact_and_reconcilable \
CARGO_TARGET_DIR="${CARGO_TARGET_DIR:-/private/tmp/nuriteo-save004-target}" \
exec "$fixture_dir/../single-put-save/run.sh"
