import assert from "node:assert/strict";
import crypto from "node:crypto";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { spawnSync } from "node:child_process";

import { CliRegistry, createNpmRunner } from "../../../packages/node-runtime/src/index.ts";

const root = new URL("../../..", import.meta.url).pathname;
const fixture = path.join(root, "tests/fixtures/package-managers/npm");
const installed = ["npm"].map((name) => JSON.parse(fs.readFileSync(path.join(root, `vendor/cli/${name}/10.9.2/installed.json`), "utf8")));
const registry = new CliRegistry(installed);
const npm = createNpmRunner({
  registry,
  processRunner({ entry, cwd, args, env }) {
    return runNativeNpm(entry, cwd, args, env);
  }
});

const workdir = fs.mkdtempSync(path.join(os.tmpdir(), "npm-fixture-"));
try {
  copyFixture(fixture, workdir);

  const lockfile = path.join(workdir, "package-lock.json");
  const cacheDir = path.join(workdir, ".npm-cache");
  const beforeLockHash = sha256File(lockfile);
  const install = npm.install(workdir, ["--ignore-scripts", "--cache", cacheDir]);
  assert.equal(install.exitCode, 0, install.stderr);
  assert.equal(sha256File(lockfile), beforeLockHash);
  assert.equal(fs.existsSync(cacheDir), true);

  fs.rmSync(path.join(workdir, "node_modules"), { recursive: true, force: true });
  const ci = npm.ci(workdir, ["--cache", cacheDir]);
  assert.equal(ci.exitCode, 0, ci.stderr);
  assert.equal(sha256File(lockfile), beforeLockHash);

  const build = npm.runScript(workdir, "build");
  assert.equal(build.exitCode, 0, build.stderr);
  assert.match(build.stdout, /consumer:provider/);

  const lifecycle = npm.runScript(workdir, "lifecycle-test");
  assert.equal(lifecycle.exitCode, 0, lifecycle.stderr);
  assert.match(lifecycle.stdout, /fixture-optional:installed/);

  const exec = npm.exec(workdir, "fixture-hello");
  assert.equal(exec.exitCode, 0, exec.stderr);
  assert.equal(exec.stdout.trim(), "fixture-bin:hello");

  const strictPeer = npm.install(workdir, ["--strict-peer-deps", "--cache", cacheDir]);
  assert.equal(strictPeer.exitCode, 0, strictPeer.stderr);

  const interrupted = runNativeNpm(registry.resolve("npm"), workdir, ["ci"], { NPM_FIXTURE_DELAY_PREINSTALL: "1" }, { timeout: 100 });
  assert.equal(interrupted.error?.code, "ETIMEDOUT");
  fs.rmSync(path.join(workdir, "node_modules"), { recursive: true, force: true });
  const recovered = npm.ci(workdir, ["--cache", cacheDir, "--prefer-offline"]);
  assert.equal(recovered.exitCode, 0, recovered.stderr);
  assert.equal(sha256File(lockfile), beforeLockHash);
} finally {
  fs.rmSync(workdir, { recursive: true, force: true });
}

console.log("npm integration test ok");

function sha256File(file) {
  return crypto.createHash("sha256").update(fs.readFileSync(file)).digest("hex");
}

function copyFixture(source, target) {
  fs.cpSync(source, target, {
    recursive: true,
    filter(current) {
      return !current.includes(`${path.sep}node_modules${path.sep}`) && !current.endsWith(`${path.sep}node_modules`);
    }
  });
}

function runNativeNpm(entry, cwd, args, env = {}, options = {}) {
  const result = spawnSync(process.execPath, [entry.entry, ...args], {
    cwd,
    env: { ...process.env, ...env },
    encoding: "utf8",
    timeout: options.timeout
  });
  return {
    stdout: result.stdout,
    stderr: result.stderr,
    exitCode: result.status ?? 1,
    signal: result.signal,
    error: result.error,
    args
  };
}
