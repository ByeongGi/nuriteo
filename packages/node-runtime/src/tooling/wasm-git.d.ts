declare module "wasm-git/lg2.js" {
  interface EmscriptenFileSystem {
    chdir(path: string): void;
    mkdir(path: string): void;
    readFile(path: string): Uint8Array;
    readdir(path: string): string[];
    stat(path: string): { mode: number };
    isDir(mode: number): boolean;
    writeFile(path: string, data: string | Uint8Array): void;
  }

  interface WasmGitModule {
    FS: EmscriptenFileSystem;
    HEAPU8: Uint8Array;
    callMain(args: string[]): number;
  }

  interface WasmGitModuleOptions {
    noInitialRun?: boolean;
    wasmBinary?: Uint8Array;
    print?(line: unknown): void;
    printErr?(line: unknown): void;
  }

  export default function initialize(options?: WasmGitModuleOptions): Promise<WasmGitModule>;
}
