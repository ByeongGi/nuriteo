#!/usr/bin/env bash
set -euo pipefail

fixture_dir="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
SAVE_FIXTURE_LABEL=SAVE-007 \
exec "$fixture_dir/../working-head-commit/run.sh"
