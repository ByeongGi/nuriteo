import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import { createRequire } from "node:module";

import { createGitWasmProjectAdapter, createIntegrityPinnedWasmGitRuntime } from "../../node-runtime/src/tooling/index.ts";

const WASM_SHA256 = "5cd5df122c066f63c1a940e66fb126a0a35f44b7c0f1c9801b1c1007078eb0f9";
const require = createRequire(import.meta.url);
const packageRoot = path.dirname(require.resolve("wasm-git/package.json"));
const wasmPath = path.join(packageRoot, "lg2.wasm");
const wasmBytes = fs.readFileSync(wasmPath);
const repository = new Map<string, Uint8Array | string>([["src/message.txt", "hello from wasm git\n"]]);
const snapshot = {
  read() {
    return repository;
  },
  replace(files: ReadonlyMap<string, Uint8Array>) {
    repository.clear();
    for (const [name, bytes] of files) repository.set(name, bytes);
  }
};

const startedAt = performance.now();
const adapter = createGitWasmProjectAdapter({
  projectRoot: "/workspace/project",
  memoryBytes: 256 * 1024 * 1024,
  async loadRuntime() {
    return await createIntegrityPinnedWasmGitRuntime({
      expectedWasmSha256: WASM_SHA256,
      loadWasm: () => wasmBytes,
      snapshot
    });
  }
});

const init = await adapter.init();
assert.equal(init.exitCode, 0);
assert.equal(init.artifactSha256, WASM_SHA256);
assert.match(init.stdout, /Initialized empty Git repository/);

const untracked = await adapter.status();
assert.equal(untracked.exitCode, 0);
assert.match(untracked.stdout, /\?\? src\//);

assert.equal((await adapter.add(["src/message.txt"])).exitCode, 0);
const commit = await adapter.commit({
  message: "initial project snapshot",
  author: { name: "Runtime Fixture", email: "runtime@example.test" }
});
assert.equal(commit.exitCode, 0);
assert.equal((await adapter.status()).stdout, "");
const log = await adapter.log(1);
assert.equal(log.exitCode, 0);
assert.match(log.stdout, /^[a-f0-9]{40} initial project snapshot\n$/);
assert(repository.has(".git/HEAD"));
assert(repository.has(".git/index"));

const reopened = createGitWasmProjectAdapter({
  projectRoot: "/workspace/project",
  async loadRuntime() {
    return await createIntegrityPinnedWasmGitRuntime({
      expectedWasmSha256: WASM_SHA256,
      loadWasm: () => wasmBytes,
      snapshot
    });
  }
});
assert.equal((await reopened.status()).stdout, "");
assert.match((await reopened.log(1)).stdout, /^[a-f0-9]{40} initial project snapshot\n$/);

const elapsedMs = performance.now() - startedAt;
assert(elapsedMs < 5000, `Git WASM local and reopen fixture exceeded 5000ms: ${elapsedMs.toFixed(1)}ms`);

await assert.rejects(createIntegrityPinnedWasmGitRuntime({
  expectedWasmSha256: "0".repeat(64),
  loadWasm: () => wasmBytes,
  snapshot
}), { code: "EGITINTEGRITY" });

console.log(`Git WASM runtime test ok (${elapsedMs.toFixed(1)}ms, ${wasmBytes.byteLength} bytes)`);
