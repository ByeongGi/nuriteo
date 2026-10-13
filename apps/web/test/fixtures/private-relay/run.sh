#!/usr/bin/env bash
set -euo pipefail

fixture_dir="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
repo_root="$(cd "$fixture_dir/../../../../.." && pwd)"
cd "$repo_root"

web_port="$(mise exec node@22.23.0 -- node -e 'const net = require("node:net"); const server = net.createServer(); server.listen(0, "127.0.0.1", () => { console.log(server.address().port); server.close(); });')"

CLIENT_LIVE_CONTRACT=apps/web/test/relay-save-resume-live.ts \
NURITEO_CLIENT_TEST_EXTERNAL_URL="http://127.0.0.1:${web_port}" \
NURITEO_CLIENT_TEST_SAVE_UPLOAD_TRANSPORT=relay \
  packages/api-client/test/fixtures/core-organization/run.sh
