#!/usr/bin/env bash
set -euo pipefail

fixture_dir="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
SAVE_FIXTURE_LABEL=SAVE-011 \
SAVE_TEST_NAME=save_http_is_authorized_restart_stable_and_commits_the_working_head \
CARGO_TARGET_DIR="${CARGO_TARGET_DIR:-/private/tmp/nuriteo-save011-target}" \
exec "$fixture_dir/../single-put-save/run.sh"
