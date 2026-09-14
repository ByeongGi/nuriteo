import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { spawnSync } from "node:child_process";

import { CliRegistry, createGuestRuntimeProcessRunner, createPnpmRunner } from "../../packages/node-runtime/src/index.ts";

const root = new URL("../..", import.meta.url).pathname;
const fixture = path.join(root, "tests/fixtures/package-managers/pnpm");
const installed = JSON.parse(fs.readFileSync(new URL("../../vendor/cli/pnpm/9.15.9/installed.json", import.meta.url), "utf8"));
const registry = new CliRegistry([installed]);
const workdir = fs.mkdtempSync(path.join(os.tmpdir(), "pnpm-guest-runtime-"));
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

try {
  copyFixture(fixture, workdir);
  const guestInstallPnpm = createPnpmRunner({
    registry,
    processRunner: createGuestRuntimeProcessRunner({
      artifacts: {
        readText(file) {
          return fs.readFileSync(file, "utf8");
        }
      },
      workspace: {
        linkStrategy: "copy-fallback",
        reader: {
          readText(file) {
            return fs.readFileSync(file, "utf8");
          },
          listDir(file) {
            return fs.readdirSync(file);
          }
        },
        writer: fsWorkspaceWriter()
      }
    })
  });
  const guestInstall = guestInstallPnpm.install(workdir, ["--frozen-lockfile"]);
  assert.equal(guestInstall.runtime, "browser-guest-node-runtime");
  assert.equal(guestInstall.bootMode, "install-plan-application");
  assert.equal(guestInstall.commandKind, "install");
  assert.equal(guestInstall.exitCode, 0, guestInstall.stderr);
  assert.equal(fs.existsSync(path.join(workdir, "node_modules/fixture-bin/package.json")), true);
  assert.equal(fs.existsSync(path.join(workdir, "node_modules/.bin/fixture-hello")), true);
}
finally {
  fs.rmSync(workdir, { recursive: true, force: true });
}

console.log("pnpm guest runtime boot test ok");

function copyFixture(source, target) {
  fs.cpSync(source, target, {
    recursive: true,
    filter(current) {
      return !current.includes(`${path.sep}node_modules${path.sep}`) && !current.endsWith(`${path.sep}node_modules`);
    }
  });
}

function fsWorkspaceWriter() {
  return {
    mkdir(directory) {
      fs.mkdirSync(directory, { recursive: true });
    },
    copyDirectory(source, target) {
      fs.cpSync(source, target, { recursive: true, force: true });
    },
    copyFile(source, target) {
      fs.mkdirSync(path.dirname(target), { recursive: true });
      fs.copyFileSync(source, target);
    },
    writeText(file, data) {
      fs.mkdirSync(path.dirname(file), { recursive: true });
      fs.writeFileSync(file, data);
    }
  };
}
