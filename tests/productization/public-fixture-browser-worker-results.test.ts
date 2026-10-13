import assert from "node:assert/strict";
import crypto from "node:crypto";
import fs from "node:fs";

const results = JSON.parse(fs.readFileSync(new URL("../../compat/public-fixture-browser-worker-results.json", import.meta.url), "utf8"));

assert.equal(results.schemaVersion, 1);
assert.equal(results.status, "pass");
assert.equal(results.fixtureId, "vite-official-template-react");
assert.equal(results.revision, "1544bb1b7ac92f775e9d0dea97954c99cc6cbd43");
assert.equal(results.viteVersion, "8.2.0");
assert.equal(results.executionHost, "strict-csp-chrome-process-worker");
assert.equal(results.headers.csp.includes("'unsafe-eval'"), false);
assert.equal(results.headers.csp.includes("'wasm-unsafe-eval'"), true);
assert.equal(results.headers.isolated, true);
assert.equal(results.install.status, "pass");
assert.equal(results.dev.exitCode, 0);
assert.equal(results.dev.indexStatus, 200);
assert.equal(results.hmr.connected, true);
assert.ok(results.hmr.updateType === "update" || results.hmr.updateType === "full-reload");
assert.equal(results.hmr.afterEditContainsMarker, true);
assert.equal(results.build.exitCode, 0);
assert.ok(results.build.distFiles.some((file) => file.path.endsWith("/dist/index.html") && file.bytes > 0));
assert.ok(results.build.distFiles.some((file) => file.path.includes("/dist/assets/") && file.bytes > 0));
assert.equal(results.preview.exitCode, 0);
assert.equal(results.preview.statusCode, 200);
assert.equal(results.lifecycle.workerTargetsAfter, results.lifecycle.workerTargetsBefore);
assert.equal(results.lifecycle.restartable, true);

const assets = {
  "packages/workspace-runtime/assets/vendor/vite-8.2.0/assets/rolldown-binding.wasm": "ce4821fa65dcc84f641980889d175fecbdf9fc108ed438c5ab363802a681fce1",
  "packages/workspace-runtime/assets/vendor/vite-8.2.0/assets/wasi-worker-browser-IL7bwx-u.js": "cca841fe347316a6512d885211fc9604d819a06082a4c3eb710e0673cb5a1983",
  "packages/workspace-runtime/assets/vendor/vite-8.2.0/rolldown-wasi-binding.mjs": "b1a16143d4991cc6f4ff6a3043d40a2b757d74746ebe408298b1a2d4b5cb0606",
  "packages/workspace-runtime/assets/vendor/vite-8.2.0/vite-cli-static-factories.mjs": "a349825dafc4ab5b2ad3a9fa4489965bda62cb8f47bc5a9fa84f200ea1bfa2aa"
};
for (const [relativePath, expected] of Object.entries(assets)) {
  const bytes = fs.readFileSync(new URL(`../../${relativePath}`, import.meta.url));
  assert.equal(crypto.createHash("sha256").update(bytes).digest("hex"), expected, `${relativePath} integrity mismatch`);
}

assert.ok(fs.existsSync(new URL("../../tooling/generators/build-vite-csp-factory.ts", import.meta.url)));
assert.ok(fs.existsSync(new URL("../../tooling/fixtures/smoke-public-fixture-browser-worker.ts", import.meta.url)));

console.log("public fixture browser worker results test ok");
