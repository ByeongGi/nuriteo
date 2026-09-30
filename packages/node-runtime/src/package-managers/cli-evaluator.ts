import { createBuiltinLoader } from "../builtin-loader.ts";
import { Buffer as BrowserBuffer } from "../builtins/buffer.ts";
import { ChildProcess, UnsupportedChildProcessError, type SpawnSyncResult } from "../builtins/child-process.ts";
import { cryptoBuiltin } from "../builtins/crypto.ts";
import { EventEmitter } from "../builtins/events.ts";
import { builtinModules, moduleBuiltin, Module as RuntimeModuleBuiltin } from "../builtins/module.ts";
import { dirname, join, normalize, pathBuiltin } from "../builtins/path.ts";
import { BrowserProcess } from "../builtins/process.ts";
import { fileURLToPath } from "../builtins/url.ts";
import { createWorkspaceModuleRuntime, type WorkspaceModuleReader } from "../modules/index.ts";
import type { ModuleRuntime } from "../modules/runtime.ts";
import type { StaticCjsFactoryRegistry } from "../modules/static-cjs-factory.ts";
import { createLoopbackNetwork, type LoopbackNetwork, type RuntimeHttpRequest, type RuntimeHttpResponse, type RuntimeWebSocket } from "../net/index.ts";
import type { CjsContext, CliEntry, CliRunResult, EsmContext, RuntimeEnv, RuntimeFsBinding, RuntimeNamespace, RuntimeValue } from "../types.ts";
import { inspectCliEntryReadiness } from "./cli-entry-readiness.ts";
import { createWorkspaceFsFacade, getCliFsWatchSummary, readWorkspaceBytes } from "./cli-fs.ts";
import { MemoryPackageManagerWorkspace, type PackageManagerWorkspaceSnapshot, type PackageManagerWorkspaceWriter } from "./workspace.ts";

export interface CliModuleEvaluatorOptions {
  precompiledCjsFactories?: Record<string, (context: CjsContext, globals: Record<string, RuntimeValue>) => void>;
  precompiledCjsFactoryRegistry?: StaticCjsFactoryRegistry;
  precompiledEsmFactories?: Record<string, (context: EsmContext, globals: Record<string, RuntimeValue>) => void | Promise<void>>;
  fsTrace?: CliEvaluationFsTraceEntry[];
  loopbackNetwork?: LoopbackNetwork;
  onOutputSnapshot?: (snapshot: () => CliEvaluationOutputSnapshot) => void;
  reader: WorkspaceModuleReader;
  globals?: Record<string, RuntimeValue>;
  onFsFacade?: (fs: RuntimeFsBinding) => void;
  root?: string;
  writer?: PackageManagerWorkspaceWriter;
  nestedWorkerFactory?: CliNestedWorkerFactory;
}

export interface CliNestedWorkerRequest {
  filename: string;
  workerData?: unknown;
  cwd: string;
  env: Record<string, string>;
  root: string;
  workspaceSnapshot: PackageManagerWorkspaceSnapshot;
}

export interface CliNestedWorkerPort {
  postMessage(value: unknown): void;
  terminate(): Promise<number> | void;
  onMessage(listener: (value: unknown) => void): void;
  onError(listener: (error: Error) => void): void;
  onExit(listener: (code: number) => void): void;
}

export type CliNestedWorkerFactory = (request: CliNestedWorkerRequest) => CliNestedWorkerPort;

export interface AsyncCliModuleEvaluatorOptions extends CliModuleEvaluatorOptions {
  exitTimeoutMs?: number;
  readyTimeoutMs?: number;
  settleTicks?: number;
  settleTimeoutMs?: number;
  waitForExit?: boolean;
}

export interface IsolatedAsyncCliModuleEvaluatorOptions extends Omit<AsyncCliModuleEvaluatorOptions, "reader" | "writer"> {
  workspace: MemoryPackageManagerWorkspace;
}

export interface IsolatedCliRunResult extends CliRunResult {
  bridgedServerPorts?: number[];
  capturedGlobalCalls?: CliEvaluationCapturedGlobalCall[];
  closeBridgedServers?: () => void;
  fsTrace?: CliEvaluationFsTraceEntry[];
  writeBridgedFile?: (path: string, data: string) => Promise<CliEvaluationFsWriteResult>;
  workspaceSnapshot: PackageManagerWorkspaceSnapshot;
}

export interface WorkerBackedAsyncCliModuleEvaluatorOptions extends Omit<AsyncCliModuleEvaluatorOptions, "globals" | "reader" | "writer"> {
  captureGlobalCalls?: readonly string[];
  traceFs?: boolean;
  workerFactory: CliEvaluationWorkerFactory;
  workerTimeoutMs?: number;
  workspace: MemoryPackageManagerWorkspace;
}

export interface CliEvaluationCapturedGlobalCall {
  args: unknown[];
  name: string;
}

export interface CliEvaluationFsTraceEntry {
  error?: string;
  op: string;
  path: string;
  result?: boolean | string;
}

export type CliEvaluationWorkerFactory = () => CliEvaluationWorkerPort;

export interface CliEvaluationWorkerPort {
  addEventListener(type: "message" | "error", listener: (event: MessageEvent | ErrorEvent) => void): void;
  removeEventListener(type: "message" | "error", listener: (event: MessageEvent | ErrorEvent) => void): void;
  postMessage(message: unknown): void;
  terminate(): void;
}

export type CliEvaluationWorkerMessage =
  | CliEvaluationWorkerEvaluateMessage
  | CliEvaluationWorkerHttpRequestMessage
  | CliEvaluationWorkerHttpResponseMessage
  | CliEvaluationWorkerFsWriteMessage
  | CliEvaluationWorkerFsWriteResultMessage
  | CliEvaluationWorkerWebSocketCloseMessage
  | CliEvaluationWorkerWebSocketConnectMessage
  | CliEvaluationWorkerWebSocketErrorMessage
  | CliEvaluationWorkerWebSocketMessage
  | CliEvaluationWorkerResultMessage;

export interface CliEvaluationWorkerEvaluateMessage {
  bridgeLoopbackServer?: boolean;
  captureGlobalCalls?: readonly string[];
  exitTimeoutMs?: number;
  id: number;
  readyTimeoutMs?: number;
  requiredPrecompiledCjsFactoryPaths?: readonly string[];
  request: CliModuleEvaluationRequest;
  root?: string;
  settleTicks?: number;
  settleTimeoutMs?: number;
  traceFs?: boolean;
  type: "cli:evaluate";
  waitForExit?: boolean;
  workspaceSnapshot: PackageManagerWorkspaceSnapshot;
}

export interface CliEvaluationWorkerResultMessage {
  error?: string;
  id: number;
  result?: IsolatedCliRunResult;
  type: "cli:result";
}

export interface CliEvaluationWorkerHttpRequestMessage {
  evaluationId: number;
  id: number;
  port: number;
  request: RuntimeHttpRequest;
  type: "cli:http:request";
}

export interface CliEvaluationWorkerHttpResponseMessage {
  error?: string;
  evaluationId: number;
  id: number;
  response?: RuntimeHttpResponse;
  type: "cli:http:response";
}

export interface CliEvaluationWorkerFsWriteMessage {
  data: string;
  evaluationId: number;
  id: number;
  path: string;
  type: "cli:fs:write";
}

export interface CliEvaluationWorkerFsWriteResultMessage {
  error?: string;
  evaluationId: number;
  id: number;
  result?: CliEvaluationFsWriteResult;
  type: "cli:fs:write:result";
}

export interface CliEvaluationFsWriteResult {
  output?: CliEvaluationOutputSnapshot;
  statWatcherCount: number;
  watcherCount: number;
  watchedPaths: string[];
}

export interface CliEvaluationOutputSnapshot {
  stderr: string;
  stdout: string;
}

export interface CliEvaluationWorkerWebSocketConnectMessage {
  evaluationId: number;
  headers?: Record<string, string>;
  id: number;
  path: string;
  port: number;
  protocol: string;
  type: "cli:ws:connect";
}

export interface CliEvaluationWorkerWebSocketMessage {
  data: string;
  evaluationId: number;
  id: number;
  type: "cli:ws:message";
}

export interface CliEvaluationWorkerWebSocketCloseMessage {
  evaluationId: number;
  id: number;
  type: "cli:ws:close";
}

export interface CliEvaluationWorkerWebSocketErrorMessage {
  error: string;
  evaluationId: number;
  id: number;
  type: "cli:ws:error";
}

export interface CliEvaluationHttpBridge {
  getOutput?(): CliEvaluationOutputSnapshot;
  handleRequest(port: number, request: RuntimeHttpRequest): Promise<RuntimeHttpResponse>;
  network: LoopbackNetwork;
  ports(): number[];
  writeFile?(path: string, data: string): CliEvaluationFsWriteResult;
}

export interface CliModuleEvaluationRequest {
  entry: CliEntry;
  args: string[];
  cwd: string;
  env?: RuntimeEnv;
}

export function createCliModuleEvaluator(options: CliModuleEvaluatorOptions): (request: CliModuleEvaluationRequest) => CliRunResult {
  return function evaluateCliModule(request: CliModuleEvaluationRequest): CliRunResult {
    return startCliModuleEvaluation(options, request, { supportedModes: ["cjs"] }).finalize();
  };
}

export function createAsyncCliModuleEvaluator(options: AsyncCliModuleEvaluatorOptions): (request: CliModuleEvaluationRequest) => Promise<CliRunResult> {
  return async function evaluateCliModuleAsync(request: CliModuleEvaluationRequest): Promise<CliRunResult> {
    const evaluation = startCliModuleEvaluation(options, request, { supportedModes: ["cjs", "esm"] });
    const readyTimeout = await waitForCliEvaluationReady(evaluation.ready, options);
    if (readyTimeout) {
      const result = evaluation.finalize();
      return {
        ...result,
        exitCode: 1,
        stderr: `${result.stderr}ECLIETIMEOUT: CLI module evaluation did not become ready within ${readyTimeout.timeoutMs}ms\n`
      };
    }
    if (options.waitForExit) {
      const exitTimeout = await waitForCliEvaluationExit(evaluation.exited, options);
      if (exitTimeout) {
        const result = evaluation.finalize();
        return {
          ...result,
          exitCode: 1,
          stderr: `${result.stderr}ECLIEXITTIMEOUT: CLI module evaluation did not exit within ${exitTimeout.timeoutMs}ms\n`
        };
      }
    }
    await settleCliEvaluation(options);
    return evaluation.finalize();
  };
}

export function createIsolatedAsyncCliModuleEvaluator(
  options: IsolatedAsyncCliModuleEvaluatorOptions
): (request: CliModuleEvaluationRequest) => Promise<IsolatedCliRunResult> {
  return async function evaluateCliModuleInSnapshot(request: CliModuleEvaluationRequest): Promise<IsolatedCliRunResult> {
    const workspace = MemoryPackageManagerWorkspace.fromSnapshot(options.workspace.snapshot());
    const result = await createAsyncCliModuleEvaluator({
      ...options,
      reader: workspace,
      writer: workspace
    })(request);
    return {
      ...result,
      workspaceSnapshot: workspace.snapshot()
    };
  };
}

export function createWorkerBackedAsyncCliModuleEvaluator(
  options: WorkerBackedAsyncCliModuleEvaluatorOptions
): (request: CliModuleEvaluationRequest) => Promise<IsolatedCliRunResult> {
  return function evaluateCliModuleInWorker(request: CliModuleEvaluationRequest): Promise<IsolatedCliRunResult> {
    const worker = options.workerFactory();
    const id = nextCliEvaluationWorkerRequestId++;
    return new Promise((resolve, reject) => {
      let timeout: ReturnType<typeof setTimeout> | undefined;
      const bridgedListeners: Array<{ close: () => void }> = [];
      const pendingHttpRequests = new Map<number, {
        reject: (error: Error) => void;
        resolve: (response: RuntimeHttpResponse) => void;
        timeout: ReturnType<typeof setTimeout>;
      }>();
      const pendingFsWrites = new Map<number, {
        reject: (error: Error) => void;
        resolve: (result: CliEvaluationFsWriteResult) => void;
      }>();
      let nextHttpRequestId = 1;
      let nextFsWriteId = 1;
      let nextWebSocketId = 1;
      const bridgedWebSockets = new Map<number, RuntimeWebSocket>();
      let closed = false;
      const cleanup = (error = new Error("ECLIBRIDGECLOSED: CLI evaluation worker bridge closed")) => {
        if (closed) return;
        closed = true;
        if (timeout) clearTimeout(timeout);
        for (const listener of bridgedListeners) listener.close();
        bridgedListeners.length = 0;
        for (const socket of bridgedWebSockets.values()) socket.close();
        bridgedWebSockets.clear();
        for (const request of pendingHttpRequests.values()) {
          clearTimeout(request.timeout);
          request.reject(error);
        }
        pendingHttpRequests.clear();
        for (const write of pendingFsWrites.values()) write.reject(error);
        pendingFsWrites.clear();
        worker.removeEventListener("message", onMessage);
        worker.removeEventListener("error", onError);
        worker.terminate();
      };
      const closeBridgedServers = () => cleanup();
      const writeBridgedFile = (path: string, data: string) => {
        if (closed) return Promise.reject(new Error("ECLIBRIDGECLOSED: CLI evaluation worker bridge closed"));
        const writeId = nextFsWriteId++;
        return new Promise<CliEvaluationFsWriteResult>((resolveWrite, rejectWrite) => {
          pendingFsWrites.set(writeId, {
            reject: rejectWrite,
            resolve: resolveWrite
          });
          worker.postMessage({
            data,
            evaluationId: id,
            id: writeId,
            path,
            type: "cli:fs:write"
          } satisfies CliEvaluationWorkerFsWriteMessage);
        });
      };
      const onMessage = (event: MessageEvent | ErrorEvent) => {
        const data = "data" in event ? event.data as Partial<CliEvaluationWorkerMessage> : undefined;
        if (data?.type === "cli:fs:write:result" && data.evaluationId === id) {
          if (typeof data.id !== "number") return;
          const pending = pendingFsWrites.get(data.id);
          if (!pending) return;
          pendingFsWrites.delete(data.id);
          if (data.error) pending.reject(new Error(data.error));
          else if (data.result) pending.resolve(data.result);
          else pending.reject(new Error("CLI evaluation worker returned no FS write result"));
          return;
        }
        if (data?.type === "cli:http:response" && data.evaluationId === id) {
          if (typeof data.id !== "number") return;
          const pending = pendingHttpRequests.get(data.id);
          if (!pending) return;
          pendingHttpRequests.delete(data.id);
          clearTimeout(pending.timeout);
          if (data.error) pending.reject(new Error(data.error));
          else if (data.response) pending.resolve(data.response);
          else pending.reject(new Error("CLI evaluation worker returned no HTTP response"));
          return;
        }
        if (data?.type === "cli:ws:message" && data.evaluationId === id) {
          if (typeof data.id !== "number") return;
          if (typeof data.data !== "string") return;
          const socket = bridgedWebSockets.get(data.id);
          if (socket) socket.send(data.data);
          return;
        }
        if (data?.type === "cli:ws:close" && data.evaluationId === id) {
          if (typeof data.id !== "number") return;
          const socket = bridgedWebSockets.get(data.id);
          bridgedWebSockets.delete(data.id);
          socket?.close();
          return;
        }
        if (data?.type === "cli:ws:error" && data.evaluationId === id) {
          if (typeof data.id !== "number") return;
          const socket = bridgedWebSockets.get(data.id);
          bridgedWebSockets.delete(data.id);
          socket?.close();
          return;
        }
        if (data?.type !== "cli:result" || data.id !== id) return;
        if (data.error) {
          cleanup();
          reject(new Error(data.error));
          return;
        }
        if (!data.result) {
          cleanup();
          reject(new Error("CLI evaluation worker returned no result"));
          return;
        }
        const bridgedPorts = options.loopbackNetwork ? data.result.bridgedServerPorts || [] : [];
        if (bridgedPorts.length === 0) {
          cleanup();
          resolve(data.result);
          return;
        }
        if (timeout) clearTimeout(timeout);
        for (const port of bridgedPorts) {
          bridgedListeners.push(options.loopbackNetwork!.listen(port, (request) => {
            const requestId = nextHttpRequestId++;
            return new Promise<RuntimeHttpResponse>((resolveRequest, rejectRequest) => {
              const requestLabel = `${request.method} ${request.path}`;
              const requestTimeout = setTimeout(() => {
                pendingHttpRequests.delete(requestId);
                rejectRequest(new Error(`ECLIHTTPBRIDGETIMEOUT: CLI evaluation worker did not respond to ${requestLabel} within 10000ms`));
              }, 10000);
              pendingHttpRequests.set(requestId, {
                reject: rejectRequest,
                resolve: resolveRequest,
                timeout: requestTimeout
              });
              worker.postMessage({
                evaluationId: id,
                id: requestId,
                port,
                request,
                type: "cli:http:request"
              } satisfies CliEvaluationWorkerHttpRequestMessage);
            });
          }, {
            websocket: (socket, request, context) => {
              const socketId = nextWebSocketId++;
              bridgedWebSockets.set(socketId, socket);
              socket.onmessage = (event) => {
                worker.postMessage({
                  data: event.data,
                  evaluationId: id,
                  id: socketId,
                  type: "cli:ws:message"
                } satisfies CliEvaluationWorkerWebSocketMessage);
              };
              socket.onclose = () => {
                bridgedWebSockets.delete(socketId);
                worker.postMessage({
                  evaluationId: id,
                  id: socketId,
                  type: "cli:ws:close"
                } satisfies CliEvaluationWorkerWebSocketCloseMessage);
              };
              worker.postMessage({
                evaluationId: id,
                headers: request.headers,
                id: socketId,
                path: request.path,
                port,
                protocol: context.protocol,
                type: "cli:ws:connect"
              } satisfies CliEvaluationWorkerWebSocketConnectMessage);
            }
          }));
        }
        resolve({
          ...data.result,
          closeBridgedServers,
          writeBridgedFile
        });
      };
      const onError = (event: MessageEvent | ErrorEvent) => {
        cleanup();
        reject(new Error("message" in event ? event.message : "CLI evaluation worker failed"));
      };
      worker.addEventListener("message", onMessage);
      worker.addEventListener("error", onError);
      if (options.workerTimeoutMs !== undefined) {
        timeout = setTimeout(() => {
          const error = new Error(`ECLIEWORKERTIMEOUT: CLI evaluation worker did not respond within ${options.workerTimeoutMs}ms`);
          cleanup(error);
          reject(error);
        }, options.workerTimeoutMs);
      }
      worker.postMessage({
        id,
        request,
        ...(options.root !== undefined ? { root: options.root } : {}),
        ...(options.exitTimeoutMs !== undefined ? { exitTimeoutMs: options.exitTimeoutMs } : {}),
        ...(options.readyTimeoutMs !== undefined ? { readyTimeoutMs: options.readyTimeoutMs } : {}),
        ...(options.settleTicks !== undefined ? { settleTicks: options.settleTicks } : {}),
        ...(options.settleTimeoutMs !== undefined ? { settleTimeoutMs: options.settleTimeoutMs } : {}),
        ...(options.captureGlobalCalls !== undefined ? { captureGlobalCalls: options.captureGlobalCalls } : {}),
        ...(options.loopbackNetwork ? { bridgeLoopbackServer: true } : {}),
        ...(options.traceFs ? { traceFs: true } : {}),
        ...(options.precompiledCjsFactoryRegistry ? { requiredPrecompiledCjsFactoryPaths: options.precompiledCjsFactoryRegistry.paths() } : {}),
        ...(options.waitForExit ? { waitForExit: true } : {}),
        type: "cli:evaluate",
        workspaceSnapshot: options.workspace.snapshot()
      } satisfies CliEvaluationWorkerEvaluateMessage);
    });
  };
}

export async function evaluateCliModuleWorkerMessage(
  message: CliEvaluationWorkerEvaluateMessage,
  options: {
    httpBridge?: CliEvaluationHttpBridge;
    nestedWorkerFactory?: CliNestedWorkerFactory;
    precompiledCjsFactories?: CliModuleEvaluatorOptions["precompiledCjsFactories"];
    precompiledCjsFactoryRegistry?: StaticCjsFactoryRegistry;
    precompiledEsmFactories?: CliModuleEvaluatorOptions["precompiledEsmFactories"];
  } = {}
): Promise<CliEvaluationWorkerResultMessage> {
  try {
    const availableFactoryPaths = new Set([
      ...Object.keys(options.precompiledCjsFactories || {}),
      ...(options.precompiledCjsFactoryRegistry?.paths() || [])
    ]);
    const missingFactory = message.requiredPrecompiledCjsFactoryPaths?.find((path) => !availableFactoryPaths.has(path));
    if (missingFactory) throw new Error(`ESTATICFACTORYWORKERMISSING: ${missingFactory}`);
    const workspace = MemoryPackageManagerWorkspace.fromSnapshot(message.workspaceSnapshot);
    const capturedGlobalCalls: CliEvaluationCapturedGlobalCall[] = [];
    const fsTrace: CliEvaluationFsTraceEntry[] = [];
    const result = await createAsyncCliModuleEvaluator({
      ...(message.traceFs ? { fsTrace } : {}),
      ...(message.captureGlobalCalls ? { globals: createCapturedGlobalCallHandlers(message.captureGlobalCalls, capturedGlobalCalls) } : {}),
      ...(options.httpBridge ? {
        onOutputSnapshot: (snapshot) => {
          options.httpBridge!.getOutput = snapshot;
        },
        onFsFacade: (fs) => {
          options.httpBridge!.writeFile = (path, data) => {
            fs.writeFileSync(path, data);
            return getCliFsWatchSummary(fs);
          };
        }
      } : {}),
      reader: workspace,
      ...(message.root !== undefined ? { root: message.root } : {}),
      ...(message.exitTimeoutMs !== undefined ? { exitTimeoutMs: message.exitTimeoutMs } : {}),
      ...(message.readyTimeoutMs !== undefined ? { readyTimeoutMs: message.readyTimeoutMs } : {}),
      ...(message.settleTicks !== undefined ? { settleTicks: message.settleTicks } : {}),
      ...(message.settleTimeoutMs !== undefined ? { settleTimeoutMs: message.settleTimeoutMs } : {}),
      ...(message.waitForExit ? { waitForExit: true } : {}),
      ...(options.httpBridge ? { loopbackNetwork: options.httpBridge.network } : {}),
      ...(options.nestedWorkerFactory ? { nestedWorkerFactory: options.nestedWorkerFactory } : {}),
      ...(options.precompiledCjsFactories ? { precompiledCjsFactories: options.precompiledCjsFactories } : {}),
      ...(options.precompiledCjsFactoryRegistry ? { precompiledCjsFactoryRegistry: options.precompiledCjsFactoryRegistry } : {}),
      ...(options.precompiledEsmFactories ? { precompiledEsmFactories: options.precompiledEsmFactories } : {}),
      writer: workspace
    })(message.request);
    return {
      id: message.id,
      result: {
        ...result,
        ...(options.httpBridge ? { bridgedServerPorts: options.httpBridge.ports() } : {}),
        ...(message.captureGlobalCalls ? { capturedGlobalCalls } : {}),
        ...(message.traceFs ? { fsTrace } : {}),
        workspaceSnapshot: workspace.snapshot()
      },
      type: "cli:result"
    };
  } catch (error) {
    return {
      error: errorMessage(error),
      id: message.id,
      type: "cli:result"
    };
  }
}

export function createCliEvaluationHttpBridge(): CliEvaluationHttpBridge {
  const network = createLoopbackNetwork();
  return {
    async handleRequest(port, request) {
      const response = await network.fetch(`http://127.0.0.1:${port}${request.path}`, {
        headers: request.headers,
        method: request.method,
        ...(request.body === undefined ? {} : { body: request.body })
      });
      const viteClientPath = viteInternalClientFsPath(request.path);
      if (response.statusCode !== 404 || !viteClientPath) return response;
      return network.fetch(`http://127.0.0.1:${port}${viteClientPath}`, {
        headers: request.headers,
        method: request.method,
        ...(request.body === undefined ? {} : { body: request.body })
      });
    },
    network,
    ports: () => [...network.listeners.keys()]
  };
}

function viteInternalClientFsPath(path: string): string | null {
  const normalizedPath = path.split("?")[0] || "/";
  if (normalizedPath === "/@vite/client") return "/@fs//workspace/project/node_modules/vite/dist/client/client.mjs";
  if (normalizedPath === "/@vite/env") return "/@fs//workspace/project/node_modules/vite/dist/client/env.mjs";
  return null;
}

function createCapturedGlobalCallHandlers(
  names: readonly string[],
  calls: CliEvaluationCapturedGlobalCall[]
): Record<string, RuntimeValue> {
  return Object.fromEntries(names.map((name) => [
    name,
    (...args: unknown[]) => {
      calls.push({ name, args: args.map((arg) => sanitizeWorkerResultValue(arg)) });
    }
  ]));
}

function sanitizeWorkerResultValue(value: unknown, seen = new Set<unknown>()): unknown {
  if (typeof value === "function") return { __cliFunctionRef: true };
  if (value === null || typeof value !== "object") return value;
  if (seen.has(value)) return { __cliCircularRef: true };
  seen.add(value);
  if (Array.isArray(value)) return value.map((item) => sanitizeWorkerResultValue(item, seen));
  return Object.fromEntries(Object.entries(value).map(([key, item]) => [key, sanitizeWorkerResultValue(item, seen)]));
}

function isPromiseLike(value: unknown): value is PromiseLike<unknown> {
  return (typeof value === "object" || typeof value === "function")
    && value !== null
    && typeof (value as { then?: unknown }).then === "function";
}

function startCliModuleEvaluation(
  options: CliModuleEvaluatorOptions,
  request: CliModuleEvaluationRequest,
  capabilities: { supportedModes: readonly ("cjs" | "esm")[] }
): { ready: Promise<void>; exited: Promise<void>; finalize: () => CliRunResult } {
  const readiness = inspectCliEntryReadiness({
    entry: request.entry,
    reader: options.reader,
    supportedModes: capabilities.supportedModes
  });
  if (readiness.status === "blocked") {
    return {
      ready: Promise.resolve(),
      exited: Promise.resolve(),
      finalize() {
        return {
          stdout: "",
          stderr: `${readiness.reasons.map((reason) => `${reason.code}: ${reason.message}`).join("\n")}\n`,
          exitCode: 1,
          entry: request.entry.entry,
          ...(request.entry.entrySha256 ? { entrySha256: request.entry.entrySha256 } : {})
        };
      }
    };
  }

  let stdout = "";
  let stderr = "";
  let asyncExitCode: number | undefined;
  const capturesExit = request.entry.name === "npm" || request.entry.name === "webpack";
  const processOptions = {
    argv: ["node", request.entry.entry, ...request.args],
    cwd: request.cwd,
    // A thrown sentinel is catchable by userland. npm catches it after its
    // exit handler has reset, then runs the handler a second time and reports
    // "Exit prior to setting npm". Capture the request and emit the exit event
    // instead; the evaluator treats that explicit request as authoritative.
    // pnpm/Yarn use the thrown sentinel to stop their bundled top-level flow.
    // npm catches that sentinel inside its own exit handler, while webpack-cli
    // issues exits from async command actions; both use the exit-event path.
    exitMode: capturesExit ? "capture" as const : "throw" as const,
    ...(capturesExit ? { emitExitInCapture: true } : {}),
    ...(request.env ? { env: request.env } : {})
  };
  const process = new BrowserProcess(processOptions);
  const timerScope = createCliTimerScope();
  let requestedExitCode: number | undefined;
  let resolveExited!: () => void;
  const exited = new Promise<void>((resolve) => {
    resolveExited = resolve;
  });
  process.on("exit", (code) => {
    requestedExitCode = typeof code === "number" ? code : process.exitCode ?? 0;
    resolveExited();
  });
  options.onOutputSnapshot?.(() => ({ stderr, stdout }));
  process.on("stdout", (chunk) => {
    stdout = appendCliOutput(stdout, chunk);
  });
  process.on("stderr", (chunk) => {
    stderr = appendCliOutput(stderr, chunk);
  });
  const restoreHostErrorCapture = captureHostAsyncErrors((error) => {
    const message = errorMessage(error);
    const processExit = parseProcessExit(message);
    asyncExitCode = processExit ?? 1;
    if (processExit === null) stderr = appendCliOutput(stderr, `${message}\n`);
    resolveExited();
  });
  let runtime: ModuleRuntime | undefined;
  const generatedModuleBridge = createGeneratedCjsModuleBridge({
    getRuntime: () => {
      if (!runtime) throw new Error("ERR_CLI_MODULE_RUNTIME_NOT_READY");
      return runtime;
    },
    reader: options.reader,
    root: options.root || "/workspace"
  });
  const globalObject: Record<string, unknown> = {
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
    Promise,
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
    __dynamicImport: createCliDynamicImport(() => runtime, options.root || "/workspace", request.entry.entry),
    __nuriteoImportGeneratedModule: generatedModuleBridge.importModule,
    __nuriteoImportEdgeModule: generatedModuleBridge.importEdgeModule,
    __nuriteoImportWorkspaceModule: generatedModuleBridge.importWorkspaceModule,
    __nuriteoParseWebpackMagicComment: parseWebpackMagicComment,
    atob,
    btoa,
    clearImmediate: timerScope.clearImmediate,
    clearInterval: timerScope.clearInterval,
    clearTimeout: timerScope.clearTimeout,
    crypto: cryptoBuiltin.webcrypto,
    fetch: createCliWorkspaceFetch(options.reader),
    navigator: {
      hardwareConcurrency: 4
    },
    performance,
    queueMicrotask,
    setImmediate: timerScope.setImmediate,
    setInterval: timerScope.setInterval,
    setTimeout: timerScope.setTimeout,
    structuredClone,
    ...(options.globals || {})
  };
  const consoleObject = createCliConsole(process);
  globalObject.console = consoleObject;
  globalObject.global = globalObject;
  globalObject.globalThis = globalObject;
  globalObject.process = process;
  const fs = createWorkspaceFsFacade(options.reader, options.writer, () => process.cwd(), options.fsTrace);
  options.onFsFacade?.(fs);

  const workerThreads = createCliWorkerThreadsBuiltin({
    fs,
    globals: globalObject,
    ...(options.nestedWorkerFactory ? { nestedWorkerFactory: options.nestedWorkerFactory } : {}),
    parentProcess: process,
    reader: options.reader,
    root: options.root || "/workspace"
  });
  const childProcess = createCliChildProcessBuiltin({
    env: request.env || {},
    getRuntime: () => {
      if (!runtime) throw new Error("ERR_CLI_MODULE_RUNTIME_NOT_READY");
      return runtime;
    },
    parentProcess: process,
    reader: options.reader,
    root: options.root || "/workspace",
    writer: options.writer
  });

  const module = createCliModuleBuiltin(() => {
    if (!runtime) throw new Error("ERR_CLI_MODULE_RUNTIME_NOT_READY");
    return runtime;
  });
  runtime = createWorkspaceModuleRuntime({
    allowAsyncRequireEsm: true,
    root: options.root || "/workspace",
    reader: options.reader,
    builtins: createBuiltinLoader({
      childProcess,
      console: consoleObject,
      fs,
      ...(options.loopbackNetwork ? { httpServerNetwork: options.loopbackNetwork } : {}),
      module,
      path: createCliPathBuiltin(process),
      process,
      timers: timerScope.builtin,
      timersPromises: timerScope.promisesBuiltin,
      workerThreads
    }),
    globals: {
      Buffer: BrowserBuffer,
      __dynamicImport: globalObject.__dynamicImport,
      console: consoleObject,
      crypto: cryptoBuiltin.webcrypto,
      global: globalObject,
      globalThis: globalObject,
      process
    }
  });
  const precompiledFactories = {
    ...(options.precompiledCjsFactoryRegistry?.factories() || {}),
    ...(options.precompiledCjsFactories || {})
  };
  for (const [path, factory] of Object.entries(precompiledFactories)) {
    runtime.register(path, { kind: "cjs", factory: (context) => factory(context, runtime!.globals) });
  }
  for (const [path, factory] of Object.entries(options.precompiledEsmFactories || {})) {
    runtime.register(path, { kind: "esm", factory: (context) => factory(context, runtime!.globals) });
  }

  let exitCode = 0;
  let ready = Promise.resolve();
  try {
    if (readiness.mode === "esm") {
      ready = runtime.importModule(request.entry.entry, request.entry.entry).then(() => undefined, (error) => {
        asyncExitCode = 1;
        stderr = appendCliOutput(stderr, `${errorMessage(error)}\n`);
      });
    } else {
      const entryExports = runtime.requireSync(request.entry.entry, request.entry.entry);
      const pendingReady: Promise<unknown>[] = [];
      if (isPromiseLike(entryExports)) pendingReady.push(Promise.resolve(entryExports));
      const cjsReady = globalObject.__nuriteoCliReady;
      if (isPromiseLike(cjsReady)) pendingReady.push(Promise.resolve(cjsReady));
      if (pendingReady.length > 0) {
        const trackedReady = Promise.all(pendingReady).then(() => undefined, (error) => {
          asyncExitCode = 1;
          stderr = appendCliOutput(stderr, `${errorMessage(error)}\n`);
        });
        if (!isPromiseLike(entryExports) && (request.args[0] === "dev" || request.args[0] === "start")) trackedReady.catch(() => undefined);
        else ready = trackedReady;
      }
    }
  } catch (error) {
    const message = errorMessage(error);
    const exit = parseProcessExit(message);
    if (exit !== null) {
      exitCode = exit;
    } else {
      exitCode = 1;
      stderr = appendCliOutput(stderr, `${message}\n`);
    }
  }

  return {
    ready,
    exited,
    finalize() {
      restoreHostErrorCapture();
      if (asyncExitCode !== undefined) exitCode = asyncExitCode;
      if (process.exitCode !== undefined) exitCode = process.exitCode;
      // Some legacy CLIs catch the sentinel thrown by process.exit(), log it,
      // and overwrite exitCode. The explicit exit request is authoritative.
      if (requestedExitCode !== undefined) exitCode = requestedExitCode;
      const result: CliRunResult = {
        stdout,
        stderr,
        exitCode,
        entry: request.entry.entry,
        ...(request.entry.entrySha256 ? { entrySha256: request.entry.entrySha256 } : {})
      };
      Object.defineProperty(result, "dispose", { value: timerScope.dispose });
      return result;
    }
  };
}

function parseWebpackMagicComment(source: string): Record<string, RuntimeValue> {
  const options: Record<string, RuntimeValue> = {};
  const pattern = /(?:^|,)\s*([A-Za-z_$][\w$]*)\s*:\s*("(?:\\.|[^"\\])*"|'(?:\\.|[^'\\])*'|true|false|-?\d+(?:\.\d+)?)/g;
  for (const match of source.matchAll(pattern)) {
    const key = match[1]!;
    const literal = match[2]!;
    if (literal === "true" || literal === "false") options[key] = literal === "true";
    else if (literal.startsWith('"')) options[key] = JSON.parse(literal);
    else if (literal.startsWith("'")) options[key] = literal.slice(1, -1).replace(/\\'/g, "'").replace(/\\\\/g, "\\");
    else options[key] = Number(literal);
  }
  return options;
}

interface GeneratedCjsModuleBridgeOptions {
  getRuntime(): ModuleRuntime;
  reader: WorkspaceModuleReader;
  root: string;
}

interface GeneratedCjsModuleRecord {
  exports: RuntimeValue;
  loaded: boolean;
}

function createGeneratedCjsModuleBridge(options: GeneratedCjsModuleBridgeOptions): {
  importEdgeModule(path: string, context: Record<string, RuntimeValue>): Promise<void>;
  importModule(path: string): Promise<RuntimeValue>;
  importWorkspaceModule(path: string): Promise<RuntimeValue>;
} {
  const hostGlobal = globalThis as unknown as Record<string, unknown>;
  const bridges = hostGlobal.__nuriteoGeneratedModuleBridges instanceof Map
    ? hostGlobal.__nuriteoGeneratedModuleBridges as Map<string, unknown>
    : new Map<string, unknown>();
  hostGlobal.__nuriteoGeneratedModuleBridges = bridges;
  const token = `${Date.now().toString(36)}-${Math.random().toString(36).slice(2)}`;
  const factories = new Map<string, (...args: RuntimeValue[]) => void>();
  const cache = new Map<string, GeneratedCjsModuleRecord>();
  let edgeImportSequence = 0;
  const bridge: {
    edgeContext?: Record<string, RuntimeValue>;
    edgeRequire?: (specifier: string) => RuntimeValue;
    register(path: string, factory: (...args: RuntimeValue[]) => void): void;
  } = {
    register(path: string, factory: (...args: RuntimeValue[]) => void): void {
      factories.set(path, factory);
    }
  };
  bridges.set(token, bridge);

  const execute = (path: string): RuntimeValue => {
    const existing = cache.get(path);
    if (existing) return existing.exports;
    const factory = factories.get(path);
    if (!factory) throw new Error(`ERR_CLI_GENERATED_MODULE_NOT_REGISTERED: ${path}`);
    const module: GeneratedCjsModuleRecord = { exports: {}, loaded: false };
    cache.set(path, module);
    const runtime = options.getRuntime();
    const require = Object.assign(
      (specifier: string): RuntimeValue => {
        if (builtinModules.includes(specifier)) return runtime.requireSync(specifier, path);
        const resolved = runtime.resolve(specifier, path);
        return factories.has(resolved) ? execute(resolved) : runtime.requireSync(specifier, path);
      },
      {
        cache: new Proxy(Object.create(null) as Record<string, GeneratedCjsModuleRecord>, {
          deleteProperty(_target, property) {
            if (typeof property === "string") cache.delete(property);
            return true;
          },
          get(_target, property) {
            return typeof property === "string" ? cache.get(property) : undefined;
          },
          has(_target, property) {
            return typeof property === "string" && cache.has(property);
          },
          ownKeys() {
            return [...cache.keys()];
          },
          getOwnPropertyDescriptor(_target, property) {
            const value = typeof property === "string" ? cache.get(property) : undefined;
            return value ? { configurable: true, enumerable: true, value } : undefined;
          }
        }),
        resolve: (specifier: string): string => runtime.resolve(specifier, path)
      }
    );
    const globals = runtime.globals;
    try {
      factory.call(
        module.exports,
        module.exports,
        require,
        module,
        path,
        dirname(path),
        globals.process,
        globals.global,
        globals.console ?? console,
        globals.Buffer,
        (globals.global as Record<string, RuntimeValue> | undefined)?.setTimeout,
        (globals.global as Record<string, RuntimeValue> | undefined)?.clearTimeout,
        (globals.global as Record<string, RuntimeValue> | undefined)?.setInterval,
        (globals.global as Record<string, RuntimeValue> | undefined)?.clearInterval,
        (globals.global as Record<string, RuntimeValue> | undefined)?.setImmediate,
        (globals.global as Record<string, RuntimeValue> | undefined)?.clearImmediate
      );
      module.loaded = true;
      return module.exports;
    } catch (error) {
      cache.delete(path);
      throw error;
    }
  };

  const importSource = async (source: string): Promise<void> => {
    if (typeof caches === "undefined") {
      throw new Error("ECLICSPUNSUPPORTED: Cache Storage is required for generated CommonJS modules");
    }
    const digest = await crypto.subtle.digest("SHA-256", new TextEncoder().encode(source));
    const hash = Array.from(new Uint8Array(digest), (byte) => byte.toString(16).padStart(2, "0")).join("");
    const url = new URL(`/__nuriteo_runtime_module/${token}/${hash}.mjs`, location.origin).href;
    const storage = await caches.open("nuriteo-runtime-modules-v1");
    await storage.put(url, new Response(source, {
      headers: {
        "Content-Type": "text/javascript; charset=utf-8",
        "Cross-Origin-Resource-Policy": "same-origin",
        "Cross-Origin-Embedder-Policy": "require-corp"
      }
    }));
    await import(/* @vite-ignore */ url);
    await storage.delete(url);
  };

  const registerFiles = async (files: string[]): Promise<void> => {
    await importSource(createGeneratedCjsModuleSource(token, files, options.reader));
  };

  return {
    async importEdgeModule(path: string, context: Record<string, RuntimeValue>): Promise<void> {
      const normalized = normalize(path);
      const hadHostBuffer = Object.hasOwn(hostGlobal, "Buffer");
      const hadHostProcess = Object.hasOwn(hostGlobal, "process");
      const previousHostBuffer = hostGlobal.Buffer;
      const previousHostProcess = hostGlobal.process;
      bridge.edgeContext = context;
      bridge.edgeRequire = (specifier: string) => options.getRuntime().requireSync(specifier, normalized);
      const edgeSource = options.reader.readText(normalized);
      const source = `const __nuriteoBridge = globalThis.__nuriteoGeneratedModuleBridges.get(${JSON.stringify(token)});\nconst __nuriteoContext = __nuriteoBridge.edgeContext;\nglobalThis.process = __nuriteoContext.process;\nglobalThis.Buffer = __nuriteoContext.Buffer;\nglobalThis.AsyncLocalStorage = __nuriteoContext.AsyncLocalStorage;\nglobalThis._ENTRIES = __nuriteoContext._ENTRIES || {};\nglobalThis.webpackChunk_N_E = __nuriteoContext.webpackChunk_N_E || [];\nconst self = globalThis;\nconst global = __nuriteoContext;\nconst process = __nuriteoContext.process;\nconst Buffer = __nuriteoContext.Buffer;\nconst require = __nuriteoBridge.edgeRequire;\n${edgeSource}\nconst __nuriteoEntries = Object.assign(globalThis._ENTRIES, typeof _ENTRIES === "undefined" ? {} : _ENTRIES, __nuriteoContext._ENTRIES || {});\n__nuriteoContext._ENTRIES = __nuriteoEntries;\n__nuriteoContext.webpackChunk_N_E = globalThis.webpackChunk_N_E;\nexport default true;\n//# nuriteoEdgeImport=${edgeImportSequence++}\n//# sourceURL=${normalized}\n`;
      try {
        await importSource(source);
      } finally {
        if (hadHostBuffer) hostGlobal.Buffer = previousHostBuffer;
        else delete hostGlobal.Buffer;
        if (hadHostProcess) hostGlobal.process = previousHostProcess;
        else delete hostGlobal.process;
        delete bridge.edgeContext;
        delete bridge.edgeRequire;
      }
    },
    async importModule(path: string): Promise<RuntimeValue> {
      const files = listGeneratedCjsFiles(options.reader, generatedServerRoot(path));
      if (!files.includes(path)) files.push(path);
      await registerFiles(files);
      for (const file of files) cache.delete(file);
      const serverRoot = generatedServerRoot(path);
      const webpackRuntimePath = `${serverRoot}/webpack-runtime.js`;
      if (factories.has(webpackRuntimePath)) {
        const webpackRuntime = execute(webpackRuntimePath) as { C?: (chunk: RuntimeValue) => void };
        if (typeof webpackRuntime.C === "function") {
          for (const file of files) {
            if (!file.startsWith(`${serverRoot}/vendor-chunks/`) && !file.startsWith(`${serverRoot}/chunks/`)) continue;
            webpackRuntime.C(execute(file));
          }
        }
      }
      return execute(path);
    },
    async importWorkspaceModule(path: string): Promise<RuntimeValue> {
      const normalized = normalize(path);
      await registerFiles([normalized]);
      cache.delete(normalized);
      return execute(normalized);
    }
  };
}

function generatedServerRoot(path: string): string {
  const marker = "/.next/server/";
  const index = path.indexOf(marker);
  if (index < 0) throw new Error(`ERR_CLI_GENERATED_MODULE_OUTSIDE_NEXT_SERVER: ${path}`);
  return path.slice(0, index + marker.length - 1);
}

function listGeneratedCjsFiles(reader: WorkspaceModuleReader, root: string): string[] {
  const files: string[] = [];
  const visit = (directory: string): void => {
    for (const entry of reader.listDir(directory)) {
      const path = join(directory, entry);
      if (reader.isFile?.(path)) {
        if (path.endsWith(".js") || path.endsWith(".cjs")) files.push(path);
        continue;
      }
      try {
        visit(path);
      } catch {
        // Concurrent dev rebuilds can replace a directory between listing and reading.
      }
    }
  };
  visit(root);
  return files.sort();
}

function createGeneratedCjsModuleSource(token: string, paths: readonly string[], reader: WorkspaceModuleReader): string {
  const prelude = `const __nuriteoBridge = globalThis.__nuriteoGeneratedModuleBridges.get(${JSON.stringify(token)});\n`;
  return prelude + paths.map((path) => {
    let source = reader.readText(path).replace(/^#![^\n]*(?:\n|$)/, "");
    if (path.endsWith("/webpack-runtime.js")) {
      const invocation = "__webpack_modules__[moduleId](module, module.exports, __webpack_require__);";
      source = source.replace(invocation, `if (typeof __webpack_modules__[moduleId] !== "function") {
        throw new TypeError("ERR_NEXT_WEBPACK_MODULE_MISSING: " + moduleId);
      }
      ${invocation}`);
    }
    return `// ${path}\n__nuriteoBridge.register(${JSON.stringify(path)}, function(exports, require, module, __filename, __dirname, process, global, console, Buffer, setTimeout, clearTimeout, setInterval, clearInterval, setImmediate, clearImmediate) {\n${source}\n});\n`;
  }).join("") + "export default true;\n";
}

function createCliModuleBuiltin(getRuntime: () => ModuleRuntime): RuntimeNamespace {
  const createRequire = (filename: string | URL): ((specifier: string) => RuntimeValue) & {
    cache: RuntimeValue;
    extensions: RuntimeValue;
    resolve: ((specifier: string) => string) & { paths: (specifier?: string) => string[] };
  } => {
    const parentUrl = normalizeCreateRequireFilename(filename);
    const require = ((specifier: string) => getRuntime().requireSync(specifier, parentUrl)) as ReturnType<typeof createRequire>;
    require.resolve = Object.assign(
      (specifier: string) => builtinModules.includes(specifier) ? specifier : getRuntime().resolve(specifier, parentUrl),
      {
        paths: () => RuntimeModuleBuiltin._nodeModulePaths(dirname(parentUrl))
      }
    );
    require.cache = RuntimeModuleBuiltin._cache;
    require.extensions = RuntimeModuleBuiltin._extensions;
    return require;
  };

  const resolveFilename = (request: string, parent?: { filename?: string } | null): string => {
    if (builtinModules.includes(request)) return request;
    return getRuntime().resolve(request, parent?.filename ? normalize(parent.filename) : "/workspace/index.cjs");
  };

  class CliModule extends RuntimeModuleBuiltin {
    override require(specifier: string): RuntimeValue {
      return getRuntime().requireSync(specifier, this.filename || "/workspace/index.cjs");
    }
  }
  return Object.assign(CliModule, moduleBuiltin, {
    Module: CliModule,
    default: CliModule,
    _resolveFilename: resolveFilename,
    createRequire
  }) as unknown as RuntimeNamespace;
}

function createCliWorkspaceFetch(reader: WorkspaceModuleReader): (input: string | URL) => Promise<{
  arrayBuffer: () => Promise<ArrayBuffer>;
  ok: boolean;
  status: number;
  statusText: string;
  text: () => Promise<string>;
}> {
  const encoder = new TextEncoder();
  const decoder = new TextDecoder();
  return async (input) => {
    const path = normalizeFetchPath(input);
    try {
      const bytes = readWorkspaceBytes(reader, path, encoder);
      return {
        arrayBuffer: async () => toArrayBuffer(bytes),
        ok: true,
        status: 200,
        statusText: "OK",
        text: async () => decoder.decode(bytes)
      };
    } catch {
      return {
        arrayBuffer: async () => new ArrayBuffer(0),
        ok: false,
        status: 404,
        statusText: "Not Found",
        text: async () => ""
      };
    }
  };
}

function toArrayBuffer(bytes: Uint8Array): ArrayBuffer {
  const buffer = new ArrayBuffer(bytes.byteLength);
  new Uint8Array(buffer).set(bytes);
  return buffer;
}

function normalizeFetchPath(input: string | URL): string {
  const value = String(input);
  if (value.startsWith("file:")) return normalize(fileURLToPath(value));
  if (value.startsWith("/")) return normalize(value);
  throw new Error(`ECLIFETCHUNSUPPORTED: only workspace file fetch is supported: ${value}`);
}

function normalizeCreateRequireFilename(filename: string | URL): string {
  const value = String(filename);
  if (value.startsWith("file:")) return normalize(fileURLToPath(value));
  return normalize(value);
}

function createCliChildProcessBuiltin(options: {
  env: RuntimeEnv;
  getRuntime: () => ModuleRuntime;
  parentProcess: BrowserProcess;
  reader: WorkspaceModuleReader;
  root: string;
  writer?: PackageManagerWorkspaceWriter | undefined;
}): RuntimeNamespace {
  let nextPid = 100;

  const spawn = (command: string, args: readonly string[] = [], spawnOptions: CliSpawnOptions = {}): ChildProcess => {
    const child = new ChildProcess();
    child.pid = nextPid++;
    queueMicrotask(() => {
      const result = runCliChildCommand(command, args, {
        cwd: spawnOptions.cwd || options.parentProcess.cwd(),
        env: { ...options.env, ...(spawnOptions.env || {}) },
        reader: options.reader,
        writer: options.writer
      });
      if (result.error) {
        child.emit("error", result.error);
      } else {
        if (spawnOptions.stdio === "inherit") {
          if (result.stdout) options.parentProcess.stdout.write(result.stdout);
          if (result.stderr) options.parentProcess.stderr.write(result.stderr);
        }
        if (result.stdout) child.stdout.push(result.stdout);
        if (result.stderr) child.stderr.push(result.stderr);
        child.stdout.push(null);
        child.stderr.push(null);
      }
      child.exitCode = result.exitCode;
      child.emit("exit", result.exitCode, null);
      child.emit("close", result.exitCode, null);
    });
    return child;
  };

  const execFile = (
    file: string,
    argsOrCallback?: readonly string[] | CliExecCallback,
    optionsOrCallback?: CliSpawnOptions | CliExecCallback,
    maybeCallback?: CliExecCallback
  ): ChildProcess => {
    const args = Array.isArray(argsOrCallback) ? argsOrCallback : [];
    const spawnOptions = typeof optionsOrCallback === "object" ? optionsOrCallback : {};
    const callback = typeof argsOrCallback === "function"
      ? argsOrCallback
      : typeof optionsOrCallback === "function"
        ? optionsOrCallback
        : maybeCallback;
    const child = spawn(file, args, spawnOptions);
    if (callback) wireExecCallback(child, callback);
    return child;
  };

  const exec = (
    command: string,
    optionsOrCallback?: CliSpawnOptions | CliExecCallback,
    maybeCallback?: CliExecCallback
  ): ChildProcess => {
    const callback = typeof optionsOrCallback === "function" ? optionsOrCallback : maybeCallback;
    const child = spawn("sh", ["-c", command], typeof optionsOrCallback === "object" ? optionsOrCallback : {});
    if (callback) wireExecCallback(child, callback);
    return child;
  };

  const spawnSync = (command: string, args: readonly string[] = [], spawnOptions: CliSpawnOptions = {}): SpawnSyncResult => {
    const result = runCliChildCommand(command, args, {
      cwd: spawnOptions.cwd || options.parentProcess.cwd(),
      env: { ...options.env, ...(spawnOptions.env || {}) },
      reader: options.reader,
      writer: options.writer
    });
    return {
      ...(result.error ? { error: result.error } : {}),
      pid: nextPid++,
      signal: null,
      status: result.exitCode,
      stderr: new TextEncoder().encode(result.stderr),
      stdout: new TextEncoder().encode(result.stdout)
    } as SpawnSyncResult;
  };

  const execFileSync = (file: string, args: readonly string[] = [], spawnOptions: CliSpawnOptions = {}): Uint8Array => {
    const result = spawnSync(file, args, spawnOptions);
    if (result.error) throw result.error;
    if (result.status !== 0) throw new UnsupportedChildProcessError(file);
    return result.stdout;
  };

  const execSync = (command: string, spawnOptions: CliSpawnOptions = {}): Uint8Array => {
    return execFileSync("sh", ["-c", command], spawnOptions);
  };

  const fork = (modulePath: string, argsOrOptions?: readonly string[] | CliSpawnOptions, maybeOptions?: CliSpawnOptions): ChildProcess => {
    const forkOptions: CliSpawnOptions = Array.isArray(argsOrOptions)
      ? maybeOptions || {}
      : (argsOrOptions as CliSpawnOptions | undefined) || {};
    const child = new ChildProcess();
    child.pid = nextPid++;
    const forkedChild = child as ChildProcess & {
      connected: boolean;
      disconnect(): void;
      send(message: unknown): boolean;
    };
    const forkEnv = Object.fromEntries(Object.entries(forkOptions.env || {}).filter((entry): entry is [string, string] => typeof entry[1] === "string"));
    let jestWorkerPath: string | null = null;
    let jestSetupArgs: unknown[] = [];
    let jestInitialized = false;
    forkedChild.connected = true;
    forkedChild.disconnect = () => {
      forkedChild.connected = false;
      child.emit("disconnect");
    };
    forkedChild.send = (message: unknown): boolean => {
      if (!forkedChild.connected) return false;
      if (Array.isArray(message) && typeof message[0] === "number") {
        if (message[0] === 0) {
          jestWorkerPath = typeof message[2] === "string" ? message[2] : null;
          jestSetupArgs = Array.isArray(message[3]) ? message[3] : [];
          return true;
        }
        if (message[0] === 2) {
          forkedChild.disconnect();
          return true;
        }
        if (message[0] === 1 && jestWorkerPath) {
          const workerPath = jestWorkerPath;
          const method = typeof message[2] === "string" ? message[2] : "default";
          const args = Array.isArray(message[3]) ? message[3] : [];
          queueMicrotask(() => {
            const previousEnv = { ...options.parentProcess.env };
            Object.assign(options.parentProcess.env, forkEnv);
            const restoreEnv = () => {
              for (const key of Object.keys(options.parentProcess.env)) {
                if (!(key in previousEnv)) delete options.parentProcess.env[key];
              }
              Object.assign(options.parentProcess.env, previousEnv);
            };
            try {
              const workerModule = options.getRuntime().requireSync(workerPath, modulePath) as Record<string, unknown> & {
                default?: unknown;
                setup?: (...args: unknown[]) => unknown;
              };
              const invoke = async () => {
                if (!jestInitialized && typeof workerModule.setup === "function") {
                  jestInitialized = true;
                  await workerModule.setup(...jestSetupArgs);
                }
                const candidate = method === "default" && workerModule.__esModule ? workerModule.default : workerModule[method];
                if (typeof candidate !== "function") throw new TypeError(`Jest worker method is not callable: ${method}`);
                return candidate.apply(workerModule, args);
              };
              Promise.resolve(invoke()).then((value) => {
                restoreEnv();
                child.emit("message", [0, value]);
              }, (error) => {
                restoreEnv();
                const normalized = error instanceof Error ? error : new Error(String(error));
                child.emit("message", [1, normalized.name, normalized.message, normalized.stack, { ...normalized }]);
              });
            } catch (error) {
              restoreEnv();
              const normalized = error instanceof Error ? error : new Error(String(error));
              child.emit("message", [1, normalized.name, normalized.message, normalized.stack, { ...normalized }]);
            }
          });
          return true;
        }
      }
      const workerOptions = typeof message === "object" && message !== null
        ? (message as { nextWorkerOptions?: unknown }).nextWorkerOptions
        : undefined;
      if (workerOptions === undefined) return true;
      queueMicrotask(() => {
        try {
          const workerModule = options.getRuntime().requireSync(modulePath, modulePath) as {
            startServer?: (serverOptions: unknown) => Promise<void> | void;
          };
          if (typeof workerModule.startServer !== "function") {
            throw new Error(`ERR_CLI_FORK_ENTRY_UNSUPPORTED: ${modulePath}`);
          }
          Promise.resolve(workerModule.startServer(workerOptions)).then(() => {
            child.emit("message", {
              nextServerReady: true,
              port: (workerOptions as { port?: number }).port
            });
          }, (error) => {
            child.emit("error", error);
            child.exitCode = 1;
            child.emit("exit", 1, null);
            child.emit("close", 1, null);
          });
        } catch (error) {
          child.emit("error", error);
          child.exitCode = 1;
          child.emit("exit", 1, null);
          child.emit("close", 1, null);
        }
      });
      return true;
    };
    if (forkOptions.stdio === "inherit") {
      child.stdout.on("data", (chunk) => options.parentProcess.stdout.write(chunk));
      child.stderr.on("data", (chunk) => options.parentProcess.stderr.write(chunk));
    }
    if (!modulePath.includes("jest-worker/processChild")) {
      queueMicrotask(() => child.emit("message", { nextWorkerReady: true }));
    }
    return child;
  };

  return Object.freeze({
    ChildProcess,
    exec,
    execFile,
    execFileSync,
    execSync,
    fork,
    spawn,
    spawnSync
  });
}

function createCliPathBuiltin(process: BrowserProcess): RuntimeNamespace {
  const resolve = (...paths: string[]) => pathBuiltin.resolve(process.cwd(), ...paths);
  const posix = { ...pathBuiltin.posix, resolve };
  const boundPath = {
    ...pathBuiltin,
    posix,
    resolve,
    win32: posix
  } as RuntimeNamespace;
  Object.defineProperty(boundPath, "default", { configurable: true, enumerable: false, value: boundPath, writable: true });
  return boundPath;
}

function runCliChildCommand(
  command: string,
  args: readonly string[],
  options: CliChildCommandOptions
): CliChildCommandResult {
  const argv = isShellCommand(command, args)
    ? splitShellWords(args[1] || "")
    : [command, ...args];
  const binary = argv[0];
  if (!binary) return { stdout: "", stderr: "", exitCode: 0 };

  if (binary === "node" || binary.endsWith("/node")) {
    if (argv[1] === "-e" && argv[2]) return runNodeEval(argv[2]);
    const script = argv[1] ? resolveNodeScriptPath(argv[1], options.cwd) : "";
    if (script) return runNodeScript(script, options);
    return unsupportedChildCommand(binary);
  }

  const binPath = resolveExecutable(binary, options);
  if (binPath) return runNodeScript(binPath, { ...options, cwd: dirname(binPath) });
  return unsupportedChildCommand(binary);
}

function runNodeEval(source: string): CliChildCommandResult {
  const output = evaluateConsoleOutput(source);
  if (output !== null) return { stdout: output, stderr: "", exitCode: 0 };
  return unsupportedChildCommand("node -e");
}

function runNodeScript(path: string, options: CliChildCommandOptions): CliChildCommandResult {
  try {
    const source = options.reader.readText(path);
    const output = evaluateConsoleOutput(source);
    if (output !== null) return { stdout: output, stderr: "", exitCode: 0 };
    const write = evaluateFsWriteFileSync(source);
    if (write && options.writer) {
      options.writer.writeText(normalize(`${options.cwd}/${write.path}`), write.data);
      return { stdout: "", stderr: "", exitCode: 0 };
    }
    return unsupportedChildCommand(path);
  } catch (error) {
    return {
      stdout: "",
      stderr: `${errorMessage(error)}\n`,
      exitCode: 1
    };
  }
}

function evaluateConsoleOutput(source: string): string | null {
  const consoleLog = source.match(/console\.log\(\s*(["'`])([\s\S]*?)\1\s*\)/);
  if (consoleLog?.[2] !== undefined) return `${unescapeJsString(consoleLog[2])}\n`;
  const stdoutWrite = source.match(/process\.stdout\.write\(\s*(["'`])([\s\S]*?)\1\s*\)/);
  if (stdoutWrite?.[2] !== undefined) return unescapeJsString(stdoutWrite[2]);
  return null;
}

function evaluateFsWriteFileSync(source: string): { path: string; data: string } | null {
  const write = source.match(/writeFileSync\(\s*(["'`])([^"'`]+)\1\s*,\s*(["'`])([\s\S]*?)\3\s*\)/);
  if (!write?.[2] || write[4] === undefined) return null;
  return {
    path: write[2],
    data: unescapeJsString(write[4])
  };
}

function resolveExecutable(command: string, options: CliChildCommandOptions): string | null {
  const direct = resolveCliPath(command, options.cwd);
  if (readerExists(options.reader, direct)) return direct;
  const pathEntries = (options.env.PATH || "").split(":").filter(Boolean);
  for (const entry of pathEntries) {
    const candidate = resolveCliPath(`${entry}/${command}`, options.cwd);
    if (readerExists(options.reader, candidate)) return candidate;
  }
  const localBin = `${options.cwd}/node_modules/.bin/${command}`;
  if (readerExists(options.reader, localBin)) return localBin;
  return null;
}

function readerExists(reader: WorkspaceModuleReader, path: string): boolean {
  const maybeReader = reader as WorkspaceModuleReader & { exists?: (path: string) => boolean };
  if (maybeReader.exists) return maybeReader.exists(path);
  try {
    reader.readText(path);
    return true;
  } catch {
    return false;
  }
}

function resolveCliPath(path: string, cwd: string): string {
  if (path.startsWith("/")) return normalize(path);
  if (path.startsWith("./") || path.startsWith("../")) return normalize(`${cwd}/${path}`);
  return normalize(path);
}

function resolveNodeScriptPath(path: string, cwd: string): string {
  if (path.startsWith("/")) return normalize(path);
  return normalize(`${cwd}/${path}`);
}

function unsupportedChildCommand(command: string): CliChildCommandResult {
  return {
    stdout: "",
    stderr: "",
    exitCode: 1,
    error: new UnsupportedChildProcessError(command)
  };
}

function isShellCommand(command: string, args: readonly string[]): boolean {
  return (command === "sh" || command === "/bin/sh") && args[0] === "-c";
}

function splitShellWords(command: string): string[] {
  const words: string[] = [];
  let current = "";
  let quote: "'" | "\"" | "`" | null = null;
  let escaping = false;
  for (const char of command) {
    if (escaping) {
      current += char;
      escaping = false;
      continue;
    }
    if (char === "\\") {
      escaping = true;
      continue;
    }
    if (quote) {
      if (char === quote) quote = null;
      else current += char;
      continue;
    }
    if (char === "'" || char === "\"" || char === "`") {
      quote = char;
      continue;
    }
    if (/\s/.test(char)) {
      if (current) {
        words.push(current);
        current = "";
      }
      continue;
    }
    current += char;
  }
  if (current) words.push(current);
  return words;
}

function unescapeJsString(value: string): string {
  return value
    .replaceAll("\\n", "\n")
    .replaceAll("\\r", "\r")
    .replaceAll("\\t", "\t")
    .replaceAll("\\\"", "\"")
    .replaceAll("\\'", "'")
    .replaceAll("\\\\", "\\");
}

function wireExecCallback(child: ChildProcess, callback: CliExecCallback): void {
  let stdout = "";
  let stderr = "";
  let settled = false;
  child.stdout.on("data", (chunk) => {
    stdout += String(chunk);
  });
  child.stderr.on("data", (chunk) => {
    stderr += String(chunk);
  });
  child.once("error", (error) => {
    if (settled) return;
    settled = true;
    callback(error as Error, stdout, stderr);
  });
  child.once("close", (code) => {
    if (settled) return;
    settled = true;
    callback(code === 0 ? null : new Error(`Command failed with exit code ${code}`), stdout, stderr);
  });
}

function createCliWorkerThreadsBuiltin(options: {
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
let nextCliEvaluationWorkerRequestId = 1;

function createCliTimerScope(): {
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

function errorMessage(error: unknown): string {
  return formatErrorWithCauses(error, new Set());
}

const maxCliOutputCharacters = 1_048_576;

function appendCliOutput(current: string, chunk: unknown): string {
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

function captureHostAsyncErrors(onError: (error: unknown) => void): () => void {
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

function createCliConsole(process: BrowserProcess): Console {
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

async function settleCliEvaluation(options: AsyncCliModuleEvaluatorOptions): Promise<void> {
  const ticks = options.settleTicks ?? 8;
  const timeoutMs = options.settleTimeoutMs ?? 0;
  for (let index = 0; index < ticks; index += 1) {
    await Promise.resolve();
  }
  await new Promise((resolve) => setTimeout(resolve, timeoutMs));
}

async function waitForCliEvaluationReady(
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

async function waitForCliEvaluationExit(
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

function createCliDynamicImport(
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

interface CliSpawnOptions {
  cwd?: string;
  env?: Record<string, string | undefined>;
  stdio?: "pipe" | "ignore" | "inherit" | readonly unknown[];
}

type CliExecCallback = (error: Error | null, stdout: string | Uint8Array, stderr: string | Uint8Array) => void;

interface CliChildCommandOptions {
  cwd: string;
  env: Record<string, string | undefined>;
  reader: WorkspaceModuleReader;
  writer?: PackageManagerWorkspaceWriter | undefined;
}

interface CliChildCommandResult {
  stdout: string;
  stderr: string;
  exitCode: number;
  error?: Error;
}

interface HostProcessLike {
  on?(event: "uncaughtException" | "unhandledRejection", listener: (error: unknown) => void): unknown;
  off?(event: "uncaughtException" | "unhandledRejection", listener: (error: unknown) => void): unknown;
}

function parseProcessExit(message: string): number | null {
  const match = message.match(/^(?:Error:\s*)?process\.exit\((\d+)\)(?:\n|$)/);
  return match ? Number(match[1]) : null;
}
