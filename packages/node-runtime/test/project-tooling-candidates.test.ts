import assert from "node:assert/strict";

import {
  createGitWasmProjectAdapter,
  createIntegrityPinnedWasmerPythonRuntime,
  createPythonWasiProjectAdapter,
  type GitWasmRuntimeRequest,
  type PythonWasiExecutionRequest
} from "../../node-runtime/src/tooling/index.ts";

const pythonRequests: PythonWasiExecutionRequest[] = [];
let pythonDisposals = 0;
const python = createPythonWasiProjectAdapter({
  projectRoot: "/workspace/project",
  stdlibRoot: "/runtime/python/stdlib",
  stdioBytes: 1024,
  memoryBytes: 8 * 1024 * 1024,
  timeoutMs: 1000,
  async loadRuntime() {
    return {
      async execute(request) {
        pythonRequests.push(request);
        return { exitCode: 0, stdout: "project import ok\n", stderr: "", peakMemoryBytes: 1024 };
      },
      dispose() {
        pythonDisposals += 1;
      }
    };
  }
});

const pythonResult = await python.runScript("scripts/main.py", {
  args: ["fixture"],
  env: { PYTHONUTF8: "1" },
  stdin: "input"
});
assert.equal(pythonResult.stdout, "project import ok\n");
assert.equal(pythonDisposals, 1);
assert.deepEqual(pythonRequests[0]?.pythonPath, ["/workspace/project", "/runtime/python/stdlib"]);
assert.deepEqual(pythonRequests[0]?.mounts, [
  { guestPath: "/workspace/project", hostPath: "/workspace/project", access: "read-write" },
  { guestPath: "/runtime/python/stdlib", hostPath: "/runtime/python/stdlib", access: "read-only" }
]);
assert.deepEqual(pythonRequests[0]?.capabilities, { directTcp: false, directUdp: false, fetch: false });
assert.equal(pythonRequests[0]?.scriptPath, "/workspace/project/scripts/main.py");
assert.throws(() => python.assertNetworkDenied("fetch"), { code: "EWASINETWORK" });
await assert.rejects(python.runScript("../secret.py"), { code: "EPYTHONPROJECTPATH" });
await assert.rejects(python.runScript("main.py", { env: { NPM_TOKEN: "secret" } }), { code: "EWASIENV" });
await assert.rejects(python.runScript("main.py", { stdin: "x".repeat(1025) }), { code: "EPYTHONSTDIOLIMIT" });
assert.throws(() => createPythonWasiProjectAdapter({
  projectRoot: "/workspace/project",
  stdlibRoot: "/workspace/project/stdlib",
  async loadRuntime() {
    throw new Error("must not load");
  }
}), { code: "EPYTHONSTDLIBPATH" });
assert.throws(() => createPythonWasiProjectAdapter({
  projectRoot: "/",
  stdlibRoot: "/runtime/python/stdlib",
  async loadRuntime() {
    throw new Error("must not load");
  }
}), { code: "EPYTHONPROJECTPATH" });

const cancelled = new AbortController();
cancelled.abort();
await assert.rejects(python.runScript("main.py", { signal: cancelled.signal }), { code: "EPYTHONCANCELLED" });

let timeoutDisposals = 0;
const timedPython = createPythonWasiProjectAdapter({
  projectRoot: "/workspace/project",
  stdlibRoot: "/runtime/python/stdlib",
  timeoutMs: 5,
  async loadRuntime() {
    return {
      execute() {
        return new Promise(() => undefined);
      },
      dispose() {
        timeoutDisposals += 1;
      }
    };
  }
});
await assert.rejects(timedPython.runScript("main.py"), { code: "EPYTHONTIMEOUT" });
assert.equal(timeoutDisposals, 1);

const limitedPython = createPythonWasiProjectAdapter({
  projectRoot: "/workspace/project",
  stdlibRoot: "/runtime/python/stdlib",
  stdioBytes: 4,
  memoryBytes: 1024,
  async loadRuntime() {
    return {
      async execute() {
        return { exitCode: 0, stdout: "12345", stderr: "", peakMemoryBytes: 2048 };
      },
      dispose() {}
    };
  }
});
await assert.rejects(limitedPython.runScript("main.py"), { code: "EPYTHONSTDIOLIMIT" });

const memoryLimitedPython = createPythonWasiProjectAdapter({
  projectRoot: "/workspace/project",
  stdlibRoot: "/runtime/python/stdlib",
  memoryBytes: 1024,
  async loadRuntime() {
    return {
      async execute() {
        return { exitCode: 0, stdout: "", stderr: "", peakMemoryBytes: 2048 };
      },
      dispose() {}
    };
  }
});
await assert.rejects(memoryLimitedPython.runScript("main.py"), { code: "EPYTHONMEMORYLIMIT" });
await assert.rejects(createIntegrityPinnedWasmerPythonRuntime({
  expectedPackageSha256: "0".repeat(64),
  expectedSdkWasmSha256: "0".repeat(64),
  loadPackage: () => new Uint8Array([1]),
  loadSdkWasm: () => new Uint8Array([2]),
  snapshot: { read: () => new Map(), replace() {} },
  createClient() {
    throw new Error("must not initialize an unverified runtime");
  }
}), { code: "EPYTHONINTEGRITY" });

const gitRequests: GitWasmRuntimeRequest[] = [];
const git = createGitWasmProjectAdapter({
  projectRoot: "/workspace/project",
  outputBytes: 1024,
  memoryBytes: 8 * 1024 * 1024,
  packfileBytes: 4 * 1024 * 1024,
  async loadRuntime() {
    return {
      async execute(request) {
        gitRequests.push(request);
        return { exitCode: 0, stdout: `${request.operation.command} ok\n`, stderr: "", peakMemoryBytes: 2048 };
      }
    };
  }
});

await git.init();
await git.status();
await git.add(["src/index.ts", "."]);
await git.commit({ message: "candidate adapter", author: { name: "Fixture", email: "fixture@example.test" } });
await git.log(5);
assert.deepEqual(gitRequests.map((request) => request.operation.command), ["init", "status", "add", "commit", "log"]);
assert.deepEqual(gitRequests[2]?.operation, { command: "add", paths: ["src/index.ts", "."] });
assert.deepEqual(gitRequests[0]?.capabilities, { directTcp: false, fetch: false, credentials: false });
assert.equal(gitRequests[0]?.limits.packfileBytes, 4 * 1024 * 1024);
assert.throws(() => git.add(["../credential.txt"]), { code: "EGITPROJECTPATH" });
assert.throws(() => git.add([".git/config"]), { code: "EGITMETADATA" });
assert.throws(() => git.add([".GIT/config"]), { code: "EGITMETADATA" });
assert.throws(() => git.add(["src/secret\0.txt"]), { code: "EGITPROJECTPATH" });

for (const method of ["fetch", "clone"] as const) {
  const secretRemote = "https://token:super-secret@example.test/repository.git";
  assert.throws(
    () => git[method](secretRemote),
    (error: Error & { code?: string }) => error.code === "EGITNETWORK" && !error.message.includes("super-secret") && !error.message.includes(secretRemote)
  );
}

const outputLimitedGit = createGitWasmProjectAdapter({
  projectRoot: "/workspace/project",
  outputBytes: 4,
  async loadRuntime() {
    return { async execute() { return { exitCode: 0, stdout: "12345", stderr: "" }; } };
  }
});
await assert.rejects(outputLimitedGit.status(), { code: "EGITOUTPUTLIMIT" });

const memoryLimitedGit = createGitWasmProjectAdapter({
  projectRoot: "/workspace/project",
  memoryBytes: 1024,
  async loadRuntime() {
    return { async execute() { return { exitCode: 0, stdout: "", stderr: "", peakMemoryBytes: 2048 }; } };
  }
});
await assert.rejects(memoryLimitedGit.status(), { code: "EGITMEMORYLIMIT" });

console.log("Python WASI and Git WASM candidate adapter boundary tests ok");
