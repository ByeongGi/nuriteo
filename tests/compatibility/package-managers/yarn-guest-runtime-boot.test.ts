import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";

import {
  applyYarnInstallPlan,
  CliRegistry,
  createGuestRuntimeProcessRunner,
  createYarnInstallPlan,
  createYarnRunner,
  InstallTransactionInterruptedError,
  MemoryPackageManagerWorkspace
} from "../../../packages/node-runtime/src/index.ts";

const fixture = path.resolve(new URL("../../fixtures/package-managers/npm", import.meta.url).pathname);
const workdir = "/workspace";
const entry = "/vendor/yarn/bin/yarn.js";
const installed = {
  name: "yarn",
  version: "1.22.22-candidate",
  entry
};
const registry = new CliRegistry([installed]);
const workspace = new MemoryPackageManagerWorkspace([
  ...readFixtureMounts(fixture, workdir),
  { path: `${workdir}/yarn.lock`, data: createYarnLock() }
]);
const yarn = createYarnRunner({
  registry,
  processRunner: createGuestRuntimeProcessRunner({
    artifacts: {
      readText(file) {
        if (file !== entry) throw new Error(`Unexpected artifact: ${file}`);
        return "#!/usr/bin/env node\nrequire(__dirname + '/../lib/cli');\n";
      }
    },
    workspace: {
      linkStrategy: "copy-fallback",
      reader: workspace,
      writer: workspace
    }
  })
});

const version = yarn.version(workdir);
assert.equal(version.exitCode, 0);
assert.equal(version.stdout, "1.22.22-candidate\n");
assert.equal(version.commandKind, "version");

const plan = createYarnInstallPlan({ cwd: workdir, reader: workspace, linkStrategy: "copy-fallback" });
assert.equal(plan.packageManager, "yarn");
assert.equal(plan.lockfileVersion, 1);
assert.equal(plan.frozenLockfile.valid, true);
assert.equal(plan.links.length, 4);

const install = yarn.install(workdir, ["--frozen-lockfile", "--ignore-scripts"]);
assert.equal(install.runtime, "browser-guest-node-runtime");
assert.equal(install.bootMode, "install-plan-application");
assert.equal(install.commandKind, "install");
assert.equal(install.exitCode, 0, install.stderr);
assert.match(install.stdout, /yarn install: applied 4 local file links and 1 bin links/);
assert.equal(workspace.exists(`${workdir}/node_modules/fixture-bin/package.json`), true);
assert.equal(workspace.exists(`${workdir}/node_modules/.bin/fixture-hello`), true);

const build = yarn.runScript(workdir, "build");
assert.equal(build.bootMode, "script-runner-application");
assert.equal(build.exitCode, 0, build.stderr);
assert.equal(build.stdout.trim(), "consumer:provider");

const bin = yarn.exec(workdir, "fixture-hello");
assert.equal(bin.bootMode, "script-runner-application");
assert.equal(bin.exitCode, 0, bin.stderr);
assert.equal(bin.stdout.trim(), "fixture-bin:hello");

workspace.writeText(`${workdir}/yarn.lock`, "# yarn lockfile v1\n");
const invalidPlan = createYarnInstallPlan({ cwd: workdir, reader: workspace });
assert.equal(invalidPlan.frozenLockfile.valid, false);
assert.deepEqual(invalidPlan.frozenLockfile.missingLinks.sort(), [
  "fixture-bin",
  "fixture-optional",
  "fixture-peer-consumer",
  "fixture-peer-provider"
]);

workspace.writeText(`${workdir}/yarn.lock`, createYarnLock());
const recoveryPlan = createYarnInstallPlan({ cwd: workdir, reader: workspace, linkStrategy: "copy-fallback" });
assert.throws(
  () => applyYarnInstallPlan(recoveryPlan, workspace, { failAfterOperations: 2 }),
  (error) => error instanceof InstallTransactionInterruptedError && error.code === "EINSTALLINTERRUPTED"
);
for (let iteration = 0; iteration < 50; iteration += 1) {
  const recovered = applyYarnInstallPlan(recoveryPlan, workspace);
  assert.equal(recovered.transaction.completed, true);
  assert.equal(workspace.exists(`${workdir}/node_modules/fixture-bin/package.json`), true);
}

console.log("yarn candidate guest runtime boot test ok");

function createYarnLock() {
  return [
    "# yarn lockfile v1",
    "",
    "fixture-bin@file:packages/fixture-bin:",
    '  version "1.0.0"',
    "fixture-optional@file:packages/fixture-optional:",
    '  version "1.0.0"',
    "fixture-peer-consumer@file:packages/fixture-peer-consumer:",
    '  version "1.0.0"',
    "fixture-peer-provider@file:packages/fixture-peer-provider:",
    '  version "1.0.0"',
    ""
  ].join("\n");
}

function readFixtureMounts(source, target) {
  const mounts = [];
  for (const item of fs.readdirSync(source, { withFileTypes: true })) {
    const sourcePath = path.join(source, item.name);
    const targetPath = `${target}/${item.name}`;
    if (item.name === "node_modules" || item.name === "package-lock.json") continue;
    if (item.isDirectory()) mounts.push(...readFixtureMounts(sourcePath, targetPath));
    else if (item.isFile()) mounts.push({ path: targetPath, data: fs.readFileSync(sourcePath, "utf8") });
  }
  return mounts;
}
