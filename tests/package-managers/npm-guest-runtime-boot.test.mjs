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
assert.equal(result.exitCode, native.status);
assert.equal(result.stdout, native.stdout);
assert.equal(result.stderr, native.stderr);
assert.equal(result.stdout.trim(), installed.version);
assert.equal(result.entry, installed.entry);
assert.equal(result.entrySha256, installed.entrySha256);
assert.deepEqual(result.args, ["--version"]);
assert.equal(result.cwd, "/workspace");

console.log("npm guest runtime boot test ok");
