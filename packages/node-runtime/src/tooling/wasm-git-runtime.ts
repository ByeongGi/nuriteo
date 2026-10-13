import { dirname, join, normalize } from "../builtins/path.ts";
import type { GitWasmRuntime, GitWasmRuntimeRequest, GitWasmRuntimeResult } from "./git-wasm-project-adapter.ts";

export interface WasmGitProjectSnapshot {
  read(): ReadonlyMap<string, string | Uint8Array>;
  replace(files: ReadonlyMap<string, Uint8Array>): void | Promise<void>;
}

export interface WasmGitRuntimeOptions {
  expectedWasmSha256: string;
  loadWasm(): Uint8Array | Promise<Uint8Array>;
  snapshot: WasmGitProjectSnapshot;
}

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

export class IntegrityPinnedWasmGitRuntime implements GitWasmRuntime {
  readonly artifactSha256: string;
  #module: WasmGitModule;
  #snapshot: WasmGitProjectSnapshot;
  #projectRoot: string | null = null;
  #stdout: string[] = [];
  #stderr: string[] = [];

  private constructor(module: WasmGitModule, snapshot: WasmGitProjectSnapshot, artifactSha256: string) {
    this.#module = module;
    this.#snapshot = snapshot;
    this.artifactSha256 = artifactSha256;
  }

  static async create(options: WasmGitRuntimeOptions): Promise<IntegrityPinnedWasmGitRuntime> {
    if (!/^[a-f0-9]{64}$/.test(options.expectedWasmSha256)) {
      throw runtimeError("EGITINTEGRITY", "Git WASM expected SHA-256 is invalid");
    }
    const bytes = copyBytes(await options.loadWasm());
    const actual = await sha256Hex(bytes);
    if (actual !== options.expectedWasmSha256) {
      throw runtimeError("EGITINTEGRITY", `Git WASM integrity mismatch: expected ${options.expectedWasmSha256}, received ${actual}`);
    }
    const { default: initialize } = await import("wasm-git/lg2.js");
    let runtime: IntegrityPinnedWasmGitRuntime | null = null;
    const module = await initialize({
      noInitialRun: true,
      wasmBinary: bytes,
      print(line) {
        if (runtime) runtime.#stdout.push(String(line));
      },
      printErr(line) {
        if (runtime) runtime.#stderr.push(String(line));
      }
    });
    runtime = new IntegrityPinnedWasmGitRuntime(module, options.snapshot, actual);
    runtime.#prepareIdentityDirectory();
    return runtime;
  }

  async execute(request: GitWasmRuntimeRequest): Promise<GitWasmRuntimeResult> {
    const startedAt = performance.now();
    this.#ensureProject(request.projectRoot);
    this.#stdout = [];
    this.#stderr = [];
    this.#module.FS.chdir(request.projectRoot);

    let args: string[];
    switch (request.operation.command) {
      case "init":
        args = ["init", "."];
        break;
      case "status":
        args = ["status", "--short"];
        break;
      case "add":
        args = ["add", ...request.operation.paths];
        break;
      case "commit":
        this.#writeIdentity(request.operation.author);
        args = ["commit", "-m", request.operation.message];
        break;
      case "log":
        args = ["log", "--oneline", `-${request.operation.maxEntries}`];
        break;
    }

    let exitCode: number;
    try {
      exitCode = this.#module.callMain(args);
    } catch (error) {
      const value = error as { status?: unknown };
      if (typeof value.status !== "number") throw error;
      exitCode = value.status;
    }
    if (request.operation.command === "init" || request.operation.command === "add" || request.operation.command === "commit") {
      await this.#persistProject();
    }
    return {
      exitCode,
      stdout: joinOutput(this.#stdout),
      stderr: joinOutput(this.#stderr),
      peakMemoryBytes: this.#module.HEAPU8.buffer.byteLength,
      artifactSha256: this.artifactSha256,
      durationMs: performance.now() - startedAt
    };
  }

  #ensureProject(projectRoot: string): void {
    if (this.#projectRoot !== null) {
      if (this.#projectRoot !== projectRoot) throw runtimeError("EGITPROJECTPATH", "Git runtime cannot switch project roots");
      return;
    }
    this.#projectRoot = normalize(projectRoot);
    mkdirRecursive(this.#module.FS, this.#projectRoot);
    for (const [path, contents] of this.#snapshot.read()) {
      const normalized = normalizeSnapshotPath(path);
      const target = join(this.#projectRoot, normalized);
      mkdirRecursive(this.#module.FS, dirname(target));
      this.#module.FS.writeFile(target, contents);
    }
  }

  #prepareIdentityDirectory(): void {
    mkdirRecursive(this.#module.FS, "/home/web_user");
  }

  #writeIdentity(author: { name: string; email: string }): void {
    this.#module.FS.writeFile("/home/web_user/.gitconfig", `[user]\nname = ${author.name}\nemail = ${author.email}\n`);
  }

  async #persistProject(): Promise<void> {
    if (!this.#projectRoot) return;
    const files = new Map<string, Uint8Array>();
    collectFiles(this.#module.FS, this.#projectRoot, "", files);
    await this.#snapshot.replace(files);
  }
}

export function createIntegrityPinnedWasmGitRuntime(options: WasmGitRuntimeOptions): Promise<IntegrityPinnedWasmGitRuntime> {
  return IntegrityPinnedWasmGitRuntime.create(options);
}

function collectFiles(fs: EmscriptenFileSystem, root: string, relativeRoot: string, output: Map<string, Uint8Array>): void {
  const directory = relativeRoot ? join(root, relativeRoot) : root;
  for (const name of fs.readdir(directory)) {
    if (name === "." || name === "..") continue;
    const relativePath = relativeRoot ? join(relativeRoot, name) : name;
    const absolutePath = join(root, relativePath);
    const stat = fs.stat(absolutePath);
    if (fs.isDir(stat.mode)) collectFiles(fs, root, relativePath, output);
    else output.set(relativePath, copyBytes(fs.readFile(absolutePath)));
  }
}

function mkdirRecursive(fs: EmscriptenFileSystem, path: string): void {
  const normalized = normalize(path);
  if (normalized === "/" || normalized === ".") return;
  const parent = dirname(normalized);
  if (parent !== normalized) mkdirRecursive(fs, parent);
  try {
    fs.mkdir(normalized);
  } catch (error) {
    const value = error as { errno?: unknown };
    if (value.errno !== 20) throw error;
  }
}

function normalizeSnapshotPath(path: string): string {
  const normalized = normalize(path);
  if (!path || path.startsWith("/") || normalized === ".." || normalized.startsWith("../") || path.includes("\0")) {
    throw runtimeError("EGITPROJECTPATH", `invalid Git snapshot path: ${path}`);
  }
  return normalized;
}

function joinOutput(lines: string[]): string {
  return lines.length === 0 ? "" : `${lines.join("\n")}\n`;
}

function copyBytes(bytes: Uint8Array): Uint8Array<ArrayBuffer> {
  const copy = new Uint8Array(bytes.byteLength);
  copy.set(bytes);
  return copy;
}

async function sha256Hex(bytes: Uint8Array): Promise<string> {
  const digest = await crypto.subtle.digest("SHA-256", copyBytes(bytes).buffer);
  return [...new Uint8Array(digest)].map((byte) => byte.toString(16).padStart(2, "0")).join("");
}

function runtimeError(code: string, message: string): Error & { code: string } {
  return Object.assign(new Error(message), { code });
}
