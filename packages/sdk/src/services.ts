export type SdkErrorCode =
  | "ESDK_ADAPTER_MISSING"
  | "ESDK_INVALID_ARGUMENT"
  | "ESDK_LIFECYCLE_FAILED"
  | "ESDK_PATH_INVALID"
  | "ESDK_SERVICE_WORKER_UNAVAILABLE"
  | "ESDK_SERVICE_WORKER_REGISTRATION_FAILED"
  | "ESDK_SYMLINK_UNSUPPORTED";

export class SdkError extends Error {
  readonly code: SdkErrorCode;
  readonly cause?: unknown;

  constructor(code: SdkErrorCode, message: string, cause?: unknown) {
    super(message);
    this.name = "SdkError";
    this.code = code;
    this.cause = cause;
  }
}

export interface NuriteoFileEntry {
  path: string;
  type: "file" | "directory" | "symlink";
  size?: number;
}

export interface NuriteoFileSystemAdapter {
  readFile(path: string): Promise<Uint8Array | string>;
  writeFile(path: string, data: Uint8Array | string): Promise<void>;
  readdir(path: string): Promise<NuriteoFileEntry[]>;
  mkdir?(path: string, options?: { recursive?: boolean }): Promise<void>;
  rm?(path: string, options?: { force?: boolean; recursive?: boolean }): Promise<void>;
  watch?(path: string, listener: (event: NuriteoFileWatchEvent) => void): () => void;
}

export interface NuriteoFileWatchEvent {
  path: string;
  type: "create" | "change" | "delete" | "rename";
}

export interface NuriteoPackageCommandOptions {
  args?: string[];
  cwd?: string;
  env?: Record<string, string>;
  signal?: AbortSignal;
}

export interface NuriteoCommandResult {
  command: string;
  exitCode: number;
  stderr: string;
  stdout: string;
}

export interface NuriteoPackageManagerAdapter {
  install(options?: NuriteoPackageCommandOptions & { packageManager?: "npm" | "pnpm" | "yarn" }): Promise<NuriteoCommandResult>;
  run(script: string, options?: NuriteoPackageCommandOptions): Promise<NuriteoCommandResult>;
  exec(binary: string, options?: NuriteoPackageCommandOptions): Promise<NuriteoCommandResult>;
}

export interface NuriteoPreviewPort {
  port: number;
  protocol: "http" | "https";
  url: string;
  label?: string;
}

export interface NuriteoPreviewAdapter {
  listPorts(): Promise<NuriteoPreviewPort[]>;
  setPreviewScript?(script: string | null): Promise<void> | void;
  subscribe?(listener: (event: NuriteoPreviewEvent) => void): () => void;
}

export interface NuriteoPreviewEvent {
  type: "port" | "server-ready" | "server-close";
  port: number;
  url?: string;
}

export interface NuriteoProjectAdapter {
  exportProject(): Promise<Uint8Array>;
  importProject(archive: Uint8Array | ArrayBuffer | string): Promise<void>;
}

export interface NuriteoProcessSpawnOptions extends NuriteoPackageCommandOptions {
  command: string;
}

export interface NuriteoProcessHandle {
  readonly pid: number;
  kill(signal?: "SIGINT" | "SIGTERM" | "SIGKILL"): Promise<void> | void;
  resize?(columns: number, rows: number): Promise<void> | void;
  write?(data: string): Promise<void> | void;
  wait(): Promise<NuriteoCommandResult>;
}

export interface NuriteoProcessAdapter {
  spawn(options: NuriteoProcessSpawnOptions): Promise<NuriteoProcessHandle>;
}

export interface NuriteoSdkTraceEvent {
  category: "filesystem" | "package-manager" | "preview" | "project" | "process";
  operation: string;
  phase: "start" | "success" | "error";
  timestamp: number;
  error?: string;
}

export interface NuriteoServicesOptions {
  filesystem?: NuriteoFileSystemAdapter;
  packageManager?: NuriteoPackageManagerAdapter;
  preview?: NuriteoPreviewAdapter;
  project?: NuriteoProjectAdapter;
  process?: NuriteoProcessAdapter;
  now?: () => number;
}

export class NuriteoServices {
  readonly fs: NuriteoFileSystemApi;
  readonly packages: NuriteoPackageManagerApi;
  readonly preview: NuriteoPreviewApi;
  readonly projects: NuriteoProjectApi;
  readonly processes: NuriteoProcessApi;
  #listeners = new Set<(event: NuriteoSdkTraceEvent) => void>();
  #now: () => number;

  constructor(options: NuriteoServicesOptions = {}) {
    this.#now = options.now || Date.now;
    const trace = <T>(category: NuriteoSdkTraceEvent["category"], operation: string, task: () => Promise<T>) =>
      this.#trace(category, operation, task);
    this.fs = new NuriteoFileSystemApi(options.filesystem, trace);
    this.packages = new NuriteoPackageManagerApi(options.packageManager, trace);
    this.preview = new NuriteoPreviewApi(options.preview, trace);
    this.projects = new NuriteoProjectApi(options.project, trace);
    this.processes = new NuriteoProcessApi(options.process, trace);
  }

  onTrace(listener: (event: NuriteoSdkTraceEvent) => void): () => void {
    this.#listeners.add(listener);
    return () => this.#listeners.delete(listener);
  }

  async #trace<T>(category: NuriteoSdkTraceEvent["category"], operation: string, task: () => Promise<T>): Promise<T> {
    this.#emit({ category, operation, phase: "start", timestamp: this.#now() });
    try {
      const result = await task();
      this.#emit({ category, operation, phase: "success", timestamp: this.#now() });
      return result;
    } catch (error) {
      this.#emit({
        category,
        operation,
        phase: "error",
        timestamp: this.#now(),
        error: error instanceof Error ? error.message : String(error)
      });
      throw error;
    }
  }

  #emit(event: NuriteoSdkTraceEvent): void {
    for (const listener of this.#listeners) listener({ ...event });
  }
}

type Trace = <T>(category: NuriteoSdkTraceEvent["category"], operation: string, task: () => Promise<T>) => Promise<T>;

export class NuriteoFileSystemApi {
  private readonly adapter: NuriteoFileSystemAdapter | undefined;
  private readonly trace: Trace;

  constructor(adapter: NuriteoFileSystemAdapter | undefined, trace: Trace) {
    this.adapter = adapter;
    this.trace = trace;
  }

  readFile(path: string): Promise<Uint8Array | string> {
    return this.trace("filesystem", "readFile", () => this.#adapter().readFile(required(path, "path")));
  }

  writeFile(path: string, data: Uint8Array | string): Promise<void> {
    return this.trace("filesystem", "writeFile", () => this.#adapter().writeFile(required(path, "path"), data));
  }

  readdir(path: string): Promise<NuriteoFileEntry[]> {
    return this.trace("filesystem", "readdir", () => this.#adapter().readdir(required(path, "path")));
  }

  mkdir(path: string, options: { recursive?: boolean } = {}): Promise<void> {
    return this.trace("filesystem", "mkdir", () => optional(this.#adapter().mkdir, "filesystem.mkdir")(required(path, "path"), options));
  }

  rm(path: string, options: { force?: boolean; recursive?: boolean } = {}): Promise<void> {
    return this.trace("filesystem", "rm", () => optional(this.#adapter().rm, "filesystem.rm")(required(path, "path"), options));
  }

  watch(path: string, listener: (event: NuriteoFileWatchEvent) => void): () => void {
    return optional(this.#adapter().watch, "filesystem.watch")(required(path, "path"), listener);
  }

  #adapter(): NuriteoFileSystemAdapter {
    return requiredAdapter(this.adapter, "filesystem");
  }
}

export class NuriteoPackageManagerApi {
  private readonly adapter: NuriteoPackageManagerAdapter | undefined;
  private readonly trace: Trace;

  constructor(adapter: NuriteoPackageManagerAdapter | undefined, trace: Trace) {
    this.adapter = adapter;
    this.trace = trace;
  }

  install(options: NuriteoPackageCommandOptions & { packageManager?: "npm" | "pnpm" | "yarn" } = {}): Promise<NuriteoCommandResult> {
    return this.trace("package-manager", "install", () => this.#adapter().install(cloneCommandOptions(options)));
  }

  run(script: string, options: NuriteoPackageCommandOptions = {}): Promise<NuriteoCommandResult> {
    return this.trace("package-manager", "run", () => this.#adapter().run(required(script, "script"), cloneCommandOptions(options)));
  }

  exec(binary: string, options: NuriteoPackageCommandOptions = {}): Promise<NuriteoCommandResult> {
    return this.trace("package-manager", "exec", () => this.#adapter().exec(required(binary, "binary"), cloneCommandOptions(options)));
  }

  #adapter(): NuriteoPackageManagerAdapter {
    return requiredAdapter(this.adapter, "package-manager");
  }
}

export class NuriteoPreviewApi {
  private readonly adapter: NuriteoPreviewAdapter | undefined;
  private readonly trace: Trace;

  constructor(adapter: NuriteoPreviewAdapter | undefined, trace: Trace) {
    this.adapter = adapter;
    this.trace = trace;
  }

  ports(): Promise<NuriteoPreviewPort[]> {
    return this.trace("preview", "ports", async () => (await this.#adapter().listPorts()).map((port) => ({ ...port })));
  }

  setPreviewScript(script: string | null): Promise<void> {
    return this.trace("preview", "setPreviewScript", async () => {
      await optional(this.#adapter().setPreviewScript, "preview.setPreviewScript")(script);
    });
  }

  subscribe(listener: (event: NuriteoPreviewEvent) => void): () => void {
    return optional(this.#adapter().subscribe, "preview.subscribe")(listener);
  }

  #adapter(): NuriteoPreviewAdapter {
    return requiredAdapter(this.adapter, "preview");
  }
}

export class NuriteoProjectApi {
  private readonly adapter: NuriteoProjectAdapter | undefined;
  private readonly trace: Trace;

  constructor(adapter: NuriteoProjectAdapter | undefined, trace: Trace) {
    this.adapter = adapter;
    this.trace = trace;
  }

  export(): Promise<Uint8Array> {
    return this.trace("project", "export", () => this.#adapter().exportProject());
  }

  import(archive: Uint8Array | ArrayBuffer | string): Promise<void> {
    return this.trace("project", "import", () => this.#adapter().importProject(archive));
  }

  #adapter(): NuriteoProjectAdapter {
    return requiredAdapter(this.adapter, "project");
  }
}

export class NuriteoProcessApi {
  private readonly adapter: NuriteoProcessAdapter | undefined;
  private readonly trace: Trace;

  constructor(adapter: NuriteoProcessAdapter | undefined, trace: Trace) {
    this.adapter = adapter;
    this.trace = trace;
  }

  spawn(options: NuriteoProcessSpawnOptions): Promise<NuriteoProcessHandle> {
    return this.trace("process", "spawn", () => this.#adapter().spawn({
      ...cloneCommandOptions(options),
      command: required(options.command, "command")
    }));
  }

  #adapter(): NuriteoProcessAdapter {
    return requiredAdapter(this.adapter, "process");
  }
}

export interface NuriteoWorkerAssets {
  processWorkerUrl: URL;
  systemWasmUrl: URL;
  systemWorkerUrl: URL;
}

export function resolveNuriteoWorkerAssets(baseUrl: string | URL): NuriteoWorkerAssets {
  const base = new URL(String(baseUrl), typeof location === "undefined" ? "http://localhost/" : location.href);
  const normalized = new URL(base.href.endsWith("/") ? base.href : `${base.href}/`);
  return {
    systemWorkerUrl: new URL("workers/system-worker.ts", normalized),
    processWorkerUrl: new URL("workers/process-worker.ts", normalized),
    systemWasmUrl: new URL("assets/system_wasm.wasm", normalized)
  };
}

export interface RegisterNuriteoPreviewServiceWorkerOptions {
  scriptUrl: string | URL;
  scope?: string;
  navigator?: Pick<Navigator, "serviceWorker">;
}

export async function registerNuriteoPreviewServiceWorker(
  options: RegisterNuriteoPreviewServiceWorkerOptions
): Promise<ServiceWorkerRegistration> {
  const serviceWorker = options.navigator?.serviceWorker
    || (typeof navigator !== "undefined" ? navigator.serviceWorker : undefined);
  if (!serviceWorker) {
    throw new SdkError("ESDK_SERVICE_WORKER_UNAVAILABLE", "Service Worker is unavailable in this environment");
  }
  try {
    return await serviceWorker.register(String(options.scriptUrl), options.scope ? { scope: options.scope } : undefined);
  } catch (error) {
    throw new SdkError("ESDK_SERVICE_WORKER_REGISTRATION_FAILED", "Preview Service Worker registration failed", error);
  }
}

function required(value: string, label: string): string {
  if (!value.trim()) throw new SdkError("ESDK_INVALID_ARGUMENT", `${label} must not be empty`);
  return value;
}

function requiredAdapter<T>(adapter: T | undefined, name: string): T {
  if (!adapter) throw new SdkError("ESDK_ADAPTER_MISSING", `${name} adapter is not configured`);
  return adapter;
}

function optional<T extends (...args: never[]) => unknown>(value: T | undefined, name: string): T {
  if (!value) throw new SdkError("ESDK_ADAPTER_MISSING", `${name} adapter is not configured`);
  return value;
}

function cloneCommandOptions<T extends NuriteoPackageCommandOptions>(options: T): T {
  return {
    ...options,
    ...(options.args ? { args: [...options.args] } : {}),
    ...(options.env ? { env: { ...options.env } } : {})
  };
}
