import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { spawnSync } from "node:child_process";

import { applyNpmInstallPlan, CliRegistry, createNpmInstallPlan, createNpmRunner, createPackageScriptRunner, InstallTransactionInterruptedError } from "../../../packages/node-runtime/src/index.ts";

const root = new URL("../../..", import.meta.url).pathname;
const fixture = path.join(root, "tests/fixtures/package-managers/npm");
const installed = JSON.parse(fs.readFileSync(new URL("../../../vendor/cli/npm/10.9.2/installed.json", import.meta.url), "utf8"));
const registry = new CliRegistry([installed]);
const workdir = fs.mkdtempSync(path.join(os.tmpdir(), "npm-install-plan-"));

try {
  fs.cpSync(fixture, workdir, {
    recursive: true,
    filter(current) {
      return !current.includes(`${path.sep}node_modules${path.sep}`) && !current.endsWith(`${path.sep}node_modules`);
    }
  });

  const npm = createNpmRunner({
    registry,
    processRunner({ entry, cwd, args, env }) {
      const result = spawnSync(process.execPath, [entry.entry, ...args], {
        cwd,
        env: { ...process.env, ...env },
        encoding: "utf8"
      });
      return {
        stdout: result.stdout,
        stderr: result.stderr,
        exitCode: result.status ?? 1,
        entry: entry.entry,
        entrySha256: entry.entrySha256,
        args,
        cwd,
        runtime: "host-node-test-helper"
      };
    }
  });
  const native = npm.install(workdir, ["--ignore-scripts"]);
  assert.equal(native.exitCode, 0, native.stderr);

  const plan = createNpmInstallPlan({
    cwd: workdir,
    linkStrategy: "copy-fallback",
    reader: {
      readText(file) {
        return fs.readFileSync(file, "utf8");
      }
    }
  });

  assert.equal(plan.packageManager, "npm");
  assert.equal(plan.lockfileVersion, 3);
  assert.equal(plan.frozenLockfile.valid, true);
  assert.deepEqual(plan.frozenLockfile.missingLinks, []);
  assert.deepEqual(plan.rootDependencies, [
    "fixture-bin",
    "fixture-optional",
    "fixture-peer-consumer",
    "fixture-peer-provider"
  ]);

  fs.rmSync(path.join(workdir, "node_modules"), { recursive: true, force: true });
  const applied = applyNpmInstallPlan(plan, {
    mkdir(directory) {
      fs.mkdirSync(directory, { recursive: true });
    },
    copyDirectory(source, target) {
      fs.cpSync(source, target, { recursive: true });
    },
    copyFile(source, target) {
      fs.mkdirSync(path.dirname(target), { recursive: true });
      fs.copyFileSync(source, target);
    },
    writeText(file, data) {
      fs.mkdirSync(path.dirname(file), { recursive: true });
      fs.writeFileSync(file, data);
    }
  });

  assert.equal(applied.links.length, 4);
  assert.equal(applied.binLinks.length, 1);
  assert.equal(fs.existsSync(path.join(workdir, "node_modules/fixture-bin/package.json")), true);
  assert.equal(fs.existsSync(path.join(workdir, "node_modules/.bin/fixture-hello")), true);

  fs.rmSync(path.join(workdir, "node_modules"), { recursive: true, force: true });
  assert.throws(
    () => applyNpmInstallPlan(plan, installWriter(), { failAfterOperations: 2 }),
    (error) => error instanceof InstallTransactionInterruptedError && error.code === "EINSTALLINTERRUPTED"
  );
  assert.equal(applyNpmInstallPlan(plan, installWriter()).transaction.completed, true);
  assert.equal(fs.existsSync(path.join(workdir, "node_modules/fixture-peer-provider/package.json")), true);

  const scripts = createPackageScriptRunner({
    cwd: workdir,
    reader: fileReader(),
    writer: fileWriter()
  });
  assert.equal(scripts.runLifecycle(path.join(workdir, "node_modules/fixture-optional"), "install").exitCode, 0);
  assert.equal(scripts.runScript("build").stdout.trim(), "consumer:provider");
  assert.equal(scripts.runScript("lifecycle-test").stdout.trim(), "fixture-optional:installed");
  assert.equal(scripts.execBin("fixture-hello").stdout.trim(), "fixture-bin:hello");
} finally {
  fs.rmSync(workdir, { recursive: true, force: true });
}

function installWriter() {
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

console.log("npm install plan test ok");

function fileReader() {
  return {
    exists(file) {
      return fs.existsSync(file);
    },
    readText(file) {
      return fs.readFileSync(file, "utf8");
    }
  };
}

function fileWriter() {
  return {
    writeText(file, data) {
      fs.mkdirSync(path.dirname(file), { recursive: true });
      fs.writeFileSync(file, data);
    }
  };
}
