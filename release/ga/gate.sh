#!/bin/sh
set -eu

root="$(CDPATH= cd -- "$(dirname -- "$0")/../.." && pwd)"
cd "$root"
public_key="${NURITEO_GA_PUBLIC_KEY:?NURITEO_GA_PUBLIC_KEY is required}"

pnpm check:self-hosted-ga-baseline
pnpm check:self-hosted-reproducible-images
pnpm check:self-hosted-supply-chain
pnpm check:self-hosted-chart-release
pnpm check:self-hosted-release-manifest
pnpm check:self-hosted-publish-rehearsal
pnpm check:self-hosted-ga-qualification
release/ga/verify-supply-chain.sh "$public_key" release/ga/artifacts
node release/ga/verify-chart-binding.mjs release/ga/artifacts/nuriteo-1.0.0.chart-images.json
node release/ga/verify-release-manifest.mjs release/ga/artifacts
pnpm check:ga-gate
