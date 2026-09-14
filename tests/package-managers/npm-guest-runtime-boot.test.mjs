import assert from "node:assert/strict";
import fs from "node:fs";
import { spawnSync } from "node:child_process";

import { CliRegistry, createGuestRuntimeProcessRunner, createNpmRunner } from "../../packages/node-runtime/src/index.ts";

const root = new URL("../..", import.meta.url).pathname;
const installed = JSON.parse(fs.readFileSync(new URL("../../vendor/cli/npm/10.9.2/installed.json", import.meta.url), "utf8"));
const registry = new CliRegistry([installed]);
const npm = createNpmRunner({
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

const result = npm.version("/workspace");
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

const install = npm.install("/workspace", ["--ignore-scripts"]);
assert.equal(install.runtime, "browser-guest-node-runtime");
assert.equal(install.bootMode, "blocked-real-cli-evaluation");
assert.equal(install.commandKind, "install");
assert.equal(install.exitCode, 1);
assert.equal(install.error.code, "ERR_PM_REAL_CLI_EVALUATION_REQUIRED");
assert.match(install.error.nextAction, /browser guest runtime/);

console.log("npm guest runtime boot test ok");
