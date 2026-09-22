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

export interface CargoFileEntry {
  path: string;
  type: "file" | "directory" | "symlink";
  size?: number;
}

export interface CargoFileSystemAdapter {
  readFile(path: string): Promise<Uint8Array | string>;
  writeFile(path: string, data: Uint8Array | string): Promise<void>;
  readdir(path: string): Promise<CargoFileEntry[]>;
  mkdir?(path: string, options?: { recursive?: boolean }): Promise<void>;
  rm?(path: string, options?: { force?: boolean; recursive?: boolean }): Promise<void>;
  watch?(path: string, listener: (event: CargoFileWatchEvent) => void): () => void;
}

export interface CargoFileWatchEvent {
  path: string;
  type: "create" | "change" | "delete" | "rename";
}

export interface CargoPackageCommandOptions {
  args?: string[];
  cwd?: string;
  env?: Record<string, string>;
  signal?: AbortSignal;
}

export interface CargoCommandResult {
  command: string;
  exitCode: number;
  stderr: string;
  stdout: string;
}

export interface CargoPackageManagerAdapter {
  install(options?: CargoPackageCommandOptions & { packageManager?: "npm" | "pnpm" | "yarn" }): Promise<CargoCommandResult>;
  run(script: string, options?: CargoPackageCommandOptions): Promise<CargoCommandResult>;
  exec(binary: string, options?: CargoPackageCommandOptions): Promise<CargoCommandResult>;
}

export interface CargoPreviewPort {
  port: number;
  protocol: "http" | "https";
  url: string;
  label?: string;
}

export interface CargoPreviewAdapter {
  listPorts(): Promise<CargoPreviewPort[]>;
  setPreviewScript?(script: string | null): Promise<void> | void;
  subscribe?(listener: (event: CargoPreviewEvent) => void): () => void;
}

export interface CargoPreviewEvent {
  type: "port" | "server-ready" | "server-close";
  port: number;
  url?: string;
}

export interface CargoProjectAdapter {
  exportProject(): Promise<Uint8Array>;
  importProject(archive: Uint8Array | ArrayBuffer | string): Promise<void>;
}

export interface CargoProcessSpawnOptions extends CargoPackageCommandOptions {
  command: string;
}

export interface CargoProcessHandle {
  readonly pid: number;
  kill(signal?: "SIGINT" | "SIGTERM" | "SIGKILL"): Promise<void> | void;
  resize?(columns: number, rows: number): Promise<void> | void;
  write?(data: string): Promise<void> | void;
  wait(): Promise<CargoCommandResult>;
}

export interface CargoProcessAdapter {
  spawn(options: CargoProcessSpawnOptions): Promise<CargoProcessHandle>;
}

export interface CargoSdkTraceEvent {
  category: "filesystem" | "package-manager" | "preview" | "project" | "process";
  operation: string;
  phase: "start" | "success" | "error";
  timestamp: number;
  error?: string;
}

export interface CargoContainerServicesOptions {
  filesystem?: CargoFileSystemAdapter;
  packageManager?: CargoPackageManagerAdapter;
  preview?: CargoPreviewAdapter;
  project?: CargoProjectAdapter;
  process?: CargoProcessAdapter;
  now?: () => number;
}

export class CargoContainerServices {
  readonly fs: CargoFileSystemApi;
  readonly packages: CargoPackageManagerApi;
  readonly preview: CargoPreviewApi;
  readonly projects: CargoProjectApi;
  readonly processes: CargoProcessApi;
  #listeners = new Set<(event: CargoSdkTraceEvent) => void>();
  #now: () => number;

  constructor(options: CargoContainerServicesOptions = {}) {
    this.#now = options.now || Date.now;
    const trace = <T>(category: CargoSdkTraceEvent["category"], operation: string, task: () => Promise<T>) =>
      this.#trace(category, operation, task);
    this.fs = new CargoFileSystemApi(options.filesystem, trace);
    this.packages = new CargoPackageManagerApi(options.packageManager, trace);
    this.preview = new CargoPreviewApi(options.preview, trace);
    this.projects = new CargoProjectApi(options.project, trace);
    this.processes = new CargoProcessApi(options.process, trace);
  }

  onTrace(listener: (event: CargoSdkTraceEvent) => void): () => void {
    this.#listeners.add(listener);
    return () => this.#listeners.delete(listener);
  }

  async #trace<T>(category: CargoSdkTraceEvent["category"], operation: string, task: () => Promise<T>): Promise<T> {
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

  #emit(event: CargoSdkTraceEvent): void {
    for (const listener of this.#listeners) listener({ ...event });
  }
}

type Trace = <T>(category: CargoSdkTraceEvent["category"], operation: string, task: () => Promise<T>) => Promise<T>;

export class CargoFileSystemApi {
  private readonly adapter: CargoFileSystemAdapter | undefined;
  private readonly trace: Trace;

  constructor(adapter: CargoFileSystemAdapter | undefined, trace: Trace) {
    this.adapter = adapter;
    this.trace = trace;
  }

  readFile(path: string): Promise<Uint8Array | string> {
    return this.trace("filesystem", "readFile", () => this.#adapter().readFile(required(path, "path")));
  }

  writeFile(path: string, data: Uint8Array | string): Promise<void> {
    return this.trace("filesystem", "writeFile", () => this.#adapter().writeFile(required(path, "path"), data));
  }

  readdir(path: string): Promise<CargoFileEntry[]> {
    return this.trace("filesystem", "readdir", () => this.#adapter().readdir(required(path, "path")));
  }

  mkdir(path: string, options: { recursive?: boolean } = {}): Promise<void> {
    return this.trace("filesystem", "mkdir", () => optional(this.#adapter().mkdir, "filesystem.mkdir")(required(path, "path"), options));
  }

  rm(path: string, options: { force?: boolean; recursive?: boolean } = {}): Promise<void> {
    return this.trace("filesystem", "rm", () => optional(this.#adapter().rm, "filesystem.rm")(required(path, "path"), options));
  }

  watch(path: string, listener: (event: CargoFileWatchEvent) => void): () => void {
    return optional(this.#adapter().watch, "filesystem.watch")(required(path, "path"), listener);
  }

  #adapter(): CargoFileSystemAdapter {
    return requiredAdapter(this.adapter, "filesystem");
  }
}

export class CargoPackageManagerApi {
  private readonly adapter: CargoPackageManagerAdapter | undefined;
  private readonly trace: Trace;

  constructor(adapter: CargoPackageManagerAdapter | undefined, trace: Trace) {
    this.adapter = adapter;
    this.trace = trace;
  }

  install(options: CargoPackageCommandOptions & { packageManager?: "npm" | "pnpm" | "yarn" } = {}): Promise<CargoCommandResult> {
    return this.trace("package-manager", "install", () => this.#adapter().install(cloneCommandOptions(options)));
  }

  run(script: string, options: CargoPackageCommandOptions = {}): Promise<CargoCommandResult> {
    return this.trace("package-manager", "run", () => this.#adapter().run(required(script, "script"), cloneCommandOptions(options)));
  }

  exec(binary: string, options: CargoPackageCommandOptions = {}): Promise<CargoCommandResult> {
    return this.trace("package-manager", "exec", () => this.#adapter().exec(required(binary, "binary"), cloneCommandOptions(options)));
  }

  #adapter(): CargoPackageManagerAdapter {
    return requiredAdapter(this.adapter, "package-manager");
  }
}

export class CargoPreviewApi {
  private readonly adapter: CargoPreviewAdapter | undefined;
  private readonly trace: Trace;

  constructor(adapter: CargoPreviewAdapter | undefined, trace: Trace) {
    this.adapter = adapter;
    this.trace = trace;
  }

  ports(): Promise<CargoPreviewPort[]> {
    return this.trace("preview", "ports", async () => (await this.#adapter().listPorts()).map((port) => ({ ...port })));
  }

  setPreviewScript(script: string | null): Promise<void> {
    return this.trace("preview", "setPreviewScript", async () => {
      await optional(this.#adapter().setPreviewScript, "preview.setPreviewScript")(script);
    });
  }

  subscribe(listener: (event: CargoPreviewEvent) => void): () => void {
    return optional(this.#adapter().subscribe, "preview.subscribe")(listener);
  }

  #adapter(): CargoPreviewAdapter {
    return requiredAdapter(this.adapter, "preview");
  }
}

export class CargoProjectApi {
  private readonly adapter: CargoProjectAdapter | undefined;
  private readonly trace: Trace;

  constructor(adapter: CargoProjectAdapter | undefined, trace: Trace) {
    this.adapter = adapter;
    this.trace = trace;
  }

  export(): Promise<Uint8Array> {
    return this.trace("project", "export", () => this.#adapter().exportProject());
  }

  import(archive: Uint8Array | ArrayBuffer | string): Promise<void> {
    return this.trace("project", "import", () => this.#adapter().importProject(archive));
  }

  #adapter(): CargoProjectAdapter {
    return requiredAdapter(this.adapter, "project");
  }
}

export class CargoProcessApi {
  private readonly adapter: CargoProcessAdapter | undefined;
  private readonly trace: Trace;

  constructor(adapter: CargoProcessAdapter | undefined, trace: Trace) {
    this.adapter = adapter;
    this.trace = trace;
  }

  spawn(options: CargoProcessSpawnOptions): Promise<CargoProcessHandle> {
    return this.trace("process", "spawn", () => this.#adapter().spawn({
      ...cloneCommandOptions(options),
      command: required(options.command, "command")
    }));
  }

  #adapter(): CargoProcessAdapter {
    return requiredAdapter(this.adapter, "process");
  }
}

export interface CargoWorkerAssets {
  processWorkerUrl: URL;
  systemWasmUrl: URL;
  systemWorkerUrl: URL;
}

export function resolveCargoWorkerAssets(baseUrl: string | URL): CargoWorkerAssets {
  const base = new URL(String(baseUrl), typeof location === "undefined" ? "http://localhost/" : location.href);
  const normalized = new URL(base.href.endsWith("/") ? base.href : `${base.href}/`);
  return {
    systemWorkerUrl: new URL("workers/system-worker.ts", normalized),
    processWorkerUrl: new URL("workers/process-worker.ts", normalized),
    systemWasmUrl: new URL("assets/system_wasm.wasm", normalized)
  };
}

export interface RegisterCargoPreviewServiceWorkerOptions {
  scriptUrl: string | URL;
  scope?: string;
  navigator?: Pick<Navigator, "serviceWorker">;
}

export async function registerCargoPreviewServiceWorker(
  options: RegisterCargoPreviewServiceWorkerOptions
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

function cloneCommandOptions<T extends CargoPackageCommandOptions>(options: T): T {
  return {
    ...options,
    ...(options.args ? { args: [...options.args] } : {}),
    ...(options.env ? { env: { ...options.env } } : {})
  };
}
