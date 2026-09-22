export type RuntimeValue = unknown;
export type RuntimeNamespace = Record<string, RuntimeValue>;

export interface RuntimeModule {
  children: RuntimeModule[];
  id: string;
  filename: string;
  exports: RuntimeNamespace | RuntimeValue;
  loaded: boolean;
  parent: RuntimeModule | null;
}

export interface CjsContext {
  exports: RuntimeNamespace | RuntimeValue;
  module: RuntimeModule;
  require: (specifier: string) => RuntimeValue;
  filename: string;
  dirname: string;
}

export interface EsmContext {
  url: string;
  importMeta: {
    url: string;
    dirname: string;
    filename: string;
    resolve: (specifier: string) => string;
  };
  importNamespace: (specifier: string) => RuntimeNamespace;
  dynamicImport: (specifier: string) => Promise<RuntimeNamespace>;
  exportConst: (name: string, value: RuntimeValue) => void;
  exportLive: (name: string, getter: () => RuntimeValue) => void;
}

export type CjsModuleDefinition = {
  kind: "cjs";
  factory: (context: CjsContext) => void;
};

export type CjsSourceModuleDefinition = {
  kind: "cjs-source";
  source: string;
};

export type JsonModuleDefinition = {
  kind: "json";
  value: RuntimeValue;
};

export type EsmModuleDefinition = {
  kind: "esm";
  imports?: string[];
  factory: (context: EsmContext) => void | Promise<void>;
};

export type EsmSourceModuleDefinition = {
  kind: "esm-source";
  source: string;
};

export type ModuleDefinition = CjsModuleDefinition | CjsSourceModuleDefinition | JsonModuleDefinition | EsmModuleDefinition | EsmSourceModuleDefinition;
export type ModuleDefinitionMap = Record<string, ModuleDefinition>;

export interface PackageManifest {
  name?: string;
  root?: string;
  type?: string;
  main?: string;
  browser?: string | Record<string, string | false>;
  exports?: PackageExports;
  imports?: PackageExports;
}

export type PackageExports = PackageExportTarget | Record<string, PackageExportTarget>;
export type PackageExportTarget = string | PackageExportConditionMap | PackageExportTarget[];
export interface PackageExportConditionMap {
  [condition: string]: PackageExportTarget | undefined;
}

export interface ModuleRuntimeOptions {
  allowAsyncRequireEsm?: boolean;
  realpaths?: Record<string, string>;
  packages?: Record<string, PackageManifest>;
  packageRoots?: Record<string, PackageManifest>;
  imports?: Record<string, string>;
  builtins?: (specifier: string) => RuntimeValue;
  globals?: Record<string, RuntimeValue>;
  loadModuleDefinition?: (url: string) => ModuleDefinition | undefined;
  moduleExists?: (url: string) => boolean;
}

export interface LivenessHandle {
  id: number;
  label: string;
  ref(): LivenessTrackerLike;
  unref(): LivenessTrackerLike;
  close(): void;
}

export interface LivenessTrackerLike {
  refs: Set<number>;
  ref(label?: string): LivenessHandle;
  hasRefs(): boolean;
}

export type RuntimeTaskCallback = () => void | Promise<void>;

export interface RuntimeProcessOptions {
  pid?: number;
}

export interface RuntimeExitStatus {
  exitCode: number;
  exited: boolean;
  uncaughtException: unknown;
}

export interface RuntimeFsBindingOptions {
  pid?: number;
  generation?: number;
  timeoutMs?: number;
  firstRequestId?: number;
}

export type RuntimeFsData = string | ArrayBuffer | ArrayBufferView | Uint8Array;

export interface RuntimeFsBinding {
  exists?(path: string, callback: (exists: boolean) => void): void;
  existsSync?(path: string): boolean;
  openSync(path: string, flags?: string | number): number;
  closeSync(fd: number): void;
  writeSync(fd: number, data: RuntimeFsData): number;
  readSync(fd: number, len?: number): Uint8Array;
  writeFileSync(path: string, data: RuntimeFsData): void;
  readFileSync(path: string): Uint8Array;
  readFileSync(path: string, encoding: "utf8" | "utf-8"): string;
  mkdirSync(path: string): void;
  mkdtempSync?(prefix: string): string;
  chmodSync?(path: string, mode: number | string): void;
  chownSync?(path: string, uid: number, gid: number): void;
  fchmodSync?(fd: number, mode: number | string): void;
  fchownSync?(fd: number, uid: number, gid: number): void;
  fsyncSync?(fd: number): void;
  lchmodSync?(path: string, mode: number | string): void;
  lchownSync?(path: string, uid: number, gid: number): void;
  statSync(path: string): {
    atime?: Date;
    atimeMs?: number;
    birthtime?: Date;
    birthtimeMs?: number;
    blksize?: number;
    blocks?: number;
    ctime?: Date;
    ctimeMs?: number;
    dev?: number;
    gid?: number;
    ino?: number;
    mtime?: Date;
    mtimeMs?: number;
    mode?: number;
    nlink?: number;
    rdev?: number;
    size: number;
    uid?: number;
    isFile(): boolean;
    isDirectory(): boolean;
    isSymbolicLink?(): boolean;
  };
  lstatSync?(path: string): {
    ino?: number;
    mode?: number;
    size: number;
    isFile(): boolean;
    isDirectory(): boolean;
    isSymbolicLink?(): boolean;
  };
}

export interface BuiltinBindings {
  childProcess?: RuntimeValue;
  console?: RuntimeValue;
  fs?: RuntimeFsBinding;
  buffer?: RuntimeValue;
  events?: RuntimeValue;
  httpClient?: import("./network/http-client.ts").RuntimeHttpClient | import("./network/http-client.ts").RuntimeFetcher;
  httpServerNetwork?: import("./net/index.ts").LoopbackNetwork;
  httpsClient?: import("./network/http-client.ts").RuntimeHttpClient | import("./network/http-client.ts").RuntimeFetcher;
  internalBinding?: (name: string) => unknown;
  module?: RuntimeValue;
  path?: RuntimeValue;
  process?: RuntimeValue;
  stream?: RuntimeValue;
  timers?: RuntimeValue;
  timersPromises?: RuntimeValue;
  util?: RuntimeValue;
  workerThreads?: RuntimeValue;
}

export interface CliEntry {
  name: string;
  version: string;
  entry: string;
  entrySha256?: string;
  tarballSha256?: string;
  mode?: string;
  resolutionPolicy?: string;
}

export interface CliRunResult {
  stdout: string;
  stderr: string;
  exitCode: number;
  entry: string;
  entrySha256?: string;
  dispose?: () => void;
}

export type RuntimeEnv = Record<string, string>;

export interface RuntimeProgramOptions extends RuntimeFsBindingOptions {
  syncChannel: SharedArrayBuffer;
  entrypoint?: string;
}

export interface RuntimeChildProcessOptions {
  pid?: number;
  parent?: number | null;
  cwd?: string;
  env?: RuntimeEnv;
  stdio?: import("./io/stdio.ts").RuntimeStdio;
  stdioCapacity?: number;
  entrypoint?: RuntimeChildEntrypoint;
}

export type RuntimeChildEntrypoint = (context: {
  process: import("./process.ts").RuntimeProcess;
  scheduler: import("./scheduler.ts").RuntimeScheduler;
  stdio: import("./io/stdio.ts").RuntimeStdio;
}) => void | Promise<void>;

export interface RuntimeWorkerThreadOptions {
  pid?: number | null;
  entrypoint?: (context: { threadId: number; pid: number | null }) => unknown | Promise<unknown>;
}

export type WasmExportKind = "function" | "global" | "memory" | "table";

export interface WasmAdapterManifestEntry {
  name: string;
  status?: "supported" | "candidate" | "hold";
  package?: string;
  path: string;
  sha256: string;
  exports?: Record<string, WasmExportKind>;
  fallbackPolicy?: "deny-native" | "prefer-wasm" | "allow-js";
}

export interface WasmAdapterReplacement {
  package?: string;
  nativePackages?: string[];
  adapterName?: string;
  wasmPackage?: string;
  fallbackPolicy?: "deny-native" | "prefer-wasm" | "allow-js";
  status?: string;
}

export interface WasmAdapterManifest {
  adapters: WasmAdapterManifestEntry[];
  candidateReplacements?: WasmAdapterReplacement[];
}
