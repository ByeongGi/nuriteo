import {
  createCliModuleEvaluator,
  createStaticCjsFactoryRegistry,
  MemoryPackageManagerWorkspace
} from "../../../packages/node-runtime/src/index.ts";

const path = "/workspace/strict.cjs";
const registry = createStaticCjsFactoryRegistry([{
  path,
  sha256: "a".repeat(64),
  sourceSha256: "b".repeat(64),
  factory(_context, globals) {
    (globals.process as { stdout: { write(value: string): void } }).stdout.write("strict-csp-static-factory");
  }
}]);
const workspace = new MemoryPackageManagerWorkspace([{ path, data: "globalThis.eval('forbidden')" }]);
const result = createCliModuleEvaluator({ reader: workspace, precompiledCjsFactoryRegistry: registry })({
  args: [], cwd: "/workspace", entry: { entry: path, mode: "cjs", name: "strict", version: "1.0.0" }
});
document.querySelector("#result")!.textContent = `${result.exitCode}:${result.stdout}`;
