const tests = [
  "./cli-baseline.test.mjs",
  "./cli-evaluator.test.mjs",
  "./cli-module-graph.test.mjs",
  "./conformance-matrix.test.mjs",
  "./npm-install-cli-module-evaluation.test.mjs",
  "./npm-cli-module-evaluation.test.mjs",
  "./npm-guest-runtime-boot.test.mjs",
  "./npm-install-plan.test.mjs",
  "./pnpm-cli-module-evaluation.test.mjs",
  "./pnpm-install-cli-module-evaluation.test.mjs",
  "./pnpm-guest-runtime-boot.test.mjs",
  "./pnpm-store-plan.test.mjs",
  "./tarball-cache.test.mjs",
  "./fetcher.test.mjs",
  "./npm-integration.test.mjs",
  "./pnpm-integration.test.mjs"
];

for (const test of tests) {
  await import(test);
}
