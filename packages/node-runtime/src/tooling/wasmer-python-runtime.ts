import { join, normalize } from "../builtins/path.ts";
import type {
  PythonWasiExecutionRequest,
  PythonWasiExecutionResult,
  PythonWasiRuntime
} from "./python-wasi-project-adapter.ts";

export interface WasmerPythonProjectSnapshot {
  read(): ReadonlyMap<string, string | Uint8Array>;
  replace(files: ReadonlyMap<string, Uint8Array>): void | Promise<void>;
}

export interface WasmerPythonRuntimeOptions {
  expectedPackageSha256: string;
  expectedSdkWasmSha256: string;
  loadPackage(): Uint8Array | Promise<Uint8Array>;
  loadSdkWasm(): Uint8Array | Promise<Uint8Array>;
  snapshot: WasmerPythonProjectSnapshot;
  createClient(options: { wasm: Uint8Array; outputBytes: number }): WasmerPythonClient | Promise<WasmerPythonClient>;
}

interface WasmerSandbox {
  command(name: string, args: string[], options?: { cwd?: string; env?: Readonly<Record<string, string>> }): {
    run(options: { stdin: string; timeoutMs: number; outputBytes: number; check: false }): Promise<{
      exitCode: number;
      reason: string;
      stdout: { text(): string; truncated: boolean };
      stderr: { text(): string; truncated: boolean };
    }>;
  };
  fs: {
    readDir(path: string): Promise<readonly { name: string; kind: "file" | "directory" }[]>;
    readFile(path: string): Promise<Uint8Array>;
  };
  close(): Promise<void>;
}

export interface WasmerPythonClient {
  sandboxes: {
    create(options: {
      packages: readonly Uint8Array[];
      files: Readonly<Record<string, string | Uint8Array>>;
      env: Readonly<Record<string, string>>;
      network: { mode: "disabled" };
      signal: AbortSignal;
    }): Promise<WasmerSandbox>;
  };
  close(): Promise<void>;
}

export class IntegrityPinnedWasmerPythonRuntime implements PythonWasiRuntime {
  readonly packageSha256: string;
  readonly sdkWasmSha256: string;
  #client: WasmerPythonClient;
  #packageBytes: Uint8Array<ArrayBuffer>;
  #snapshot: WasmerPythonProjectSnapshot;
  #sandbox: WasmerSandbox | null = null;

  private constructor(
    client: WasmerPythonClient,
    packageBytes: Uint8Array<ArrayBuffer>,
    snapshot: WasmerPythonProjectSnapshot,
    packageSha256: string,
    sdkWasmSha256: string
  ) {
    this.#client = client;
    this.#packageBytes = packageBytes;
    this.#snapshot = snapshot;
    this.packageSha256 = packageSha256;
    this.sdkWasmSha256 = sdkWasmSha256;
  }

  static async create(options: WasmerPythonRuntimeOptions): Promise<IntegrityPinnedWasmerPythonRuntime> {
    assertHash(options.expectedPackageSha256, "Python package");
    assertHash(options.expectedSdkWasmSha256, "Wasmer SDK WASM");
    const [packageBytes, sdkWasmBytes] = await Promise.all([
      verifiedBytes(await options.loadPackage(), options.expectedPackageSha256, "Python package"),
      verifiedBytes(await options.loadSdkWasm(), options.expectedSdkWasmSha256, "Wasmer SDK WASM")
    ]);
    const client = await options.createClient({ wasm: sdkWasmBytes, outputBytes: 1024 * 1024 });
    return new IntegrityPinnedWasmerPythonRuntime(
      client,
      packageBytes,
      options.snapshot,
      options.expectedPackageSha256,
      options.expectedSdkWasmSha256
    );
  }

  async execute(request: PythonWasiExecutionRequest): Promise<PythonWasiExecutionResult> {
    const files: Record<string, string | Uint8Array> = {};
    const projectPrefix = request.cwd === "/workspace" ? "" : `${request.cwd.replace(/^\/workspace\/?/, "")}/`;
    for (const [path, contents] of this.#snapshot.read()) {
      const normalized = normalizeSnapshotPath(path);
      files[`${projectPrefix}${normalized}`] = contents;
    }
    const sandbox = await this.#client.sandboxes.create({
      packages: [this.#packageBytes],
      files,
      env: request.env,
      network: { mode: "disabled" },
      signal: request.signal
    });
    this.#sandbox = sandbox;
    const abort = (): void => {
      void sandbox.close();
    };
    request.signal.addEventListener("abort", abort, { once: true });
    try {
      const output = await sandbox.command("python", request.argv, { cwd: request.cwd, env: request.env }).run({
        stdin: request.stdin,
        timeoutMs: request.limits.timeoutMs,
        outputBytes: request.limits.stdioBytes,
        check: false
      });
      if (output.reason === "timeout") throw runtimeError("EPYTHONTIMEOUT", `Python execution exceeded ${request.limits.timeoutMs} ms`);
      if (output.stdout.truncated || output.stderr.truncated) {
        throw runtimeError("EPYTHONSTDIOLIMIT", `Python output exceeds ${request.limits.stdioBytes} bytes`);
      }
      await this.#persistProject(sandbox, request.cwd);
      return {
        exitCode: output.exitCode,
        stdout: output.stdout.text(),
        stderr: output.stderr.text()
      };
    } finally {
      request.signal.removeEventListener("abort", abort);
      await sandbox.close();
      this.#sandbox = null;
    }
  }

  dispose(): void {
    if (this.#sandbox) void this.#sandbox.close();
    void this.#client.close();
  }

  async #persistProject(sandbox: WasmerSandbox, projectRoot: string): Promise<void> {
    const files = new Map<string, Uint8Array>();
    await collectFiles(sandbox, projectRoot, "", files);
    await this.#snapshot.replace(files);
  }
}

export function createIntegrityPinnedWasmerPythonRuntime(
  options: WasmerPythonRuntimeOptions
): Promise<IntegrityPinnedWasmerPythonRuntime> {
  return IntegrityPinnedWasmerPythonRuntime.create(options);
}

async function collectFiles(
  sandbox: WasmerSandbox,
  root: string,
  relativeRoot: string,
  output: Map<string, Uint8Array>
): Promise<void> {
  const directory = relativeRoot ? join(root, relativeRoot) : root;
  for (const entry of await sandbox.fs.readDir(directory)) {
    const relativePath = relativeRoot ? join(relativeRoot, entry.name) : entry.name;
    if (entry.kind === "directory") await collectFiles(sandbox, root, relativePath, output);
    else output.set(relativePath, copyBytes(await sandbox.fs.readFile(join(root, relativePath))));
  }
}

function normalizeSnapshotPath(path: string): string {
  const normalized = normalize(path);
  if (!path || path.startsWith("/") || normalized === ".." || normalized.startsWith("../") || path.includes("\0")) {
    throw runtimeError("EPYTHONPROJECTPATH", `invalid Python snapshot path: ${path}`);
  }
  return normalized;
}

async function verifiedBytes(bytes: Uint8Array, expected: string, label: string): Promise<Uint8Array<ArrayBuffer>> {
  const copy = copyBytes(bytes);
  const actual = await sha256Hex(copy);
  if (actual !== expected) throw runtimeError("EPYTHONINTEGRITY", `${label} integrity mismatch: expected ${expected}, received ${actual}`);
  return copy;
}

function assertHash(value: string, label: string): void {
  if (!/^[a-f0-9]{64}$/.test(value)) throw runtimeError("EPYTHONINTEGRITY", `${label} expected SHA-256 is invalid`);
}

function copyBytes(bytes: Uint8Array): Uint8Array<ArrayBuffer> {
  const copy = new Uint8Array(bytes.byteLength);
  copy.set(bytes);
  return copy;
}

async function sha256Hex(bytes: Uint8Array<ArrayBuffer>): Promise<string> {
  const digest = await crypto.subtle.digest("SHA-256", bytes.buffer);
  return [...new Uint8Array(digest)].map((byte) => byte.toString(16).padStart(2, "0")).join("");
}

function runtimeError(code: string, message: string): Error & { code: string } {
  return Object.assign(new Error(message), { code });
}
