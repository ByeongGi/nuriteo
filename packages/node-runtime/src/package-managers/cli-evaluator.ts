import { createBuiltinLoader } from "../builtin-loader.ts";
import { Buffer as BrowserBuffer } from "../builtins/buffer.ts";
import { cryptoBuiltin } from "../builtins/crypto.ts";
import { BrowserProcess } from "../builtins/process.ts";
import { createWorkspaceModuleRuntime, type WorkspaceModuleReader } from "../modules/index.ts";
import type { ModuleRuntime } from "../modules/runtime.ts";
import type { StaticCjsFactoryRegistry } from "../modules/static-cjs-factory.ts";
import { createLoopbackNetwork, type LoopbackNetwork, type RuntimeHttpRequest, type RuntimeHttpResponse, type RuntimeWebSocket } from "../net/index.ts";
import type { CjsContext, CliEntry, CliRunResult, EsmContext, RuntimeEnv, RuntimeFsBinding, RuntimeValue } from "../types.ts";
import { inspectCliEntryReadiness } from "./cli-entry-readiness.ts";
import { createWorkspaceFsFacade, getCliFsWatchSummary } from "./cli-fs.ts";
import { MemoryPackageManagerWorkspace, type PackageManagerWorkspaceSnapshot, type PackageManagerWorkspaceWriter } from "./workspace.ts";
import { appendCliOutput, captureHostAsyncErrors, createCliConsole, createCliDynamicImport, createCliTimerScope, createCliWorkerThreadsBuiltin, errorMessage, parseProcessExit, settleCliEvaluation, waitForCliEvaluationExit, waitForCliEvaluationReady } from "./cli-evaluator-process.ts";
import { createCliChildProcessBuiltin, createCliModuleBuiltin, createCliPathBuiltin, createCliWorkspaceFetch, createGeneratedCjsModuleBridge, parseWebpackMagicComment } from "./cli-evaluator-run.ts";
export { createCliNestedWorkerRuntime } from "./cli-evaluator-process.ts";

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
  stdin?: string;
}


export function createCliModuleEvaluator(options: CliModuleEvaluatorOptions): (request: CliModuleEvaluationRequest) => CliRunResult {
  return function evaluateCliModule(request: CliModuleEvaluationRequest): CliRunResult {
    const evaluation = startCliModuleEvaluation(options, request, { supportedModes: ["cjs"] });
    evaluation.writeStdin();
    return evaluation.finalize();
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
    evaluation.writeStdin();
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


let nextCliEvaluationWorkerRequestId = 1;

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
): { ready: Promise<void>; exited: Promise<void>; finalize: () => CliRunResult; writeStdin: () => void } {
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
      },
      writeStdin() {}
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
    writeStdin() {
      if (request.stdin === undefined) return;
      process.writeStdin(request.stdin);
      process.endStdin();
    },
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
