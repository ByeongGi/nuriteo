import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";

import {
  createRuntimeNetworkRecoveryDiagnostic,
  createUnsupportedRuntimeDiagnostic,
  createPackageManagerRecoveryDiagnostic
} from "../../packages/browser-host/src/index.ts";
import {
  CliRegistry,
  createGuestRuntimeProcessRunner,
  createNativeFallbackPolicy,
  createNpmRunner,
  createPackageExecutionPolicy,
  createPackageScriptRunner,
  createPnpmRunner,
  createWasmAdapterPolicy,
  MemoryPackageManagerWorkspace
} from "../../packages/node-runtime/src/index.ts";

const root = new URL("../..", import.meta.url).pathname;
const matrix = JSON.parse(fs.readFileSync(new URL("../../compat/package-compatibility-cohorts.json", import.meta.url), "utf8"));
const cohorts = new Map(matrix.cohorts.map((cohort) => [cohort.id, cohort]));

assert.equal(runPackageManagerCohort("npm").build, "consumer:provider");
assert.equal(runPackageManagerCohort("npm").lifecycle, "fixture-optional:installed");
assert.equal(runPackageManagerCohort("npm").bin, "fixture-bin:hello");
assert.equal(runPackageManagerCohort("pnpm").build, "consumer:provider");
assert.equal(runPackageManagerCohort("pnpm").lifecycle, "fixture-optional:installed");
assert.equal(runPackageManagerCohort("pnpm").bin, "fixture-bin:hello");

const nativeFallbackPolicy = createNativeFallbackPolicy({
  wasmPolicy: createWasmAdapterPolicy(JSON.parse(fs.readFileSync(path.join(root, "vendor/manifests/wasm-adapters.json"), "utf8")))
});
assert.equal(
  nativeFallbackPolicy.classify({
    path: "/workspace/node_modules/@esbuild/darwin-arm64/install.js",
    command: "node install.js",
    source: "require('./bin/esbuild.node')"
  }).action,
  "use-wasm"
);

const unsupportedWorkspace = new MemoryPackageManagerWorkspace([
  {
    path: "/workspace/package.json",
    data: JSON.stringify({
      scripts: {
        native: "node scripts/native.js"
      }
    })
  },
  {
    path: "/workspace/scripts/native.js",
    data: "require('./native.node')\n"
  }
]);
const unsupportedRunner = createPackageScriptRunner({
  cwd: "/workspace",
  reader: unsupportedWorkspace,
  writer: unsupportedWorkspace,
  policy: createPackageExecutionPolicy()
});
const native = unsupportedRunner.runScript("native");
assert.equal(native.error.code, cohorts.get("unsupported-native-addon").requiredErrorCode);
const nativeRecovery = createPackageManagerRecoveryDiagnostic(native);
assert.equal(nativeRecovery.diagnostic.code, "ERR_PM_NATIVE_ADDON_UNSUPPORTED");
assert.equal(nativeRecovery.recovery.blocked, true);

const binaryDiagnostic = createUnsupportedRuntimeDiagnostic({
  kind: "arbitrary-linux-binary",
  resource: "./node_modules/.bin/linux-tool",
  command: "./node_modules/.bin/linux-tool"
});
assert.equal(binaryDiagnostic.code, cohorts.get("binary-tool-wrapper").requiredErrorCode);

const tcpDbRecovery = createRuntimeNetworkRecoveryDiagnostic({
  error: { code: "ERR_BROWSER_TCP_UNSUPPORTED", message: "Direct TCP sockets are not available" },
  host: "database.local",
  port: 5432
});
assert.equal(tcpDbRecovery.diagnostic.code, "ERR_RUNTIME_TCP_DB_UNSUPPORTED");

console.log("package cohort execution test ok");

function runPackageManagerCohort(manager) {
  const fixture = path.join(root, `tests/fixtures/package-managers/${manager}`);
  const installed = JSON.parse(fs.readFileSync(new URL(`../../vendor/cli/${manager}/${manager === "npm" ? "10.9.2" : "9.15.9"}/installed.json`, import.meta.url), "utf8"));
  const registry = new CliRegistry([installed]);
  const workdir = "/workspace";
  const workspace = new MemoryPackageManagerWorkspace(readFixtureMounts(fixture, workdir));
  const runnerOptions = {
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
  };
  const runner = manager === "npm" ? createNpmRunner(runnerOptions) : createPnpmRunner(runnerOptions);
  const install = manager === "npm" ? runner.ci(workdir, []) : runner.install(workdir, ["--frozen-lockfile"]);
  assert.equal(install.runtime, "browser-guest-node-runtime");
  assert.equal(install.exitCode, 0, install.stderr);
  assert.equal(workspace.exists(`${workdir}/node_modules/.bin/fixture-hello`), true);

  const build = runner.runScript(workdir, "build");
  const lifecycle = runner.runScript(workdir, "lifecycle-test");
  const bin = runner.exec(workdir, "fixture-hello");
  assert.equal(build.exitCode, 0, build.stderr);
  assert.equal(lifecycle.exitCode, 0, lifecycle.stderr);
  assert.equal(bin.exitCode, 0, bin.stderr);
  return {
    bin: bin.stdout.trim(),
    build: build.stdout.trim(),
    lifecycle: lifecycle.stdout.trim()
  };
}

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
