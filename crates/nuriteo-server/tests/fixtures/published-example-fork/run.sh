#!/usr/bin/env bash
set -euo pipefail

fixture_dir="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
export RUST_MIN_STACK="${RUST_MIN_STACK:-8388608}"
SAVE_FIXTURE_LABEL=PUB-002 \
SAVE_TEST_NAME=published_example_fork_rematerializes_destination_identity \
SAVE_TEST_TARGET=single_put_save \
SAVE_TEST_DESCRIPTION="server-side Published Example fork destination identity assertions" \
CARGO_TARGET_DIR="${CARGO_TARGET_DIR:-/private/tmp/nuriteo-pub002-target}" \
exec "$fixture_dir/../single-put-save/run.sh"
