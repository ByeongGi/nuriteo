import assert from "node:assert/strict";
import crypto from "node:crypto";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { spawnSync } from "node:child_process";

import { CliRegistry, createPnpmRunner } from "../../../packages/node-runtime/src/index.ts";

const root = new URL("../../..", import.meta.url).pathname;
const fixture = path.join(root, "tests/fixtures/package-managers/pnpm");
const installed = ["pnpm"].map((name) => JSON.parse(fs.readFileSync(path.join(root, `vendor/cli/${name}/9.15.9/installed.json`), "utf8")));
const registry = new CliRegistry(installed);
const pnpm = createPnpmRunner({
  registry,
  processRunner({ entry, cwd, args, env }) {
    return runNativePnpm(entry, cwd, args, env);
  }
});

const workdir = fs.mkdtempSync(path.join(os.tmpdir(), "pnpm-fixture-"));
try {
  copyFixture(fixture, workdir);

  const lockfile = path.join(workdir, "pnpm-lock.yaml");
  const storeDir = path.join(workdir, ".pnpm-store");
  const beforeLockHash = sha256File(lockfile);

  const frozen = pnpm.install(workdir, ["--frozen-lockfile", "--ignore-scripts", "--store-dir", storeDir]);
  assert.equal(frozen.exitCode, 0, frozen.stderr);
  assert.equal(sha256File(lockfile), beforeLockHash);
  assert.equal(fs.existsSync(storeDir), true);

  fs.rmSync(path.join(workdir, "node_modules"), { recursive: true, force: true });
  const install = pnpm.install(workdir, ["--frozen-lockfile", "--store-dir", storeDir]);
  assert.equal(install.exitCode, 0, install.stderr);
  assert.equal(sha256File(lockfile), beforeLockHash);

  const build = pnpm.runScript(workdir, "build");
  assert.equal(build.exitCode, 0, build.stderr);
  assert.match(build.stdout, /consumer:provider/);

  const lifecycle = pnpm.runScript(workdir, "lifecycle-test");
  assert.equal(lifecycle.exitCode, 0, lifecycle.stderr);
  assert.match(lifecycle.stdout, /fixture-optional:installed/);

  const exec = pnpm.exec(workdir, "fixture-hello");
  assert.equal(exec.exitCode, 0, exec.stderr);
  assert.equal(exec.stdout.trim(), "fixture-bin:hello");

  const interrupted = runNativePnpm(registry.resolve("pnpm"), workdir, ["install", "--frozen-lockfile"], { PNPM_FIXTURE_DELAY_PREINSTALL: "1" }, { timeout: 100 });
  assert.equal(interrupted.error?.code, "ETIMEDOUT");
  fs.rmSync(path.join(workdir, "node_modules"), { recursive: true, force: true });
  const recovered = pnpm.install(workdir, ["--frozen-lockfile", "--store-dir", storeDir, "--offline"]);
  assert.equal(recovered.exitCode, 0, recovered.stderr);
  assert.equal(sha256File(lockfile), beforeLockHash);
} finally {
  fs.rmSync(workdir, { recursive: true, force: true });
}

console.log("pnpm integration test ok");

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

function runNativePnpm(entry, cwd, args, env = {}, options = {}) {
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

