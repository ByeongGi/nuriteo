import { Wasmer } from "/node_modules/@wasmer/sdk/dist/index.js";

const PACKAGE_URL = "/artifacts/python-3.13.18.webc";
const PACKAGE_SHA256 = "0464f16f1ad0ce4d1ab4266b057b62accd5b4123995a08103897699aefc92a54";
const PACKAGE_BYTES = 157_272_498;
const SDK_URL = "/node_modules/@wasmer/sdk/pkg/wasmer_sdk_js_bg.wasm";
const SDK_SHA256 = "eb00b569d1f5dc4cdb23f8986a6b812158eb7a01845000af14ae564fea050397";
const SDK_BYTES = 4_804_809;
const DEFAULT_MEMORY_ADMISSION_BYTES = 256 * 1024 * 1024;
let runtimePromise;

self.addEventListener("message", async (event) => {
  const message = event.data || {};
  try {
    if (message.action === "close") {
      if (runtimePromise) (await runtimePromise).client.close();
      runtimePromise = undefined;
      self.postMessage({ id: message.id, ok: true });
      return;
    }
    const limits = validateLimits(message.limits);
    const files = validateFiles(message.files);
    const inputBytes = Object.values(files).reduce((total, value) => total + new TextEncoder().encode(value).byteLength, 0);
    const admittedBytes = PACKAGE_BYTES + SDK_BYTES + inputBytes + limits.outputBytes * 2;
    if (admittedBytes > limits.memoryBytes) {
      throw coded("EPYTHONMEMORYLIMIT", `Python static allocation requires ${admittedBytes} bytes; limit is ${limits.memoryBytes}`);
    }
    const runtime = await (runtimePromise ||= createRuntime());
    const sandbox = await runtime.client.sandboxes.create({
      packages: [runtime.packageBytes],
      files,
      env: { PYTHONUTF8: "1", ...(message.env || {}) },
      network: { mode: "disabled" }
    });
    try {
      const output = await sandbox.command("python", [safeScript(message.script)], {
        cwd: "/workspace/project",
        env: { PYTHONUTF8: "1", ...(message.env || {}) }
      }).run({ stdin: "", timeoutMs: limits.timeoutMs, outputBytes: limits.outputBytes, check: false });
      if (output.reason === "timeout") throw coded("EPYTHONTIMEOUT", `Python execution exceeded ${limits.timeoutMs} ms`);
      if (output.stdout.truncated || output.stderr.truncated) {
        throw coded("EPYTHONSTDIOLIMIT", `Python output exceeds ${limits.outputBytes} bytes`);
      }
      const result = {
        exitCode: output.exitCode,
        stdout: output.stdout.text(),
        stderr: output.stderr.text()
      };
      if (message.readBack) {
        const path = safeProjectPath(message.readBack);
        result.readBack = new TextDecoder().decode(await sandbox.fs.readFile(`/workspace/project/${path}`));
      }
      self.postMessage({
        id: message.id,
        ok: true,
        ...result,
        admittedBytes,
        packageSha256: PACKAGE_SHA256,
        packageBytes: PACKAGE_BYTES,
        sdkSha256: SDK_SHA256,
        sdkBytes: SDK_BYTES
      });
    } finally {
      await sandbox.close();
    }
  } catch (error) {
    self.postMessage({
      id: message.id,
      ok: false,
      code: error?.code || "EPYTHONWORKER",
      error: safeError(error)
    });
  }
});

async function createRuntime() {
  const [packageBytes, sdkBytes] = await Promise.all([
    fetchVerified(PACKAGE_URL, PACKAGE_BYTES, PACKAGE_SHA256, "Python package"),
    fetchVerified(SDK_URL, SDK_BYTES, SDK_SHA256, "Wasmer SDK")
  ]);
  return {
    packageBytes,
    client: new Wasmer({ cache: false, wasm: sdkBytes, outputBytes: 1024 * 1024, parallelism: 1 })
  };
}

async function fetchVerified(url, expectedBytes, expectedHash, label) {
  const response = await fetch(url, { credentials: "omit", cache: "no-store" });
  if (!response.ok) throw coded("EPYTHONINTEGRITY", `${label} artifact is unavailable`);
  const bytes = new Uint8Array(await response.arrayBuffer());
  if (bytes.byteLength !== expectedBytes || await sha256(bytes) !== expectedHash) {
    throw coded("EPYTHONINTEGRITY", `${label} artifact integrity mismatch`);
  }
  return bytes;
}

function validateLimits(value = {}) {
  const timeoutMs = positiveInteger(value.timeoutMs ?? 10_000, "timeoutMs");
  const outputBytes = positiveInteger(value.outputBytes ?? 1024 * 1024, "outputBytes");
  const memoryBytes = positiveInteger(value.memoryBytes ?? DEFAULT_MEMORY_ADMISSION_BYTES, "memoryBytes");
  return { timeoutMs, outputBytes, memoryBytes };
}

function validateFiles(value) {
  if (!value || typeof value !== "object" || Array.isArray(value)) throw coded("EPYTHONPROJECT", "Python project files are required");
  const files = {};
  for (const [path, contents] of Object.entries(value)) {
    files[`project/${safeProjectPath(path)}`] = String(contents);
  }
  return files;
}

function safeProjectPath(value) {
  if (!value || value.startsWith("/") || value.includes("\0")) throw coded("EPYTHONPROJECTPATH", "Invalid Python project path");
  const parts = [];
  for (const part of value.split("/")) {
    if (!part || part === ".") continue;
    if (part === "..") {
      if (!parts.length) throw coded("EPYTHONPROJECTPATH", "Python path escapes the project");
      parts.pop();
    } else parts.push(part);
  }
  if (!parts.length) throw coded("EPYTHONPROJECTPATH", "Python project path is empty");
  return parts.join("/");
}

function safeScript(value) {
  return safeProjectPath(String(value || ""));
}

function positiveInteger(value, field) {
  if (!Number.isSafeInteger(value) || value <= 0) throw coded("EPYTHONLIMIT", `Invalid Python ${field}`);
  return value;
}

function safeError(error) {
  if (error?.code && /^EPYTHON[A-Z]+$/.test(error.code)) return `${error.code}: ${error.message}`;
  return "EPYTHONWORKER: Python worker execution failed";
}

function coded(code, message) {
  return Object.assign(new Error(message), { code });
}

async function sha256(bytes) {
  const digest = await crypto.subtle.digest("SHA-256", bytes);
  return [...new Uint8Array(digest)].map((byte) => byte.toString(16).padStart(2, "0")).join("");
}
