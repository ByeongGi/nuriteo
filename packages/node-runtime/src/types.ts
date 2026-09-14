export type RuntimeValue = unknown;
export type RuntimeNamespace = Record<string, RuntimeValue>;

export interface RuntimeModule {
  id: string;
  exports: RuntimeNamespace | RuntimeValue;
  loaded: boolean;
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

export type EsmModuleDefinition = {
  kind: "esm";
  imports?: string[];
  factory: (context: EsmContext) => void | Promise<void>;
};

export type ModuleDefinition = CjsModuleDefinition | EsmModuleDefinition;
export type ModuleDefinitionMap = Record<string, ModuleDefinition>;

export interface PackageManifest {
  root?: string;
  type?: string;
  exports?: string | Record<string, string>;
}

export interface ModuleRuntimeOptions {
  realpaths?: Record<string, string>;
  packages?: Record<string, PackageManifest>;
  imports?: Record<string, string>;
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
  openSync(path: string, flags?: string): number;
  closeSync(fd: number): void;
  writeSync(fd: number, data: RuntimeFsData): number;
  readSync(fd: number, len?: number): Uint8Array;
  writeFileSync(path: string, data: RuntimeFsData): void;
  readFileSync(path: string): Uint8Array;
  readFileSync(path: string, encoding: "utf8" | "utf-8"): string;
  mkdirSync(path: string): void;
  statSync(path: string): {
    size: number;
    isFile(): boolean;
    isDirectory(): boolean;
  };
}

export interface BuiltinBindings {
  fs?: RuntimeFsBinding;
  buffer?: RuntimeValue;
  events?: RuntimeValue;
  internalBinding?: (name: string) => unknown;
  stream?: RuntimeValue;
  util?: RuntimeValue;
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
  package?: string;
  path: string;
  sha256: string;
  exports?: Record<string, WasmExportKind>;
}

export interface WasmAdapterReplacement {
  package?: string;
  nativePackages?: string[];
  wasmPackage?: string;
  status?: string;
}

export interface WasmAdapterManifest {
  adapters: WasmAdapterManifestEntry[];
  candidateReplacements?: WasmAdapterReplacement[];
}
