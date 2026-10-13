import { join, normalize } from "../builtins/path.ts";
import {
  createWasiRuntimeBoundary,
  createWasiStdioLimits,
  validateWasiEnv,
  validateWasiFilesystemAccess,
  validateWasiNetwork,
  type WasiRuntimeBoundary
} from "../wasm-adapters/wasi-boundary.ts";

export interface PythonWasiExecutionLimits {
  stdioBytes: number;
  memoryBytes: number;
  timeoutMs: number;
}

export interface PythonWasiMount {
  guestPath: string;
  hostPath: string;
  access: "read-only" | "read-write";
}

export interface PythonWasiExecutionRequest {
  scriptPath: string;
  argv: string[];
  cwd: string;
  env: Record<string, string>;
  stdin: string;
  pythonPath: string[];
  mounts: PythonWasiMount[];
  limits: PythonWasiExecutionLimits;
  capabilities: {
    directTcp: false;
    directUdp: false;
    fetch: false;
  };
  signal: AbortSignal;
}

export interface PythonWasiExecutionResult {
  exitCode: number;
  stdout: string;
  stderr: string;
  peakMemoryBytes?: number;
}

export interface PythonWasiRuntime {
  execute(request: PythonWasiExecutionRequest): Promise<PythonWasiExecutionResult>;
  dispose(): void;
}

export interface PythonWasiProjectAdapterOptions {
  projectRoot: string;
  stdlibRoot: string;
  loadRuntime(): Promise<PythonWasiRuntime>;
  allowedEnv?: string[];
  stdioBytes?: number;
  memoryBytes?: number;
  timeoutMs?: number;
}

export interface PythonWasiRunOptions {
  args?: string[];
  env?: Record<string, string>;
  stdin?: string;
  signal?: AbortSignal;
}

export class PythonWasiProjectAdapter {
  readonly projectRoot: string;
  readonly stdlibRoot: string;
  readonly limits: PythonWasiExecutionLimits;
  readonly boundary: WasiRuntimeBoundary;
  #loadRuntime: PythonWasiProjectAdapterOptions["loadRuntime"];

  constructor(options: PythonWasiProjectAdapterOptions) {
    this.projectRoot = normalizeAbsolute(options.projectRoot, "EPYTHONPROJECTPATH");
    this.stdlibRoot = normalizeAbsolute(options.stdlibRoot, "EPYTHONSTDLIBPATH");
    if (this.projectRoot === "/" || this.stdlibRoot === "/") {
      throw toolingError("EPYTHONPROJECTPATH", "Python project and stdlib roots must be narrower than the filesystem root");
    }
    if (isWithin(this.stdlibRoot, this.projectRoot) || isWithin(this.projectRoot, this.stdlibRoot)) {
      throw toolingError("EPYTHONSTDLIBPATH", "Python stdlib and project roots must not overlap");
    }
    this.limits = {
      stdioBytes: positiveLimit(options.stdioBytes ?? 1024 * 1024, "stdioBytes"),
      memoryBytes: positiveLimit(options.memoryBytes ?? 256 * 1024 * 1024, "memoryBytes"),
      timeoutMs: positiveLimit(options.timeoutMs ?? 10_000, "timeoutMs")
    };
    this.boundary = createWasiRuntimeBoundary({
      projectRoot: this.projectRoot,
      readableRoots: [this.projectRoot, this.stdlibRoot],
      writableRoots: [this.projectRoot],
      allowedEnv: options.allowedEnv ?? ["PYTHONIOENCODING", "PYTHONUTF8"],
      allowedEnvPrefixes: [],
      allowFetch: false,
      stdioCapacity: this.limits.stdioBytes
    });
    createWasiStdioLimits(this.boundary);
    this.#loadRuntime = options.loadRuntime;
  }

  async runScript(scriptPath: string, options: PythonWasiRunOptions = {}): Promise<PythonWasiExecutionResult> {
    const resolvedScript = this.#resolveProjectPath(scriptPath);
    const stdin = options.stdin ?? "";
    assertBytes(stdin, this.limits.stdioBytes, "EPYTHONSTDIOLIMIT", "Python stdin");
    const env = validateWasiEnv(this.boundary, options.env ?? {});
    throwIfAborted(options.signal);

    const controller = new AbortController();
    const forwardAbort = (): void => controller.abort(toolingError("EPYTHONCANCELLED", "Python execution was cancelled"));
    options.signal?.addEventListener("abort", forwardAbort, { once: true });
    const runtime = await this.#loadRuntime();
    const timeout = setTimeout(() => controller.abort(toolingError("EPYTHONTIMEOUT", `Python execution exceeded ${this.limits.timeoutMs} ms`)), this.limits.timeoutMs);

    try {
      const result = await raceAbort(runtime.execute({
        scriptPath: resolvedScript,
        argv: [resolvedScript, ...(options.args ?? [])],
        cwd: this.projectRoot,
        env,
        stdin,
        pythonPath: [this.projectRoot, this.stdlibRoot],
        mounts: [
          { guestPath: this.projectRoot, hostPath: this.projectRoot, access: "read-write" },
          { guestPath: this.stdlibRoot, hostPath: this.stdlibRoot, access: "read-only" }
        ],
        limits: { ...this.limits },
        capabilities: { directTcp: false, directUdp: false, fetch: false },
        signal: controller.signal
      }), controller.signal);
      assertBytes(result.stdout, this.limits.stdioBytes, "EPYTHONSTDIOLIMIT", "Python stdout");
      assertBytes(result.stderr, this.limits.stdioBytes, "EPYTHONSTDIOLIMIT", "Python stderr");
      if (result.peakMemoryBytes !== undefined && result.peakMemoryBytes > this.limits.memoryBytes) {
        throw toolingError("EPYTHONMEMORYLIMIT", `Python runtime exceeded ${this.limits.memoryBytes} bytes`);
      }
      return result;
    } finally {
      clearTimeout(timeout);
      options.signal?.removeEventListener("abort", forwardAbort);
      runtime.dispose();
    }
  }

  assertNetworkDenied(kind: "tcp" | "udp" | "fetch"): void {
    validateWasiNetwork(this.boundary, kind);
  }

  #resolveProjectPath(value: string): string {
    if (!value || value.includes("\0")) throw toolingError("EPYTHONPROJECTPATH", "Python script path must be non-empty and contain no NUL bytes");
    const resolved = normalize(value.startsWith("/") ? value : join(this.projectRoot, value));
    if (resolved !== this.projectRoot && !resolved.startsWith(`${this.projectRoot}/`)) {
      throw toolingError("EPYTHONPROJECTPATH", `Python script is outside the project: ${value}`);
    }
    return validateWasiFilesystemAccess(this.boundary, resolved, "read");
  }
}

export function createPythonWasiProjectAdapter(options: PythonWasiProjectAdapterOptions): PythonWasiProjectAdapter {
  return new PythonWasiProjectAdapter(options);
}

async function raceAbort(
  execution: Promise<PythonWasiExecutionResult>,
  signal: AbortSignal
): Promise<PythonWasiExecutionResult> {
  return await new Promise((resolve, reject) => {
    let settled = false;
    const finish = (callback: () => void): void => {
      if (settled) return;
      settled = true;
      signal.removeEventListener("abort", abort);
      callback();
    };
    const abort = (): void => {
      const reason = signal.reason;
      finish(() => reject(reason instanceof Error ? reason : toolingError("EPYTHONCANCELLED", "Python execution was cancelled")));
    };
    signal.addEventListener("abort", abort, { once: true });
    execution.then(
      (value) => finish(() => resolve(value)),
      (error: unknown) => finish(() => reject(error))
    );
    if (signal.aborted) abort();
  });
}

function throwIfAborted(signal?: AbortSignal): void {
  if (signal?.aborted) throw toolingError("EPYTHONCANCELLED", "Python execution was cancelled");
}

function normalizeAbsolute(value: string, code: string): string {
  if (!value.startsWith("/") || value.includes("\0")) throw toolingError(code, `path must be absolute and contain no NUL bytes: ${value}`);
  return normalize(value);
}

function isWithin(value: string, root: string): boolean {
  return value === root || value.startsWith(`${root}/`);
}

function positiveLimit(value: number, name: string): number {
  if (!Number.isSafeInteger(value) || value <= 0) throw toolingError("EPYTHONLIMIT", `invalid Python ${name}: ${value}`);
  return value;
}

function assertBytes(value: string, limit: number, code: string, label: string): void {
  if (new TextEncoder().encode(value).byteLength > limit) throw toolingError(code, `${label} exceeds ${limit} bytes`);
}

function toolingError(code: string, message: string): Error & { code: string } {
  return Object.assign(new Error(message), { code });
}
