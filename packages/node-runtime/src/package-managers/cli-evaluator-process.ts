import { createBuiltinLoader } from "../builtin-loader.ts";
import { Buffer as BrowserBuffer } from "../builtins/buffer.ts";
import { cryptoBuiltin } from "../builtins/crypto.ts";
import { EventEmitter } from "../builtins/events.ts";
import { join, normalize } from "../builtins/path.ts";
import { BrowserProcess } from "../builtins/process.ts";
import { fileURLToPath } from "../builtins/url.ts";
import { createWorkspaceModuleRuntime, type WorkspaceModuleReader } from "../modules/index.ts";
import type { ModuleRuntime } from "../modules/runtime.ts";
import type { RuntimeFsBinding, RuntimeNamespace, RuntimeValue } from "../types.ts";
import { createWorkspaceFsFacade } from "./cli-fs.ts";
import { MemoryPackageManagerWorkspace, type PackageManagerWorkspaceSnapshot, type PackageManagerWorkspaceWriter } from "./workspace.ts";
import { createCliModuleBuiltin, createCliPathBuiltin } from "./cli-evaluator-run.ts";
import type { AsyncCliModuleEvaluatorOptions, CliModuleEvaluatorOptions, CliNestedWorkerFactory, CliNestedWorkerPort, CliNestedWorkerRequest } from "./cli-evaluator.ts";

export function createCliWorkerThreadsBuiltin(options: {
  fs: RuntimeFsBinding;
  globals: Record<string, unknown>;
  nestedWorkerFactory?: CliNestedWorkerFactory;
  parentProcess: BrowserProcess;
  reader: WorkspaceModuleReader;
  root: string;
}): RuntimeNamespace {
  type InlineParentPort = EventEmitter & {
    postMessage: (value: unknown) => void;
    ref: () => InlineParentPort;
    unref: () => InlineParentPort;
  };

  class IsolatedWorker extends EventEmitter {
    readonly stdin = null;
    readonly stdout = null;
    readonly stderr = null;
    readonly resourceLimits = Object.freeze({});
    readonly threadId: number;
    readonly workerData: unknown;
    onerror: ((error: Error) => void) | null = null;
    onmessage: ((event: { data: unknown }) => void) | null = null;
    #port: CliNestedWorkerPort | null = null;
    #terminated = false;

    constructor(filename: string | URL, workerOptions: { eval?: boolean; workerData?: unknown } = {}) {
      super();
      this.threadId = nextInlineWorkerThreadId++;
      this.workerData = workerOptions.workerData;
      if (workerOptions.eval) {
        queueMicrotask(() => this.#fail(new Error("eval workers are not supported by CLI module evaluator")));
        return;
      }
      const snapshotReader = options.reader as WorkspaceModuleReader & { snapshot?: () => PackageManagerWorkspaceSnapshot };
      if (!snapshotReader.snapshot) {
        queueMicrotask(() => this.#fail(new Error("Nested CLI worker requires a snapshot-backed workspace")));
        return;
      }
      try {
        this.#port = options.nestedWorkerFactory!({
          filename: normalize(String(filename)),
          workerData: workerOptions.workerData,
          cwd: options.parentProcess.cwd(),
          env: { ...options.parentProcess.env },
          root: options.root,
          workspaceSnapshot: snapshotReader.snapshot()
        });
        this.#port.onMessage((value) => {
          if (this.#terminated) return;
          if (value && typeof value === "object" && "__nuriteoNestedWorkerError" in value) {
            this.#fail(new Error(String(value.__nuriteoNestedWorkerError)));
            return;
          }
          this.onmessage?.({ data: value });
          this.emit("message", value);
        });
        this.#port.onError((error) => {
          if (!this.#terminated) this.#fail(error);
        });
        this.#port.onExit((code) => {
          if (this.#terminated) return;
          this.#terminated = true;
          this.emit("exit", code);
        });
      } catch (error) {
        queueMicrotask(() => this.#fail(error instanceof Error ? error : new Error(String(error))));
      }
    }

    postMessage(value: unknown): void {
      if (!this.#terminated) this.#port?.postMessage(value);
    }

    terminate(): Promise<number> {
      if (this.#terminated) return Promise.resolve(0);
      this.#terminated = true;
      const result = this.#port?.terminate();
      this.emit("exit", 0);
      return Promise.resolve(result).then((code) => typeof code === "number" ? code : 0);
    }

    ref(): this { return this; }
    unref(): this { return this; }

    #fail(error: Error): void {
      this.onerror?.(error);
      this.emit("error", error);
    }
  }

  class InlineWorker extends EventEmitter {
    readonly stdin = null;
    readonly stdout = null;
    readonly stderr = null;
    readonly resourceLimits = Object.freeze({});
    readonly threadId: number;
    readonly workerData: unknown;
    onerror: ((event: Error) => void) | null = null;
    onmessage: ((event: { data: unknown }) => void) | null = null;
    #parentPort = new EventEmitter() as InlineParentPort;
    #terminated = false;

    constructor(filename: string | URL, workerOptions: { eval?: boolean; workerData?: unknown } = {}) {
      super();
      this.threadId = nextInlineWorkerThreadId++;
      this.workerData = workerOptions.workerData;
      if (workerOptions.eval) {
        queueMicrotask(() => this.#fail(new Error("eval workers are not supported by CLI module evaluator")));
        return;
      }

      this.#parentPort.postMessage = (value: unknown) => {
        void Promise.resolve(value).then((resolved) => {
          if (!this.#terminated) this.#dispatchMessage(resolved);
        }, (error) => {
          if (!this.#terminated) this.#dispatchError(error instanceof Error ? error : new Error(String(error)));
        });
      };
      this.#parentPort.ref = () => this.#parentPort;
      this.#parentPort.unref = () => this.#parentPort;
      try {
        const workerGlobal: Record<string, unknown> = {
          ...options.globals
        };
        const workerProcess = new BrowserProcess({
          argv: ["node", String(filename)],
          cwd: options.parentProcess.cwd(),
          emitExitInCapture: true,
          env: options.parentProcess.env,
          exitMode: "capture"
        });
        workerProcess.on("exit", (code) => {
          if (this.#terminated) return;
          this.#terminated = true;
          this.#parentPort.removeAllListeners();
          this.emit("exit", typeof code === "number" ? code : 0);
        });
        workerGlobal.global = workerGlobal;
        workerGlobal.globalThis = workerGlobal;
        workerGlobal.process = workerProcess;
        const workerThreads = createWorkerContextBuiltin(this.#parentPort, this.threadId, this.workerData);
        const runtime = createWorkspaceModuleRuntime({
          root: options.root,
          reader: options.reader,
          builtins: createBuiltinLoader({
            fs: options.fs,
            process: workerProcess,
            workerThreads
          }),
          globals: workerGlobal
        });
        runtime.requireSync(normalize(String(filename)), normalize(String(filename)));
      } catch (error) {
        queueMicrotask(() => this.#fail(error instanceof Error ? error : new Error(String(error))));
      }
    }

    postMessage(value: unknown): void {
      if (this.#terminated) return;
      queueMicrotask(() => this.#parentPort.emit("message", value));
    }

    terminate(): Promise<number> {
      if (this.#terminated) return Promise.resolve(0);
      this.#terminated = true;
      this.#parentPort.removeAllListeners();
      this.emit("exit", 0);
      return Promise.resolve(0);
    }

    ref(): this {
      return this;
    }

    unref(): this {
      return this;
    }

    #fail(error: Error): void {
      this.#dispatchError(error);
    }

    #dispatchError(error: Error): void {
      this.onerror?.(error);
      this.emit("error", error);
    }

    #dispatchMessage(value: unknown): void {
      this.onmessage?.({ data: value });
      this.emit("message", value);
    }
  }

  return Object.freeze({
    Worker: options.nestedWorkerFactory ? IsolatedWorker : InlineWorker,
    isMainThread: true,
    parentPort: null,
    threadId: 0,
    workerData: null
  });
}


function createWorkerContextBuiltin(parentPort: RuntimeValue, threadId: number, workerData: unknown): RuntimeNamespace {
  return Object.freeze({
    Worker: class UnsupportedNestedWorker extends EventEmitter {},
    isMainThread: false,
    parentPort,
    threadId,
    workerData
  });
}


export function createCliNestedWorkerRuntime(
  request: CliNestedWorkerRequest,
  bridge: { postMessage(value: unknown): void },
  options: Pick<CliModuleEvaluatorOptions, "precompiledCjsFactories" | "precompiledEsmFactories"> = {}
): { postMessage(value: unknown): void; ready: Promise<void> } {
  const workspace = MemoryPackageManagerWorkspace.fromSnapshot(request.workspaceSnapshot);
  const process = new BrowserProcess({
    argv: ["node", request.filename],
    cwd: request.cwd,
    env: request.env,
    exitMode: "capture"
  });
  const parentPort = new EventEmitter() as EventEmitter & {
    postMessage(value: unknown): void;
    ref(): EventEmitter;
    unref(): EventEmitter;
  };
  parentPort.postMessage = (value) => bridge.postMessage(value);
  parentPort.ref = () => parentPort;
  parentPort.unref = () => parentPort;
  const fs = createWorkspaceFsFacade(workspace, workspace, () => process.cwd());
  const workerThreads = createWorkerContextBuiltin(parentPort, nextInlineWorkerThreadId++, request.workerData);
  let runtime: ModuleRuntime | undefined;
  const workerGlobal: Record<string, RuntimeValue> = {
    AbortController,
    AbortSignal,
    ArrayBuffer,
    Blob,
    Buffer: BrowserBuffer,
    Crypto,
    CryptoKey,
    Error,
    File,
    FormData,
    Headers,
    ReadableStream,
    Request,
    Response,
    SharedArrayBuffer,
    SubtleCrypto,
    TextDecoder,
    TextEncoder,
    TransformStream,
    Uint8Array,
    URL,
    URLSearchParams,
    WebAssembly,
    WritableStream,
    __dynamicImport: createCliDynamicImport(() => runtime, request.root, request.filename),
    atob,
    btoa,
    crypto: cryptoBuiltin.webcrypto,
    navigator: { hardwareConcurrency: 4 },
    performance,
    queueMicrotask,
    setImmediate,
    setInterval,
    setTimeout,
    clearImmediate,
    clearInterval,
    clearTimeout,
    structuredClone
  };
  const consoleObject = createCliConsole(process);
  workerGlobal.console = consoleObject;
  workerGlobal.global = workerGlobal;
  workerGlobal.globalThis = workerGlobal;
  workerGlobal.process = process;
  const module = createCliModuleBuiltin(() => {
    if (!runtime) throw new Error("ERR_CLI_NESTED_WORKER_RUNTIME_NOT_READY");
    return runtime;
  });
  runtime = createWorkspaceModuleRuntime({
    allowAsyncRequireEsm: true,
    root: request.root,
    reader: workspace,
    builtins: createBuiltinLoader({
      console: consoleObject,
      fs,
      module,
      path: createCliPathBuiltin(process),
      process,
      workerThreads
    }),
    globals: workerGlobal
  });
  for (const [path, factory] of Object.entries(options.precompiledCjsFactories || {})) {
    runtime.register(path, { kind: "cjs", factory: (context) => factory(context, runtime!.globals) });
  }
  for (const [path, factory] of Object.entries(options.precompiledEsmFactories || {})) {
    runtime.register(path, { kind: "esm", factory: (context) => factory(context, runtime!.globals) });
  }
  const pending: unknown[] = [];
  let initialized = false;
  const ready = runtime.importModule(request.filename, request.filename).then(() => {
    initialized = true;
    for (const value of pending) parentPort.emit("message", value);
    pending.length = 0;
  });
  return {
    postMessage(value) {
      if (initialized) parentPort.emit("message", value);
      else pending.push(value);
    },
    ready
  };
}


let nextInlineWorkerThreadId = 1;

export function createCliTimerScope(): {
  builtin: RuntimeNamespace;
  clearImmediate: (handle: ReturnType<typeof setTimeout>) => void;
  clearInterval: (handle: ReturnType<typeof setInterval>) => void;
  clearTimeout: (handle: ReturnType<typeof setTimeout>) => void;
  dispose: () => void;
  promisesBuiltin: RuntimeNamespace;
  setImmediate: (callback: (...args: unknown[]) => void, ...args: unknown[]) => ReturnType<typeof setTimeout>;
  setInterval: (callback: (...args: unknown[]) => void, delay?: number, ...args: unknown[]) => ReturnType<typeof setInterval>;
  setTimeout: (callback: (...args: unknown[]) => void, delay?: number, ...args: unknown[]) => ReturnType<typeof setTimeout>;
} {
  const timeoutHandles = new Set<ReturnType<typeof setTimeout>>();
  const intervalHandles = new Set<ReturnType<typeof setInterval>>();
  const nativeHandles = new Map<ReturnType<typeof setTimeout>, ReturnType<typeof setTimeout>>();
  const scopedClearTimeout = (handle: ReturnType<typeof setTimeout>) => {
    timeoutHandles.delete(handle);
    clearTimeout(nativeHandles.get(handle) ?? handle);
    nativeHandles.delete(handle);
  };
  const scopedSetTimeout = (callback: (...args: unknown[]) => void, delay = 0, ...args: unknown[]) => {
    let handle: ReturnType<typeof setTimeout>;
    const nativeHandle = setTimeout(() => {
      timeoutHandles.delete(handle);
      nativeHandles.delete(handle);
      callback(...args);
    }, delay);
    handle = toNodeTimerHandle(nativeHandle);
    nativeHandles.set(handle, nativeHandle);
    timeoutHandles.add(handle);
    return handle;
  };
  const scopedClearInterval = (handle: ReturnType<typeof setInterval>) => {
    intervalHandles.delete(handle);
    clearInterval(nativeHandles.get(handle) ?? handle);
    nativeHandles.delete(handle);
  };
  const scopedSetInterval = (callback: (...args: unknown[]) => void, delay = 0, ...args: unknown[]) => {
    const nativeHandle = setInterval(callback, delay, ...args);
    const handle = toNodeTimerHandle(nativeHandle);
    nativeHandles.set(handle, nativeHandle);
    intervalHandles.add(handle);
    return handle;
  };
  const scopedSetImmediate = (callback: (...args: unknown[]) => void, ...args: unknown[]) => scopedSetTimeout(callback, 0, ...args);
  const dispose = () => {
    for (const handle of timeoutHandles) clearTimeout(nativeHandles.get(handle) ?? handle);
    for (const handle of intervalHandles) clearInterval(nativeHandles.get(handle) ?? handle);
    timeoutHandles.clear();
    intervalHandles.clear();
    nativeHandles.clear();
  };
  const builtin = Object.freeze({
    clearImmediate: scopedClearTimeout,
    clearInterval: scopedClearInterval,
    clearTimeout: scopedClearTimeout,
    default: {
      clearImmediate: scopedClearTimeout,
      clearInterval: scopedClearInterval,
      clearTimeout: scopedClearTimeout,
      setImmediate: scopedSetImmediate,
      setInterval: scopedSetInterval,
      setTimeout: scopedSetTimeout
    },
    setImmediate: scopedSetImmediate,
    setInterval: scopedSetInterval,
    setTimeout: scopedSetTimeout
  });
  const setTimeoutPromise = <T = void>(delay = 1, value?: T, options: { signal?: AbortSignal } = {}) => new Promise<T>((resolve, reject) => {
    if (options.signal?.aborted) {
      reject(options.signal.reason);
      return;
    }
    const handle = scopedSetTimeout(() => {
      options.signal?.removeEventListener("abort", onAbort);
      resolve(value as T);
    }, delay);
    const onAbort = () => {
      scopedClearTimeout(handle);
      options.signal?.removeEventListener("abort", onAbort);
      reject(options.signal?.reason);
    };
    options.signal?.addEventListener("abort", onAbort, { once: true });
  });
  const promisesBuiltin = Object.freeze({ default: { setTimeout: setTimeoutPromise }, setTimeout: setTimeoutPromise });
  return {
    builtin,
    clearImmediate: scopedClearTimeout,
    clearInterval: scopedClearInterval,
    clearTimeout: scopedClearTimeout,
    dispose,
    promisesBuiltin,
    setImmediate: scopedSetImmediate,
    setInterval: scopedSetInterval,
    setTimeout: scopedSetTimeout
  };
}


function toNodeTimerHandle(nativeHandle: ReturnType<typeof setTimeout>): ReturnType<typeof setTimeout> {
  if (typeof nativeHandle !== "number") return nativeHandle;
  let referenced = true;
  return {
    ref() { referenced = true; return this; },
    unref() { referenced = false; return this; },
    hasRef() { return referenced; },
    [Symbol.toPrimitive]() { return nativeHandle as number; }
  } as unknown as ReturnType<typeof setTimeout>;
}


export function errorMessage(error: unknown): string {
  return formatErrorWithCauses(error, new Set());
}


const maxCliOutputCharacters = 1_048_576;


export function appendCliOutput(current: string, chunk: unknown): string {
  if (current.length >= maxCliOutputCharacters) return current;
  const value = String(chunk);
  const remaining = maxCliOutputCharacters - current.length;
  if (value.length <= remaining) return current + value;
  return `${current}${value.slice(0, Math.max(0, remaining - 28))}\n[CLI output truncated]\n`;
}


function formatErrorWithCauses(error: unknown, seen: Set<unknown>): string {
  if (seen.has(error)) return "[Circular error cause]";
  seen.add(error);
  if (!(error instanceof Error)) return String(error);
  const parts = [error.stack || error.message];
  const errorWithCause = error as Error & { cause?: unknown; errors?: unknown[] };
  if (errorWithCause.cause !== undefined) {
    parts.push(`Caused by: ${formatErrorWithCauses(errorWithCause.cause, seen)}`);
  }
  if (Array.isArray(errorWithCause.errors)) {
    for (const nested of errorWithCause.errors) {
      parts.push(`Caused by: ${formatErrorWithCauses(nested, seen)}`);
    }
  }
  return parts.join("\n");
}


export function captureHostAsyncErrors(onError: (error: unknown) => void): () => void {
  const hostProcess = (globalThis as typeof globalThis & { process?: HostProcessLike }).process;
  if (!hostProcess?.on || !hostProcess.off) return () => undefined;

  const onUncaughtException = (error: unknown) => {
    onError(error);
  };
  const onUnhandledRejection = (reason: unknown) => {
    onError(reason);
  };
  hostProcess.on("uncaughtException", onUncaughtException);
  hostProcess.on("unhandledRejection", onUnhandledRejection);
  return () => {
    hostProcess.off?.("uncaughtException", onUncaughtException);
    hostProcess.off?.("unhandledRejection", onUnhandledRejection);
  };
}


export function createCliConsole(process: BrowserProcess): Console {
  const counts = new Map<string, number>();
  const timers = new Map<string, number>();
  const format = (value: unknown) => value instanceof Error ? value.stack || value.message : String(value);
  const stdout = (...values: unknown[]) => process.stdout.write(`${values.map(format).join(" ")}\n`);
  const stderr = (...values: unknown[]) => {
    if (values.length === 1 && parseProcessExit(errorMessage(values[0])) !== null) return;
    process.stderr.write(`${values.map(format).join(" ")}\n`);
  };
  return {
    assert(condition?: boolean, ...values: unknown[]) {
      if (!condition) stderr("Assertion failed", ...values);
    },
    count(label = "default") {
      const next = (counts.get(label) || 0) + 1;
      counts.set(label, next);
      stdout(`${label}: ${next}`);
    },
    countReset(label = "default") {
      counts.delete(label);
    },
    debug: stdout,
    dir(value: unknown) {
      stdout(typeof value === "string" ? value : JSON.stringify(value));
    },
    error(...values: unknown[]) {
      stderr(...values);
    },
    info: stdout,
    log(...values: unknown[]) {
      stdout(...values);
    },
    time(label = "default") {
      timers.set(label, performance.now());
    },
    timeEnd(label = "default") {
      const started = timers.get(label);
      if (started !== undefined) stdout(`${label}: ${performance.now() - started}ms`);
      timers.delete(label);
    },
    timeLog(label = "default", ...values: unknown[]) {
      const started = timers.get(label);
      if (started !== undefined) stdout(`${label}: ${performance.now() - started}ms`, ...values);
    },
    trace(...values: unknown[]) {
      stderr(...values);
    },
    warn(...values: unknown[]) {
      stderr(...values);
    }
  } as unknown as Console;
}


export async function settleCliEvaluation(options: AsyncCliModuleEvaluatorOptions): Promise<void> {
  const ticks = options.settleTicks ?? 8;
  const timeoutMs = options.settleTimeoutMs ?? 0;
  for (let index = 0; index < ticks; index += 1) {
    await Promise.resolve();
  }
  await new Promise((resolve) => setTimeout(resolve, timeoutMs));
}


export async function waitForCliEvaluationReady(
  ready: Promise<void>,
  options: AsyncCliModuleEvaluatorOptions
): Promise<{ timeoutMs: number } | null> {
  if (options.readyTimeoutMs === undefined) {
    await ready;
    return null;
  }
  const timeoutMs = options.readyTimeoutMs;
  let timeout: ReturnType<typeof setTimeout> | undefined;
  try {
    return await Promise.race([
      ready.then(() => null),
      new Promise<{ timeoutMs: number }>((resolve) => {
        timeout = setTimeout(() => resolve({ timeoutMs }), timeoutMs);
      })
    ]);
  } finally {
    if (timeout) clearTimeout(timeout);
  }
}


export async function waitForCliEvaluationExit(
  exited: Promise<void>,
  options: AsyncCliModuleEvaluatorOptions
): Promise<{ timeoutMs: number } | null> {
  if (options.exitTimeoutMs === undefined) {
    await exited;
    return null;
  }
  const timeoutMs = options.exitTimeoutMs;
  let timeout: ReturnType<typeof setTimeout> | undefined;
  try {
    return await Promise.race([
      exited.then(() => null),
      new Promise<{ timeoutMs: number }>((resolve) => {
        timeout = setTimeout(() => resolve({ timeoutMs }), timeoutMs);
      })
    ]);
  } finally {
    if (timeout) clearTimeout(timeout);
  }
}


export function createCliDynamicImport(
  getRuntime?: () => ModuleRuntime | undefined,
  root = "/workspace",
  parentUrl = join(root, "package.json")
): (specifier: string, parentOverride?: string) => Promise<RuntimeNamespace> {
  return async (specifier: string, parentOverride?: string): Promise<RuntimeNamespace> => {
    if (specifier === "chalk") return createChalkNamespace();
    if (specifier === "supports-color") return createSupportsColorNamespace();
    const packageSpecifier = packageSpecifierFromRootFileUrl(specifier, root);
    const runtime = getRuntime?.();
    if (runtime && specifier.startsWith("file:")) {
      const file = normalize(fileURLToPath(specifier));
      const normalizedRoot = normalize(root).replace(/\/$/, "");
      if (file === normalizedRoot || file.startsWith(`${normalizedRoot}/`)) {
        return runtime.importModule(file, file);
      }
    }
    if (packageSpecifier && runtime) {
      return runtime.importModule(packageSpecifier, join(root, "package.json"));
    }
    if (runtime && /^(?:@[^/]+\/)?[^./][^:]*$/.test(specifier)) {
      return runtime.importModule(specifier, parentOverride || parentUrl);
    }
    if (runtime && (specifier.startsWith("./") || specifier.startsWith("../") || specifier.startsWith("/"))) {
      return runtime.importModule(specifier, parentOverride || parentUrl);
    }
    throw new Error(`ERR_BROWSER_DYNAMIC_IMPORT_UNSUPPORTED: ${specifier}`);
  };
}


function packageSpecifierFromRootFileUrl(specifier: string, root: string): string | null {
  if (!specifier.startsWith("file:")) return null;
  const path = normalize(fileURLToPath(specifier));
  const prefix = `${normalize(root).replace(/\/$/, "")}/`;
  const packagePath = path.startsWith(prefix) ? path.slice(prefix.length) : path.replace(/^\//, "");
  const segments = packagePath.split("/").filter(Boolean);
  if (segments[0]?.startsWith("@") && segments[1]) return `${segments[0]}/${segments[1]}`;
  if (segments.length === 1 && segments[0]) return segments[0];
  return null;
}


function createChalkNamespace(): RuntimeNamespace {
  class Chalk {
    level: number;

    constructor(options: { level?: number } = {}) {
      this.level = options.level ?? 0;
      return createPassthroughChalk(this.level);
    }
  }

  const defaultChalk = createPassthroughChalk(0);
  return {
    Chalk,
    default: defaultChalk
  };
}


function createPassthroughChalk(level: number): ((...values: unknown[]) => string) & { level: number } {
  const chalk = ((...values: unknown[]) => values.join(" ")) as ((...values: unknown[]) => string) & { level: number };
  chalk.level = level;
  const proxy = new Proxy(chalk, {
    get(target, property, receiver) {
      if (property in target) return Reflect.get(target, property, receiver);
      return proxy;
    }
  });
  return proxy;
}


function createSupportsColorNamespace(): RuntimeNamespace {
  const createSupportsColor = () => ({ hasBasic: false, has256: false, has16m: false, level: 0 });
  return {
    createSupportsColor,
    default: {
      stdout: false,
      stderr: false
    },
    stdout: false,
    stderr: false
  };
}


export interface CliSpawnOptions {
  cwd?: string;
  env?: Record<string, string | undefined>;
  stdio?: "pipe" | "ignore" | "inherit" | readonly unknown[];
}


export type CliExecCallback = (error: Error | null, stdout: string | Uint8Array, stderr: string | Uint8Array) => void;


export interface CliChildCommandOptions {
  cwd: string;
  env: Record<string, string | undefined>;
  reader: WorkspaceModuleReader;
  writer?: PackageManagerWorkspaceWriter | undefined;
}


export interface CliChildCommandResult {
  stdout: string;
  stderr: string;
  exitCode: number;
  error?: Error;
}


interface HostProcessLike {
  on?(event: "uncaughtException" | "unhandledRejection", listener: (error: unknown) => void): unknown;
  off?(event: "uncaughtException" | "unhandledRejection", listener: (error: unknown) => void): unknown;
}


export function parseProcessExit(message: string): number | null {
  const match = message.match(/^(?:Error:\s*)?process\.exit\((\d+)\)(?:\n|$)/);
  return match ? Number(match[1]) : null;
}
