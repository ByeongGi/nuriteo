#!/usr/bin/env node
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { spawnSync } from "node:child_process";

const root = path.resolve(new URL("../..", import.meta.url).pathname);
const config = JSON.parse(fs.readFileSync(path.join(root, "compat/ecosystem-rescore-config.json"), "utf8"));
const planOnly = process.argv.includes("--plan");
const keepWorkdir = process.argv.includes("--keep-workdir");
const selectedIds = valueAfter("--fixtures")?.split(",").filter(Boolean) || config.publicFixtureIds;
const canonicalOutput = path.join(root, "compat/ecosystem-fixture-actual-product-results.json");
const defaultReviewOutput = path.join(root, "artifacts/ecosystem-fixture-actual-product-results.json");
const output = path.resolve(valueAfter("--output") || defaultReviewOutput);
const explicitWorkdir = valueAfter("--workdir");
assertSubset(selectedIds, config.publicFixtureIds);

const runRoot = explicitWorkdir ? path.resolve(explicitWorkdir) : fs.mkdtempSync(path.join(os.tmpdir(), "nuriteo-public-rescore-"));
const checkoutRoot = path.join(runRoot, "fixtures");
const toolchainRoot = path.join(runRoot, "toolchain");
const stagingOutput = path.join(path.dirname(output), `.${path.basename(output)}.${process.pid}.tmp`);

const plan = {
  schemaVersion: 1,
  fixtureIds: selectedIds,
  output,
  outputKind: output === canonicalOutput ? "canonical-explicit" : "review-artifact",
  fixtureDependencyPreparation: {
    enabled: true,
    ignoreScripts: true,
    lockfileMode: "frozen-or-pinned-generated"
  },
  workdir: runRoot,
  runtime: config.runtime,
  toolchain: config.toolchain,
  workerTimeoutMs: config.workerTimeoutMs
};

try {
  if (planOnly) {
    process.stdout.write(`${JSON.stringify(plan, null, 2)}\n`);
  } else {
    fs.mkdirSync(toolchainRoot, { recursive: true });
    fs.writeFileSync(path.join(toolchainRoot, "package.json"), `${JSON.stringify({
      name: "nuriteo-fixture-rescore-toolchain",
      private: true,
      version: "0.0.0",
      dependencies: {
        "@rolldown/binding-wasm32-wasi": config.toolchain.rolldownWasiBinding,
        rolldown: config.toolchain.rolldown,
        vite: config.toolchain.vite
      }
    }, null, 2)}\n`);

    run("corepack", [
      `pnpm@${config.runtime.pnpm}`,
      "install",
      "--dir", toolchainRoot,
      "--ignore-workspace",
      "--frozen-lockfile=false",
      "--config.save-exact=true"
    ]);
    fs.mkdirSync(path.dirname(output), { recursive: true });
    run(process.execPath, [
      path.join(root, "tooling/fixtures/score-ecosystem-fixtures.ts"),
      "--mode=product-actual",
      `--fixtures=${selectedIds.join(",")}`,
      `--workdir=${checkoutRoot}`,
      `--output=${stagingOutput}`,
      `--vite-package-root=${path.join(toolchainRoot, "node_modules/vite")}`,
      `--node-modules-root=${path.join(toolchainRoot, "node_modules")}`,
      `--wasm-policy=${path.join(root, config.toolchain.wasmPolicy)}`,
      `--worker-timeout-ms=${config.workerTimeoutMs}`,
      "--install-missing-fixture-dependencies"
    ]);
    run(process.execPath, [path.join(root, "tooling/checks/check-ecosystem-rescore-automation.ts"), `--results=${stagingOutput}`]);
    fs.renameSync(stagingOutput, output);
    process.stdout.write(`public fixture review artifact ready: ${output}\n`);
  }
} catch (error) {
  process.stderr.write(`${error instanceof Error ? error.message : String(error)}\n`);
  process.exitCode = 1;
} finally {
  fs.rmSync(stagingOutput, { force: true });
  cleanup();
}

function run(command, args) {
  const result = spawnSync(command, args, { cwd: root, encoding: "utf8", stdio: "inherit" });
  if (result.error) throw result.error;
  if (result.status !== 0) throw new Error(`${command} exited with status ${result.status ?? 1}`);
}

function assertSubset(ids, allowed) {
  const allowedIds = new Set(allowed);
  const unknown = ids.filter((id) => !allowedIds.has(id));
  if (unknown.length > 0) throw new Error(`Unknown public fixture id: ${unknown.join(", ")}`);
}

function cleanup() {
  if (!explicitWorkdir && !keepWorkdir) fs.rmSync(runRoot, { recursive: true, force: true });
  else process.stdout.write(`fixture re-score workdir retained: ${runRoot}\n`);
}

function valueAfter(name) {
  const prefix = `${name}=`;
  const values = process.argv.slice(2);
  const inline = values.find((arg) => arg.startsWith(prefix));
  if (inline) return inline.slice(prefix.length);
  const index = values.indexOf(name);
  return index >= 0 ? values[index + 1] : undefined;
}
