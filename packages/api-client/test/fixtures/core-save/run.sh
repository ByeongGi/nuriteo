#!/usr/bin/env bash
set -euo pipefail

for upload_transport in direct relay; do
  CLIENT_LIVE_CONTRACT=packages/api-client/test/save-live-contract.ts \
  NURITEO_CLIENT_TEST_SAVE_UPLOAD_TRANSPORT="$upload_transport" \
    packages/api-client/test/fixtures/core-organization/run.sh
done
