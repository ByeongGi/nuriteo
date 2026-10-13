import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import { createRequire } from "node:module";

import { loadJq } from "jq-wasm";

import { createJqProjectAdapter, createJqShellCommands } from "../../node-runtime/src/tooling/index.ts";

const require = createRequire(import.meta.url);
const jqRoot = path.dirname(require.resolve("jq-wasm/package.json"));
const wasmBinary = fs.readFileSync(path.join(jqRoot, "dist/build/jq.wasm"));
const files = new Map([
  ["/workspace/project/input.json", JSON.stringify({ packages: [{ name: "runtime", supported: true }, { name: "native", supported: false }] })]
]);
let loads = 0;
const adapter = createJqProjectAdapter({
  projectRoot: "/workspace/project",
  readText(file) {
    const value = files.get(file);
    if (value === undefined) throw new Error(`missing ${file}`);
    return value;
  },
  writeText(file, value) {
    files.set(file, value);
  },
  async loadRuntime() {
    loads += 1;
    return loadJq({ wasmBinary });
  }
});

const first = await adapter.transformFile("[.packages[] | select(.supported) | .name]", "input.json", "generated/result.json");
assert.equal(first.inputPath, "/workspace/project/input.json");
assert.equal(first.outputPath, "/workspace/project/generated/result.json");
assert.deepEqual(JSON.parse(files.get(first.outputPath)), [["runtime"]]);

const command = createJqShellCommands(adapter).jq;
const stdout = await command({ argv: ["jq", ".packages | length", "input.json"], cwd: "/workspace/project", env: {}, stdin: "" });
assert.equal(stdout.exitCode, 0);
assert.deepEqual(JSON.parse(stdout.stdout), [2]);
assert.equal(loads, 1, "jq runtime must be reused per project adapter");

await assert.rejects(adapter.transformFile(".", "../credential.json"), { code: "EJQPROJECTPATH" });
await assert.rejects(adapter.transformFile("", "input.json"), { code: "EJQFILTER" });

console.log("project-scoped jq tooling test ok");
