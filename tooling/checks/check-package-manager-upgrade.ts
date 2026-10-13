import crypto from "node:crypto";
import { spawnSync } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";

const root = process.cwd();
const tarballDir = process.env.PM_REHEARSAL_TARBALL_DIR || "/private/tmp/pm-upgrade-rehearsal";
const manifestsDir = path.join(root, "vendor/manifests");

function readJson(file) {
  return JSON.parse(fs.readFileSync(file, "utf8"));
}

function sha256(file) {
  return crypto.createHash("sha256").update(fs.readFileSync(file)).digest("hex");
}

function assert(condition, message) {
  if (!condition) throw new Error(message);
}

function extract(tarball, prefix) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), prefix));
  const result = spawnSync("tar", ["-xzf", tarball, "-C", dir], { encoding: "utf8" });
  assert(result.status === 0, `tar extract failed: ${result.stderr || result.stdout}`);
  return dir;
}

function candidateTarball(manager, candidate) {
  return path.join(tarballDir, `${manager}-${candidate.version}.tgz`);
}

function promotedManifest(base, candidate) {
  return {
    ...base,
    version: candidate.version,
    source: candidate.source,
    integrity: candidate.integrity,
    license: candidate.license,
    entry: candidate.entry,
    tarballSha256: candidate.tarballSha256
  };
}

function writeTempManifestDir(manager, manifest) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), `${manager}-manifest-`));
  for (const name of ["npm", "pnpm"]) {
    const source = path.join(manifestsDir, `${name}.json`);
    const target = path.join(dir, `${name}.json`);
    fs.copyFileSync(source, target);
  }
  fs.writeFileSync(path.join(dir, `${manager}.json`), `${JSON.stringify(manifest, null, 2)}\n`);
  return dir;
}

function validateCommon(manager, manifest) {
  const candidate = manifest.rehearsalCandidate;
  const rollback = manifest.rollbackArtifact;
  assert(candidate, `${manager} rehearsalCandidate is required`);
  assert(rollback, `${manager} rollbackArtifact is required`);
  assert(candidate.version !== manifest.version, `${manager} candidate must differ from baseline`);
  assert(rollback.version === manifest.version, `${manager} rollback version must match baseline`);
  assert(rollback.source === manifest.source, `${manager} rollback source must match baseline`);
  assert(rollback.tarballSha256 === manifest.tarballSha256, `${manager} rollback hash must match baseline`);
  assert(candidate.status === "rehearsed-not-promoted", `${manager} candidate must not be promoted`);

  const tarball = candidateTarball(manager, candidate);
  assert(fs.existsSync(tarball), `${manager} candidate tarball missing: ${tarball}`);
  assert(sha256(tarball) === candidate.tarballSha256, `${manager} candidate tarball hash mismatch`);

  const extracted = extract(tarball, `${manager}-candidate-`);
  const packageRoot = path.join(extracted, "package");
  const packageJson = readJson(path.join(packageRoot, "package.json"));
  assert(packageJson.name === manager, `${manager} package name mismatch`);
  assert(packageJson.version === candidate.version, `${manager} package version mismatch`);
  assert(packageJson.license === candidate.license, `${manager} package license mismatch`);
  assert(fs.existsSync(path.join(extracted, candidate.entry.replace(/^\//, ""))), `${manager} candidate entry missing`);
  return { candidate, extracted };
}

function validateNpm(manifest) {
  const { candidate } = validateCommon("npm", manifest);
  const tempManifestDir = writeTempManifestDir("npm", promotedManifest(manifest, candidate));
  const tempVendorDir = fs.mkdtempSync(path.join(os.tmpdir(), "npm-candidate-vendor-"));
  const vendor = spawnSync(process.execPath, [
    "tooling/generators/vendor-cli.ts",
    "--manifest-dir",
    tempManifestDir,
    "--from-tarballs",
    tarballDir,
    "--out-dir",
    tempVendorDir,
    "npm"
  ], { cwd: root, encoding: "utf8" });
  assert(vendor.status === 0, `npm candidate vendor failed: ${vendor.stderr || vendor.stdout}`);
  const installed = JSON.parse(vendor.stdout).installed[0];
  const version = spawnSync(process.execPath, [installed.entry, "--version"], { encoding: "utf8" });
  assert(version.status === 0, `npm candidate version failed: ${version.stderr || version.stdout}`);
  assert(version.stdout.trim() === candidate.version, "npm candidate executable version mismatch");
}

function validatePnpm(manifest) {
  const { candidate, extracted } = validateCommon("pnpm", manifest);
  assert(candidate.runtimeDecision === "hold-browser-promotion", "pnpm 12 candidate must stay on browser promotion hold");
  const placeholder = fs.readFileSync(path.join(extracted, candidate.entry.replace(/^\//, "")), "utf8");
  const nodeWrapper = fs.readFileSync(path.join(extracted, "package/bin/pnpm.mjs"), "utf8");
  assert(placeholder.includes("exec node"), "pnpm candidate no longer uses the expected shell handoff");
  assert(nodeWrapper.includes("node:child_process"), "pnpm candidate wrapper must expose child_process/native-binary pressure");
  assert(nodeWrapper.includes("nativeBinary"), "pnpm candidate wrapper must expose native-binary pressure");
}

const npmManifest = readJson(path.join(manifestsDir, "npm.json"));
const pnpmManifest = readJson(path.join(manifestsDir, "pnpm.json"));

validateNpm(npmManifest);
validatePnpm(pnpmManifest);

console.log(`package manager upgrade rehearsal ok: npm ${npmManifest.version} -> ${npmManifest.rehearsalCandidate.version}; pnpm ${pnpmManifest.version} -> ${pnpmManifest.rehearsalCandidate.version} held`);
