import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import fs from "node:fs";
import { realpathSync } from "node:fs";
import { createRequire } from "node:module";
import path, { dirname } from "node:path";

const readJson = (file: string) => JSON.parse(fs.readFileSync(file, "utf8"));
const rootManifest = readJson("package.json");
const compatibility = readJson("compat/nextjs-compatibility.json");
const browserWorker = readJson("compat/nextjs-browser-worker-results.json");
const security = readJson("compat/nextjs-security-baseline.json");
const lockfile = fs.readFileSync("pnpm-lock.yaml", "utf8");
const require = createRequire(import.meta.url);
const nextPackageRoot = dirname(realpathSync(require.resolve("next/package.json")));
const wasmPackageRoot = dirname(realpathSync(require.resolve("@next/swc-wasm-nodejs/package.json")));
const installedNext = readJson(path.join(nextPackageRoot, "package.json"));
const installedWasmSwc = readJson(path.join(wasmPackageRoot, "package.json"));
const installedNextEntrySha256 = createHash("sha256")
  .update(fs.readFileSync(path.join(nextPackageRoot, "dist/bin/next")))
  .digest("hex");
const installedNextFactorySha256 = createHash("sha256")
  .update(fs.readFileSync("packages/workspace-runtime/assets/vendor/next-cli-15.5.26.mjs"))
  .digest("hex");

assert.equal(rootManifest.devDependencies.next, compatibility.nextVersion);
assert.equal(rootManifest.devDependencies["@next/swc-wasm-nodejs"], compatibility.nextVersion);
assert.equal(installedNext.version, compatibility.nextVersion);
assert.equal(installedWasmSwc.version, compatibility.nextVersion);
assert.equal(security.next.version, compatibility.nextVersion);
assert.equal(security.wasmSwc.version, compatibility.nextVersion);
assert.equal(security.wasmSwc.package, compatibility.packageFacts.wasmSwcPackage);
assert.equal(security.wasmSwc.versionMatched, true);
assert.equal(security.wasmSwc.nativeNodeAddonsSupported, false);
assert.match(lockfile, new RegExp(`next@${escapeRegExp(security.next.version)}:\\n    resolution: \\{integrity: ${escapeRegExp(security.next.lockfileIntegrity)}\\}`));
assert.match(lockfile, new RegExp(`'@next/swc-wasm-nodejs@${escapeRegExp(security.wasmSwc.version)}':\\n    resolution: \\{integrity: ${escapeRegExp(security.wasmSwc.lockfileIntegrity)}\\}`));

assert.equal(browserWorker.executionHost, "strict-csp-headless-chrome");
assert.equal(browserWorker.nextVersion, compatibility.nextVersion);
assert.match(browserWorker.nextCliEntrySha256, /^[a-f0-9]{64}$/);
assert.equal(browserWorker.nextCliEntrySha256, installedNextEntrySha256);
assert.equal(browserWorker.nextCliFactorySha256, installedNextFactorySha256);
assert.equal(browserWorker.status, "pass");
assert.equal(browserWorker.preflight.status, "pass");
assert.equal(browserWorker.preflight.coveredModule, "/workspace/app/node_modules/next/dist/bin/next");
assert.deepEqual(browserWorker.commands, ["next dev", "next build", "next start"]);
assert.equal(browserWorker.lifecycle.factoryIntegrityRejection, "pass");
assert.equal(browserWorker.lifecycle.workerTeardown, "pass");
assert.equal(browserWorker.lifecycle.recoveryAttempt, "pass");
assert.equal(browserWorker.lifecycle.crossOriginIsolationAfterRecovery, true);
assert.equal(browserWorker.lifecycle.heapBudget, "pass");

assert.equal(security.status, "pass");
assert.equal(security.next.releaseSecurityEligible, true);
assert.equal(security.requirements.keepFullRuntimeCandidate, false);
assert.equal(security.requirements.denyNativeNodeSwcClaim, true);
assert.equal(security.requirements.requireMaintainedNextBeforeReleasePromotion, false);
assert.ok(security.advisories.some((entry: { id: string }) => entry.id === "CVE-2025-66478"));
assert.ok(security.advisories.some((entry: { id: string }) => entry.id === "2025-12-11-nextjs-security-update"));
assert.ok(security.advisories.some((entry: { id: string }) => entry.id === "2026-09-22-nextjs-security-update"));

assert.equal(compatibility.fullRuntimeGrade, "product-supported");
assert.equal(compatibility.browserWorker.status, "pass");
assert.equal(compatibility.security.status, "pass");
assert.equal(compatibility.packageFacts.nativeAddonPolicy, "unsupported");
assert.equal(compatibility.packageFacts.wasmSwcIntegrity, security.wasmSwc.lockfileIntegrity);

console.log("Next.js runtime product gate ok: maintained release, strict-CSP browser worker, and security evidence pass");

function escapeRegExp(value: string): string {
  return value.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}
