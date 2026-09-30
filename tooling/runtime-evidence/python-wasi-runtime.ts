import assert from "node:assert/strict";
import crypto from "node:crypto";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";

import { Wasmer } from "@wasmer/sdk/node";

import {
  createIntegrityPinnedWasmerPythonRuntime,
  createPythonWasiProjectAdapter,
  type WasmerPythonClient
} from "../../packages/node-runtime/src/tooling/index.ts";

const PYTHON_PACKAGE = "python/python@=3.13.18";
const PYTHON_PACKAGE_SHA256 = "0464f16f1ad0ce4d1ab4266b057b62accd5b4123995a08103897699aefc92a54";
const PYTHON_PACKAGE_BYTES = 157_272_498;
const SDK_WASM_SHA256 = "eb00b569d1f5dc4cdb23f8986a6b812158eb7a01845000af14ae564fea050397";
const cacheRoot = process.env.PYTHON_WASI_CACHE_DIR || path.join(os.tmpdir(), "nuriteo-python-wasi");
const packagePath = path.join(cacheRoot, "cache-v1", "packages", `${PYTHON_PACKAGE_SHA256}.bin`);
const sdkEntry = fileURLToPath(import.meta.resolve("@wasmer/sdk/node"));
const sdkWasmPath = path.join(path.dirname(path.dirname(sdkEntry)), "pkg", "wasmer_sdk_js_bg.wasm");

if (!fs.existsSync(packagePath)) {
  const resolver = new Wasmer({ cache: { directory: cacheRoot }, outputBytes: 1024 * 1024 });
  await resolver.packages.load(PYTHON_PACKAGE);
  await resolver.close();
}

const packageBytes = fs.readFileSync(packagePath);
const sdkWasmBytes = fs.readFileSync(sdkWasmPath);
assert.equal(packageBytes.byteLength, PYTHON_PACKAGE_BYTES);
assert.equal(sha256(packageBytes), PYTHON_PACKAGE_SHA256);
assert.equal(sha256(sdkWasmBytes), SDK_WASM_SHA256);

const project = new Map<string, string | Uint8Array>([
  ["helper.py", "VALUE = 42\n"],
  ["main.py", [
    "import json, sys",
    "from helper import VALUE",
    "with open('/workspace/project/result.txt', 'w') as target:",
    "    target.write(str(VALUE))",
    "print(json.dumps({'value': VALUE}))",
    "sys.stderr.write('stderr-ok\\n')"
  ].join("\n")],
  ["network.py", [
    "import socket",
    "try:",
    "    socket.create_connection(('127.0.0.1', 9), timeout=0.1)",
    "except Exception as error:",
    "    print(type(error).__name__)",
    "else:",
    "    raise RuntimeError('network unexpectedly available')"
  ].join("\n")],
  ["output.py", "print('x' * 2048)\n"],
  ["spin.py", "while True:\n    pass\n"]
]);
const snapshot = {
  read() {
    return project;
  },
  replace(files: ReadonlyMap<string, Uint8Array>) {
    project.clear();
    for (const [name, bytes] of files) project.set(name, bytes);
  }
};
const createRuntime = async () => await createIntegrityPinnedWasmerPythonRuntime({
  expectedPackageSha256: PYTHON_PACKAGE_SHA256,
  expectedSdkWasmSha256: SDK_WASM_SHA256,
  loadPackage: () => packageBytes,
  loadSdkWasm: () => sdkWasmBytes,
  snapshot,
  createClient: ({ wasm, outputBytes }) => new Wasmer({ cache: false, wasm, outputBytes }) as unknown as WasmerPythonClient
});

const startedAt = performance.now();
const python = createPythonWasiProjectAdapter({
  projectRoot: "/workspace/project",
  stdlibRoot: "/usr/local/lib/python3.13",
  timeoutMs: 10_000,
  loadRuntime: createRuntime
});
const output = await python.runScript("main.py", { env: { PYTHONUTF8: "1" } });
assert.equal(output.exitCode, 0);
assert.equal(output.stdout, "{\"value\": 42}\n");
assert.equal(output.stderr, "stderr-ok\n");
assert.equal(new TextDecoder().decode(project.get("result.txt") as Uint8Array), "42");

const network = createPythonWasiProjectAdapter({
  projectRoot: "/workspace/project",
  stdlibRoot: "/usr/local/lib/python3.13",
  timeoutMs: 10_000,
  loadRuntime: createRuntime
});
const networkOutput = await network.runScript("network.py");
assert.equal(networkOutput.exitCode, 0);
assert.match(networkOutput.stdout, /OSError|PermissionError/);

const outputLimited = createPythonWasiProjectAdapter({
  projectRoot: "/workspace/project",
  stdlibRoot: "/usr/local/lib/python3.13",
  stdioBytes: 1024,
  timeoutMs: 10_000,
  loadRuntime: createRuntime
});
await assert.rejects(outputLimited.runScript("output.py"), { code: "EPYTHONSTDIOLIMIT" });

const cancelled = createPythonWasiProjectAdapter({
  projectRoot: "/workspace/project",
  stdlibRoot: "/usr/local/lib/python3.13",
  timeoutMs: 10_000,
  loadRuntime: createRuntime
});
const controller = new AbortController();
const cancellation = cancelled.runScript("spin.py", { signal: controller.signal });
setTimeout(() => controller.abort(), 100);
await assert.rejects(cancellation, { code: "EPYTHONCANCELLED" });

const timed = createPythonWasiProjectAdapter({
  projectRoot: "/workspace/project",
  stdlibRoot: "/usr/local/lib/python3.13",
  timeoutMs: 100,
  loadRuntime: createRuntime
});
await assert.rejects(timed.runScript("spin.py"), { code: "EPYTHONTIMEOUT" });

const elapsedMs = performance.now() - startedAt;
assert(elapsedMs < 30_000, `Python WASIX runtime evidence exceeded 30000ms: ${elapsedMs.toFixed(1)}ms`);
console.log(JSON.stringify({
  status: "pass-with-memory-enforcement-blocked",
  pythonPackage: PYTHON_PACKAGE,
  packageSha256: PYTHON_PACKAGE_SHA256,
  packageBytes: packageBytes.byteLength,
  sdkWasmSha256: SDK_WASM_SHA256,
  sdkWasmBytes: sdkWasmBytes.byteLength,
  elapsedMs: Number(elapsedMs.toFixed(1)),
  verified: ["stdlib import", "project read/write", "stdout", "stderr", "stdio limit", "network disabled", "cancellation", "timeout"],
  blocker: "Wasmer SDK does not expose a per-sandbox peak-memory limit or measurement"
}));

function sha256(bytes: Uint8Array): string {
  return crypto.createHash("sha256").update(bytes).digest("hex");
}
