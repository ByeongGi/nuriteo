#!/usr/bin/env bash
set -euo pipefail

fixture_dir="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
SAVE_FIXTURE_LABEL=SAVE-008 \
SAVE_TEST_NAME=explicit_project_versions_are_immutable_authorized_and_gc_safe \
CARGO_TARGET_DIR="${CARGO_TARGET_DIR:-/private/tmp/nuriteo-save008-target}" \
exec "$fixture_dir/../single-put-save/run.sh"
