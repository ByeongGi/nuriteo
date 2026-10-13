#!/usr/bin/env bash
set -euo pipefail

fixture_dir="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
SAVE_FIXTURE_LABEL=SAVE-012 \
SAVE_TEST_NAME=project_history_promotes_atomically_and_replays_durable_outcomes \
CARGO_TARGET_DIR="${CARGO_TARGET_DIR:-/private/tmp/nuriteo-save012-target}" \
exec "$fixture_dir/../single-put-save/run.sh"
