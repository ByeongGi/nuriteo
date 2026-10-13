import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";

import { createMemoryOpfs, createOpfsPackageWorkspace } from "../../browser-host/src/index.ts";
import { CliRegistry, createGuestRuntimeProcessRunner, createNpmRunner, createPnpmRunner } from "../../node-runtime/src/index.ts";

const root = new URL("../../..", import.meta.url).pathname;
const npmInstalled = JSON.parse(fs.readFileSync(new URL("../../../vendor/cli/npm/10.9.2/installed.json", import.meta.url), "utf8"));
const pnpmInstalled = JSON.parse(fs.readFileSync(new URL("../../../vendor/cli/pnpm/9.15.9/installed.json", import.meta.url), "utf8"));
const registry = new CliRegistry([npmInstalled, pnpmInstalled]);

const npmWorkspace = createOpfsPackageWorkspace({ opfs: createMemoryOpfs(), root: "npm-project" });
mountFixture(path.join(root, "tests/fixtures/package-managers/npm"), "/workspace", npmWorkspace);
const npm = createNpmRunner({
  registry,
  processRunner: createGuestRuntimeProcessRunner({
    artifacts: {
      readText(file) {
        return fs.readFileSync(file, "utf8");
      }
    },
    workspace: {
      linkStrategy: "copy-fallback",
      reader: npmWorkspace,
      writer: npmWorkspace
    }
  })
});
const npmInstall = npm.install("/workspace", ["--ignore-scripts"]);
assert.equal(npmInstall.bootMode, "install-plan-application");
assert.equal(npmWorkspace.exists("/workspace/node_modules/fixture-bin/package.json"), true);
assert.equal(npmWorkspace.exists("/workspace/node_modules/.bin/fixture-hello"), true);
npmWorkspace.symlink("/workspace/packages/fixture-bin", "/workspace/node_modules/fixture-bin-link");
assert.equal(npmWorkspace.readText("/workspace/node_modules/fixture-bin-link/package.json").includes("fixture-bin"), true);
npmWorkspace.remove("/workspace/node_modules");
assert.equal(npmWorkspace.exists("/workspace/node_modules/fixture-bin/package.json"), false);
assert.equal(npmWorkspace.exists("/workspace/node_modules/.bin/fixture-hello"), false);

const pnpmWorkspace = createOpfsPackageWorkspace({ opfs: createMemoryOpfs(), root: "pnpm-project" });
mountFixture(path.join(root, "tests/fixtures/package-managers/pnpm"), "/workspace", pnpmWorkspace);
const pnpm = createPnpmRunner({
  registry,
  processRunner: createGuestRuntimeProcessRunner({
    artifacts: {
      readText(file) {
        return fs.readFileSync(file, "utf8");
      }
    },
    workspace: {
      linkStrategy: "copy-fallback",
      reader: pnpmWorkspace,
      writer: pnpmWorkspace
    }
  })
});
const pnpmInstall = pnpm.install("/workspace", ["--frozen-lockfile"]);
assert.equal(pnpmInstall.bootMode, "install-plan-application");
assert.deepEqual(pnpmWorkspace.listDir("/workspace/node_modules").sort(), [
  ".bin",
  ".pnpm",
  "fixture-bin",
  "fixture-optional",
  "fixture-peer-consumer",
  "fixture-peer-provider"
]);
assert.equal(pnpmWorkspace.exists("/workspace/node_modules/.pnpm/browser-native-plan.json"), true);

console.log("browser host package workspace test ok");

function mountFixture(source, target, workspace) {
  for (const entry of fs.readdirSync(source, { withFileTypes: true })) {
    const sourcePath = path.join(source, entry.name);
    const targetPath = `${target}/${entry.name}`;
    if (entry.name === "node_modules") continue;
    if (entry.isDirectory()) {
      workspace.mkdir(targetPath);
      mountFixture(sourcePath, targetPath, workspace);
    } else if (entry.isFile()) {
      workspace.writeText(targetPath, fs.readFileSync(sourcePath, "utf8"));
    }
  }
}
