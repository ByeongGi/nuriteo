import crypto from "node:crypto";
import fs from "node:fs";
import path from "node:path";

export const DEFAULT_SDK_BASE_PATH = "/sdk/";
export const PACKAGE_ROOT = "dist/sdk/package";
export const TARBALL_PATH = "dist/sdk/nuriteo-sdk-0.1.0-beta.1.tgz";
export const FINGERPRINT_PATH = "docs/release/fingerprint.json";
export const ASSET_MANIFEST_PATH = "dist/sdk/package/asset-manifest.json";

export const RECOVERY_COMMANDS = [
  "mise exec node@22.23.0 -- node tooling/release/package-sdk.ts --write-fingerprint",
  "mise exec node@22.23.0 -- node tooling/checks/check-release-readiness.ts",
  "mise exec node@22.23.0 -- node tooling/checks/check-release-provenance.ts"
];

export function sha256File(file) {
  return crypto.createHash("sha256").update(fs.readFileSync(file)).digest("hex");
}

export function readJson(file) {
  return JSON.parse(fs.readFileSync(file, "utf8"));
}

export function assert(condition, message) {
  if (!condition) throw new Error(message);
}

export function assertFingerprint(condition, message) {
  if (!condition) {
    throw new Error([
      message,
      "",
      "Recovery:",
      ...RECOVERY_COMMANDS.map((command) => `  ${command}`),
      "",
      "See docs/release/operations.md#fingerprint-recovery"
    ].join("\n"));
  }
}

export function normalizeBasePath(value) {
  const trimmed = String(value || DEFAULT_SDK_BASE_PATH).trim();
  if (!trimmed.startsWith("/")) {
    throw new Error(`SDK base path must be absolute from origin root: ${trimmed}`);
  }
  return trimmed.endsWith("/") ? trimmed : `${trimmed}/`;
}

export function resolveSdkBasePath({ argv = process.argv.slice(2), env = process.env } = {}) {
  const fromArg = argv.find((arg) => arg.startsWith("--base-path="))?.slice("--base-path=".length);
  return normalizeBasePath(fromArg || env.NURITEO_SDK_BASE_PATH || DEFAULT_SDK_BASE_PATH);
}

export function shouldWriteFingerprint(argv = process.argv.slice(2)) {
  return argv.includes("--write-fingerprint");
}

export function collectSdkFingerprint({
  root = process.cwd(),
  basePath = DEFAULT_SDK_BASE_PATH,
  generatedAt = new Date().toISOString(),
  existing = null
} = {}) {
  const packageRoot = path.join(root, PACKAGE_ROOT);
  const assetManifestPath = path.join(root, ASSET_MANIFEST_PATH);
  const tarballPath = path.join(root, TARBALL_PATH);
  const wasmPath = path.join(packageRoot, "assets/system_wasm.wasm");
  const systemWorkerPath = path.join(packageRoot, "workers/system-worker.ts");
  const processWorkerPath = path.join(packageRoot, "workers/process-worker.ts");
  const yarnClassicFactoryPath = path.join(packageRoot, "vendor/yarn-cli-1.22.22.mjs");
  const nextCliFactoryPath = path.join(packageRoot, "vendor/next-cli-15.5.26.mjs");

  for (const file of [assetManifestPath, wasmPath, systemWorkerPath, processWorkerPath, yarnClassicFactoryPath, nextCliFactoryPath, tarballPath]) {
    if (!fs.existsSync(file)) {
      throw new Error(`missing SDK package artifact for fingerprint: ${path.relative(root, file)}`);
    }
  }

  const assetManifest = readJson(assetManifestPath);
  const normalizedBasePath = normalizeBasePath(basePath);
  if (assetManifest.basePath !== normalizedBasePath) {
    throw new Error(
      `asset manifest basePath (${assetManifest.basePath}) does not match packaging basePath (${normalizedBasePath})`
    );
  }

  const systemWasmSha256 = sha256File(wasmPath);
  const systemWorkerSha256 = sha256File(systemWorkerPath);
  const processWorkerSha256 = sha256File(processWorkerPath);
  const yarnClassicFactorySha256 = sha256File(yarnClassicFactoryPath);
  const nextCliFactorySha256 = sha256File(nextCliFactoryPath);
  const assetManifestSha256 = sha256File(assetManifestPath);
  const tarballSha256 = sha256File(tarballPath);

  if (assetManifest.assets.systemWasm.sha256 !== systemWasmSha256) {
    throw new Error("asset-manifest systemWasm sha256 does not match packaged wasm bytes");
  }
  if (assetManifest.assets.systemWorker.sha256 !== systemWorkerSha256) {
    throw new Error("asset-manifest systemWorker sha256 does not match packaged worker bytes");
  }
  if (assetManifest.assets.processWorker.sha256 !== processWorkerSha256) {
    throw new Error("asset-manifest processWorker sha256 does not match packaged worker bytes");
  }
  if (assetManifest.assets.yarnClassicFactory?.sha256 !== yarnClassicFactorySha256) {
    throw new Error("asset-manifest yarnClassicFactory sha256 does not match packaged factory bytes");
  }
  if (assetManifest.assets.nextCliFactory?.sha256 !== nextCliFactorySha256) {
    throw new Error("asset-manifest nextCliFactory sha256 does not match packaged factory bytes");
  }

  return {
    schemaVersion: 2,
    generatedAt,
    baseline: existing?.baseline ?? null,
    rehearsedNotPromoted: existing?.rehearsedNotPromoted ?? null,
    sdkPackage: {
      path: PACKAGE_ROOT,
      basePath: normalizedBasePath,
      assetManifestSha256,
      systemWasmSha256,
      systemWorkerSha256,
      processWorkerSha256,
      yarnClassicFactorySha256,
      nextCliFactorySha256,
      tarballPath: TARBALL_PATH,
      tarballSha256
    },
    releaseDecision: existing?.releaseDecision ?? {
      status: "internal-release-ready",
      externalPublish: "not-in-scope"
    }
  };
}

export function writeFingerprint(fingerprint, { root = process.cwd() } = {}) {
  const target = path.join(root, FINGERPRINT_PATH);
  fs.mkdirSync(path.dirname(target), { recursive: true });
  fs.writeFileSync(target, `${JSON.stringify(fingerprint, null, 2)}\n`);
  return target;
}

export function verifyReleaseArtifacts({ root = process.cwd() } = {}) {
  const fingerprintPath = path.join(root, FINGERPRINT_PATH);
  const assetManifestPath = path.join(root, ASSET_MANIFEST_PATH);
  const packageRoot = path.join(root, PACKAGE_ROOT);
  const tarballPath = path.join(root, TARBALL_PATH);

  assertFingerprint(fs.existsSync(fingerprintPath), `missing release fingerprint: ${FINGERPRINT_PATH}`);
  assertFingerprint(fs.existsSync(assetManifestPath), `missing asset manifest: ${ASSET_MANIFEST_PATH}`);
  assertFingerprint(fs.existsSync(tarballPath), `missing SDK tarball: ${TARBALL_PATH}`);

  const fingerprint = readJson(fingerprintPath);
  const assetManifest = readJson(assetManifestPath);
  const expectedBasePath = normalizeBasePath(fingerprint.sdkPackage?.basePath || DEFAULT_SDK_BASE_PATH);

  assertFingerprint(fingerprint.schemaVersion === 2, "fingerprint schemaVersion must be 2");
  assert(fingerprint.releaseDecision?.status === "internal-release-ready", "release decision must be internal release ready");
  assertFingerprint(assetManifest.basePath === expectedBasePath, "SDK package base path mismatch between manifest and fingerprint");
  assertFingerprint(
    assetManifest.assets.systemWasm.sha256 === sha256File(path.join(packageRoot, "assets/system_wasm.wasm")),
    "SDK wasm fingerprint mismatch"
  );
  assertFingerprint(
    assetManifest.assets.systemWorker.sha256 === sha256File(path.join(packageRoot, "workers/system-worker.ts")),
    "SDK system worker fingerprint mismatch"
  );
  assertFingerprint(
    assetManifest.assets.processWorker.sha256 === sha256File(path.join(packageRoot, "workers/process-worker.ts")),
    "SDK process worker fingerprint mismatch"
  );
  assertFingerprint(
    assetManifest.assets.yarnClassicFactory?.sha256 === sha256File(path.join(packageRoot, "vendor/yarn-cli-1.22.22.mjs")),
    "SDK Yarn Classic factory fingerprint mismatch"
  );
  assertFingerprint(
    assetManifest.assets.nextCliFactory?.sha256 === sha256File(path.join(packageRoot, "vendor/next-cli-15.5.26.mjs")),
    "SDK Next.js factory fingerprint mismatch"
  );
  assertFingerprint(
    fingerprint.sdkPackage.assetManifestSha256 === sha256File(assetManifestPath),
    "asset manifest fingerprint mismatch"
  );
  assertFingerprint(
    fingerprint.sdkPackage.systemWasmSha256 === assetManifest.assets.systemWasm.sha256,
    "system wasm fingerprint mismatch"
  );
  assertFingerprint(
    fingerprint.sdkPackage.systemWorkerSha256 === assetManifest.assets.systemWorker.sha256,
    "system worker fingerprint field mismatch"
  );
  assertFingerprint(
    fingerprint.sdkPackage.processWorkerSha256 === assetManifest.assets.processWorker.sha256,
    "process worker fingerprint field mismatch"
  );
  assertFingerprint(
    fingerprint.sdkPackage.yarnClassicFactorySha256 === assetManifest.assets.yarnClassicFactory.sha256,
    "Yarn Classic factory fingerprint field mismatch"
  );
  assertFingerprint(
    fingerprint.sdkPackage.nextCliFactorySha256 === assetManifest.assets.nextCliFactory.sha256,
    "Next.js factory fingerprint field mismatch"
  );
  assertFingerprint(
    fingerprint.sdkPackage.tarballSha256 === sha256File(tarballPath),
    "SDK tarball fingerprint mismatch"
  );
  assertFingerprint(fingerprint.sdkPackage.tarballPath === TARBALL_PATH, "SDK tarball path mismatch");

  return { fingerprint, assetManifest };
}
