import assert from "node:assert/strict";
import fs from "node:fs";
import { spawnSync } from "node:child_process";

import { CliRegistry, createGuestRuntimeProcessRunner, createPnpmRunner } from "../../packages/node-runtime/src/index.ts";

const root = new URL("../..", import.meta.url).pathname;
const installed = JSON.parse(fs.readFileSync(new URL("../../vendor/cli/pnpm/9.15.9/installed.json", import.meta.url), "utf8"));
const registry = new CliRegistry([installed]);
const pnpm = createPnpmRunner({
  registry,
  processRunner: createGuestRuntimeProcessRunner({
    artifacts: {
      readText(path) {
        return fs.readFileSync(path, "utf8");
      }
    }
  })
});

const native = spawnSync(process.execPath, [installed.entry, "--version"], {
  cwd: root,
  encoding: "utf8"
});
assert.equal(native.status, 0, native.stderr);

const result = pnpm.version("/workspace");
assert.equal(result.runtime, "browser-guest-node-runtime");
assert.equal(result.bootMode, "artifact-entry-preflight");
assert.equal(result.commandKind, "version");
assert.equal(result.exitCode, native.status);
assert.equal(result.stdout, native.stdout);
assert.equal(result.stderr, native.stderr);
assert.equal(result.stdout.trim(), installed.version);
assert.equal(result.entry, installed.entry);
assert.equal(result.entrySha256, installed.entrySha256);
assert.deepEqual(result.args, ["--version"]);
assert.equal(result.cwd, "/workspace");

const exec = pnpm.exec("/workspace", "vite", ["--version"]);
assert.equal(exec.runtime, "browser-guest-node-runtime");
assert.equal(exec.bootMode, "blocked-real-cli-evaluation");
assert.equal(exec.commandKind, "exec");
assert.equal(exec.exitCode, 1);
assert.equal(exec.error.code, "ERR_PM_REAL_CLI_EVALUATION_REQUIRED");
assert.match(exec.error.nextAction, /host-node-test-helper/);

console.log("pnpm guest runtime boot test ok");
