#!/usr/bin/env bash
set -euo pipefail

fixture_dir="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
SAVE_FIXTURE_LABEL=SAVE-013 \
SAVE_TEST_NAME=authenticated_upload_relay_streams_single_and_multipart_without_bearer_exposure \
SAVE_TEST_DESCRIPTION="authenticated relay via real Hyper serve, bounded reads, fail-closed matrix, completion, and download" \
CARGO_TARGET_DIR="${CARGO_TARGET_DIR:-/private/tmp/nuriteo-save013-target}" \
exec "$fixture_dir/../single-put-save/run.sh"
