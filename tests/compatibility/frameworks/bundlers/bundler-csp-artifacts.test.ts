import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import fs from "node:fs";

const root = new URL("../../../../", import.meta.url);
const packageManifest = JSON.parse(fs.readFileSync(new URL("package.json", root), "utf8"));
const lanes = {
  webpack: { version: "5.111.0", cjs: 3823, esm: 115, packages: 277, workspaceFiles: 5082 },
  rspack: { version: "2.2.4", cjs: 1899, esm: 96, packages: 205, workspaceFiles: 2903 }
} as const;

for (const [lane, expected] of Object.entries(lanes)) {
  const artifactRoot = new URL(`packages/workspace-runtime/assets/vendor/${lane}-${expected.version}/`, root);
  const manifest = JSON.parse(fs.readFileSync(new URL("factory-manifest.json", artifactRoot), "utf8"));
  assert.equal(manifest.bundler, lane);
  assert.equal(manifest.version, expected.version);
  assert.equal(manifest.packages, expected.packages);
  assert.equal(manifest.workspaceFiles, expected.workspaceFiles);
  assert.equal(manifest.cjsFactories, expected.cjs);
  assert.equal(manifest.esmFactories, expected.esm);
  assert.deepEqual(manifest.skippedModules, []);
  const factoryUrl = new URL("cli-static-factories.mjs", artifactRoot);
  assertNormalizedGeneratedText(factoryUrl, `${lane} factory`);
  assert.equal(sha256(factoryUrl), manifest.assets.factory.sha256);
  assert.equal(sha256(new URL("package-workspace.bin", artifactRoot)), manifest.assets.workspace.sha256);
}

assert.equal(packageManifest.devDependencies.webpack, "5.111.0");
assert.equal(packageManifest.devDependencies["webpack-cli"], "7.2.3");
assert.equal(packageManifest.devDependencies["webpack-dev-server"], "5.2.2");
assert.equal(packageManifest.devDependencies["@rspack/core"], "2.2.4");
assert.equal(packageManifest.devDependencies["@rspack/cli"], "2.2.4");
assert.equal(packageManifest.devDependencies["@rspack/dev-server"], "1.2.1");
assert.equal(packageManifest.devDependencies["@rspack/binding-wasm32-wasi"], "2.2.4");
assert.equal(sha256(new URL("packages/workspace-runtime/assets/vendor/rspack-2.2.4/assets/rspack.wasm", root)), "99425ddaffe461d35421208867c36c7b1edf2166c293a6425f3dc7f653b57055");
assertNormalizedGeneratedText(new URL("packages/workspace-runtime/assets/vendor/rspack-2.2.4/rspack-wasi-binding.mjs", root), "Rspack WASI binding");
assertNormalizedGeneratedText(new URL("packages/workspace-runtime/assets/vendor/rspack-2.2.4/assets/wasi-worker-browser.mjs", root), "Rspack WASI worker");

console.log("bundler CSP artifacts test ok");

function sha256(url: URL): string {
  return createHash("sha256").update(fs.readFileSync(url)).digest("hex");
}

function assertNormalizedGeneratedText(url: URL, label: string): void {
  const source = fs.readFileSync(url, "utf8");
  assert.equal(source.includes("\r"), false, `${label} must use LF line endings`);
  assert.doesNotMatch(source, /[\t ]+$/m, `${label} must not contain trailing horizontal whitespace`);
  assert.equal(source.split("\n").some((line) => / \t/.test(line.match(/^[\t ]*/)?.[0] ?? "")), false, `${label} must not mix spaces before tabs in indentation`);
}
