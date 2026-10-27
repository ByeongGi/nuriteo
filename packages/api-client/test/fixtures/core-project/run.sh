#!/usr/bin/env bash
set -euo pipefail

export CLIENT_LIVE_CONTRACT=packages/api-client/test/projects/project-live-contract.ts
exec packages/api-client/test/fixtures/core-organization/run.sh
