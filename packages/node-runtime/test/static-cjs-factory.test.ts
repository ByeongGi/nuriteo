import assert from "node:assert/strict";
import {
  createCliModuleEvaluator,
  createStaticCjsFactoryRegistry,
  evaluateCliModuleWorkerMessage,
  MemoryPackageManagerWorkspace
} from "../../node-runtime/src/index.ts";

const path = "/workspace/tool.cjs";
const registry = createStaticCjsFactoryRegistry([{
  path,
  sha256: "a".repeat(64),
  sourceSha256: "b".repeat(64),
  factory(context, globals) {
    (globals.process as { stdout: { write(value: string): void } }).stdout.write("static-factory-ok\n");
    context.module.exports = { ok: true };
  }
}]);
const workspace = new MemoryPackageManagerWorkspace([{ path, data: "throw new Error('dynamic source must not execute')" }]);
const result = createCliModuleEvaluator({ reader: workspace, precompiledCjsFactoryRegistry: registry })({
  args: [],
  cwd: "/workspace",
  entry: { entry: path, mode: "cjs", name: "static-fixture", version: "1.0.0" }
});
assert.equal(result.exitCode, 0);
assert.equal(result.stdout, "static-factory-ok\n");
assert.deepEqual(registry.paths(), [path]);
assert.throws(() => registry.resolve(path, "c".repeat(64)), /ESTATICFACTORYSOURCEMISMATCH/);
assert.throws(() => createStaticCjsFactoryRegistry([{ path, sha256: "bad", sourceSha256: "b".repeat(64), factory() {} }]), /ESTATICFACTORYINTEGRITY/);

const workerMessage = {
  id: 1,
  request: { args: [], cwd: "/workspace", entry: { entry: path, mode: "cjs" as const, name: "static-fixture", version: "1.0.0" } },
  requiredPrecompiledCjsFactoryPaths: [path],
  type: "cli:evaluate" as const,
  workspaceSnapshot: workspace.snapshot()
};
const workerResult = await evaluateCliModuleWorkerMessage(workerMessage, { precompiledCjsFactoryRegistry: registry });
assert.equal(workerResult.result?.exitCode, 0);
assert.match(workerResult.result?.stdout || "", /static-factory-ok/);
const missingWorkerFactory = await evaluateCliModuleWorkerMessage(workerMessage);
assert.match(missingWorkerFactory.error || "", /ESTATICFACTORYWORKERMISSING/);

console.log("node static CJS factory registry test ok");
