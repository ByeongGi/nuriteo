import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { spawnSync } from "node:child_process";

import { CliRegistry, applyPnpmStorePlan, createPackageScriptRunner, createPnpmRunner, createPnpmStorePlan, InstallTransactionInterruptedError } from "../../../packages/node-runtime/src/index.ts";

const root = new URL("../../..", import.meta.url).pathname;
const fixture = path.join(root, "tests/fixtures/package-managers/pnpm");
const installed = JSON.parse(fs.readFileSync(new URL("../../../vendor/cli/pnpm/9.15.9/installed.json", import.meta.url), "utf8"));
const registry = new CliRegistry([installed]);
const workdir = fs.mkdtempSync(path.join(os.tmpdir(), "pnpm-store-plan-"));

try {
  fs.cpSync(fixture, workdir, {
    recursive: true,
    filter(current) {
      return !current.includes(`${path.sep}node_modules${path.sep}`) && !current.endsWith(`${path.sep}node_modules`);
    }
  });

  const storeDir = path.join(workdir, ".pnpm-store");
  const pnpm = createPnpmRunner({
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
  const frozen = pnpm.install(workdir, ["--frozen-lockfile", "--ignore-scripts", "--store-dir", storeDir]);
  assert.equal(frozen.exitCode, 0, frozen.stderr);

  const plan = createPnpmStorePlan({
    cwd: workdir,
    storeDir,
    reader: {
      readText(file) {
        return fs.readFileSync(file, "utf8");
      },
      listDir(dir) {
        return fs.readdirSync(dir, { withFileTypes: true })
          .filter((entry) => entry.isDirectory())
          .map((entry) => entry.name);
      }
    }
  });

  assert.equal(plan.packageManager, "pnpm@9.15.9");
  assert.equal(plan.storeDir, storeDir);
  assert.equal(plan.virtualStoreDir, path.join(workdir, "node_modules/.pnpm"));
  assert.equal(plan.frozenLockfile.valid, true);
  assert.deepEqual(plan.frozenLockfile.missingLinks, []);
  assert.deepEqual(plan.workspacePackages.map((pkg) => pkg.name), [
    "fixture-bin",
    "fixture-optional",
    "fixture-peer-consumer",
    "fixture-peer-provider"
  ]);
  assert.deepEqual(plan.rootLinks.map((link) => link.name), [
    "fixture-bin",
    "fixture-optional",
    "fixture-peer-consumer",
    "fixture-peer-provider"
  ]);

  for (const link of plan.rootLinks) {
    assert.equal(link.strategy, "symlink");
    assert.equal(fs.existsSync(path.join(workdir, "node_modules", link.name)), true);
    assert.equal(path.relative(workdir, link.targetPath).startsWith("packages/"), true);
  }

  const fixtureBin = plan.rootLinks.find((link) => link.name === "fixture-bin");
  assert.ok(fixtureBin);
  assert.deepEqual(fixtureBin.binLinks, [{
    name: "fixture-hello",
    targetPath: path.join(workdir, "packages/fixture-bin/bin/fixture-hello.js"),
    linkPath: path.join(workdir, "node_modules/.bin/fixture-hello")
  }]);
  assert.equal(fs.existsSync(fixtureBin.binLinks[0].linkPath), true);

  fs.rmSync(path.join(workdir, "node_modules"), { recursive: true, force: true });
  const copyFallbackPlan = createPnpmStorePlan({
    cwd: workdir,
    storeDir,
    linkStrategy: "copy-fallback",
    reader: {
      readText(file) {
        return fs.readFileSync(file, "utf8");
      },
      listDir(dir) {
        return fs.readdirSync(dir, { withFileTypes: true })
          .filter((entry) => entry.isDirectory())
          .map((entry) => entry.name);
      }
    }
  });
  const applied = applyPnpmStorePlan(copyFallbackPlan, {
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
  assert.equal(applied.packageLinks.length, 4);
  assert.equal(applied.binLinks.length, 1);
  assert.equal(fs.existsSync(path.join(workdir, "node_modules/fixture-bin/package.json")), true);
  assert.equal(fs.existsSync(path.join(workdir, "node_modules/.bin/fixture-hello")), true);
  assert.equal(fs.existsSync(path.join(workdir, "node_modules/.pnpm/browser-native-plan.json")), true);

  fs.rmSync(path.join(workdir, "node_modules"), { recursive: true, force: true });
  assert.throws(
    () => applyPnpmStorePlan(copyFallbackPlan, installWriter(), { failAfterOperations: 3 }),
    (error) => error instanceof InstallTransactionInterruptedError && error.code === "EINSTALLINTERRUPTED"
  );
  assert.equal(applyPnpmStorePlan(copyFallbackPlan, installWriter()).transaction.completed, true);
  assert.equal(fs.existsSync(path.join(workdir, "node_modules/.pnpm/browser-native-plan.json")), true);

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

console.log("pnpm store plan test ok");

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
