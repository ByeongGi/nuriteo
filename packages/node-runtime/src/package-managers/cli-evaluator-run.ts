import { ChildProcess, UnsupportedChildProcessError, type SpawnSyncResult } from "../builtins/child-process.ts";
import { builtinModules, moduleBuiltin, Module as RuntimeModuleBuiltin } from "../builtins/module.ts";
import { dirname, join, normalize, pathBuiltin } from "../builtins/path.ts";
import type { BrowserProcess } from "../builtins/process.ts";
import { fileURLToPath } from "../builtins/url.ts";
import type { WorkspaceModuleReader } from "../modules/index.ts";
import type { ModuleRuntime } from "../modules/runtime.ts";
import type { RuntimeEnv, RuntimeNamespace, RuntimeValue } from "../types.ts";
import { readWorkspaceBytes } from "./cli-fs.ts";
import type { PackageManagerWorkspaceWriter } from "./workspace.ts";
import type { CliChildCommandOptions, CliChildCommandResult, CliExecCallback, CliSpawnOptions } from "./cli-evaluator-process.ts";
import { errorMessage } from "./cli-evaluator-process.ts";

export function parseWebpackMagicComment(source: string): Record<string, RuntimeValue> {
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


export function createGeneratedCjsModuleBridge(options: GeneratedCjsModuleBridgeOptions): {
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
    // The URL is a Cache Storage module created at runtime. Leave it as a native
    // import so Next/webpack does not build a context for every possible request.
    await import(/* webpackIgnore: true */ /* @vite-ignore */ url);
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


export function createCliModuleBuiltin(getRuntime: () => ModuleRuntime): RuntimeNamespace {
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


export function createCliWorkspaceFetch(reader: WorkspaceModuleReader): (input: string | URL) => Promise<{
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


export function createCliChildProcessBuiltin(options: {
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


export function createCliPathBuiltin(process: BrowserProcess): RuntimeNamespace {
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
