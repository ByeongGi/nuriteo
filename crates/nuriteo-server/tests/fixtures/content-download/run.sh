#!/usr/bin/env bash
set -euo pipefail

fixture_dir="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
export RUST_MIN_STACK="${RUST_MIN_STACK:-8388608}"
SAVE_FIXTURE_LABEL=SAVE-010 \
SAVE_TEST_NAME=content_download_is_authorized_fenced_bounded_and_redacted \
SAVE_TEST_TARGET=content_download \
SAVE_TEST_DESCRIPTION="authorized descriptor and same-origin bounded stream assertions" \
CARGO_TARGET_DIR="${CARGO_TARGET_DIR:-/private/tmp/nuriteo-save010-target}" \
exec "$fixture_dir/../single-put-save/run.sh"
