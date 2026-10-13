import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import { spawnSync } from "node:child_process";

import { CliRegistry, createGuestRuntimeProcessRunner, createNpmRunner, MemoryPackageManagerWorkspace } from "../../../packages/node-runtime/src/index.ts";

const root = new URL("../../..", import.meta.url).pathname;
const fixture = path.join(root, "tests/fixtures/package-managers/npm");
const installed = JSON.parse(fs.readFileSync(new URL("../../../vendor/cli/npm/10.9.2/installed.json", import.meta.url), "utf8"));
const registry = new CliRegistry([installed]);
const resolvedEntry = registry.resolve("npm");
const workdir = "/workspace";
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
assert.equal(result.entry, resolvedEntry.entry);
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

const workspace = new MemoryPackageManagerWorkspace(readFixtureMounts(fixture, workdir));
const guestInstallNpm = createNpmRunner({
  registry,
  processRunner: createGuestRuntimeProcessRunner({
    artifacts: {
      readText(file) {
        return fs.readFileSync(file, "utf8");
      }
    },
    workspace: {
      linkStrategy: "copy-fallback",
      reader: workspace,
      writer: workspace
    }
  })
});
const guestInstall = guestInstallNpm.install(workdir, ["--ignore-scripts"]);
assert.equal(guestInstall.runtime, "browser-guest-node-runtime");
assert.equal(guestInstall.bootMode, "install-plan-application");
assert.equal(guestInstall.commandKind, "install");
assert.equal(guestInstall.exitCode, 0, guestInstall.stderr);
assert.equal(workspace.exists(`${workdir}/node_modules/fixture-bin/package.json`), true);
assert.equal(workspace.exists(`${workdir}/node_modules/.bin/fixture-hello`), true);

const build = guestInstallNpm.runScript(workdir, "build");
assert.equal(build.runtime, "browser-guest-node-runtime");
assert.equal(build.bootMode, "script-runner-application");
assert.equal(build.commandKind, "run-script");
assert.equal(build.exitCode, 0, build.stderr);
assert.equal(build.stdout.trim(), "consumer:provider");

const bin = guestInstallNpm.exec(workdir, "fixture-hello");
assert.equal(bin.runtime, "browser-guest-node-runtime");
assert.equal(bin.bootMode, "script-runner-application");
assert.equal(bin.commandKind, "exec");
assert.equal(bin.exitCode, 0, bin.stderr);
assert.equal(bin.stdout.trim(), "fixture-bin:hello");

const ciWorkspace = new MemoryPackageManagerWorkspace(readFixtureMounts(fixture, workdir));
const guestCiNpm = createNpmRunner({
  registry,
  processRunner: createGuestRuntimeProcessRunner({
    artifacts: {
      readText(file) {
        return fs.readFileSync(file, "utf8");
      }
    },
    workspace: {
      linkStrategy: "copy-fallback",
      reader: ciWorkspace,
      writer: ciWorkspace
    }
  })
});
const guestCi = guestCiNpm.ci(workdir, []);
assert.equal(guestCi.runtime, "browser-guest-node-runtime");
assert.equal(guestCi.bootMode, "install-plan-application");
assert.equal(guestCi.commandKind, "ci");
assert.equal(guestCi.exitCode, 0, guestCi.stderr);
assert.equal(ciWorkspace.exists(`${workdir}/node_modules/fixture-peer-provider/package.json`), true);

const lifecycle = guestCiNpm.runScript(workdir, "lifecycle-test");
assert.equal(lifecycle.runtime, "browser-guest-node-runtime");
assert.equal(lifecycle.bootMode, "script-runner-application");
assert.equal(lifecycle.commandKind, "run-script");
assert.equal(lifecycle.exitCode, 0, lifecycle.stderr);
assert.equal(lifecycle.stdout.trim(), "fixture-optional:installed");

console.log("npm guest runtime boot test ok");

function readFixtureMounts(source, target) {
  const mounts = [];
  for (const entry of fs.readdirSync(source, { withFileTypes: true })) {
    const sourcePath = path.join(source, entry.name);
    const targetPath = `${target}/${entry.name}`;
    if (entry.name === "node_modules") continue;
    if (entry.isDirectory()) {
      mounts.push(...readFixtureMounts(sourcePath, targetPath));
    } else if (entry.isFile()) {
      mounts.push({
        path: targetPath,
        data: fs.readFileSync(sourcePath, "utf8")
      });
    }
  }
  return mounts;
}
