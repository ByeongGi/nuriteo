const tests = [
  "./cli-baseline.test.mjs",
  "./cli-evaluator.test.mjs",
  "./cli-module-graph.test.mjs",
  "./conformance-matrix.test.mjs",
  "./npm-cacache-put-stream-cli-module-evaluation.test.mjs",
  "./npm-fetch-cli-module-evaluation.test.mjs",
  "./npm-fetch-tar-extract-cli-module-evaluation.test.mjs",
  "./npm-install-cli-module-evaluation.test.mjs",
  "./npm-minizlib-cli-module-evaluation.test.mjs",
  "./npm-pacote-remote-manifest-cli-module-evaluation.test.mjs",
  "./npm-registry-install-cli-module-evaluation.test.mjs",
  "./npm-remote-fetcher-tar-cli-module-evaluation.test.mjs",
  "./npm-run-exec-cli-module-evaluation.test.mjs",
  "./npm-tar-extract-cli-module-evaluation.test.mjs",
  "./npm-tar-with-temp-dir-cli-module-evaluation.test.mjs",
  "./npm-cli-module-evaluation.test.mjs",
  "./npm-guest-runtime-boot.test.mjs",
  "./npm-install-plan.test.mjs",
  "./pnpm-cli-module-evaluation.test.mjs",
  "./pnpm-exec-cli-module-evaluation.test.mjs",
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
