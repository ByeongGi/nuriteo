import { join, normalize, relative } from "../builtins/path.ts";

export type GitWasmOperation =
  | { command: "init" }
  | { command: "status" }
  | { command: "add"; paths: string[] }
  | { command: "commit"; message: string; author: { name: string; email: string } }
  | { command: "log"; maxEntries: number };

export interface GitWasmRuntimeRequest {
  projectRoot: string;
  operation: GitWasmOperation;
  limits: {
    outputBytes: number;
    memoryBytes: number;
    packfileBytes: number;
  };
  capabilities: {
    directTcp: false;
    fetch: false;
    credentials: false;
  };
}

export interface GitWasmRuntimeResult {
  exitCode: number;
  stdout: string;
  stderr: string;
  value?: unknown;
  peakMemoryBytes?: number;
  artifactSha256?: string;
  durationMs?: number;
}

export interface GitWasmRuntime {
  execute(request: GitWasmRuntimeRequest): Promise<GitWasmRuntimeResult>;
}

export interface GitWasmProjectAdapterOptions {
  projectRoot: string;
  loadRuntime(): Promise<GitWasmRuntime>;
  outputBytes?: number;
  memoryBytes?: number;
  packfileBytes?: number;
}

export interface GitCommitOptions {
  message: string;
  author: { name: string; email: string };
}

export class GitWasmProjectAdapter {
  readonly projectRoot: string;
  readonly limits: GitWasmRuntimeRequest["limits"];
  #loadRuntime: GitWasmProjectAdapterOptions["loadRuntime"];
  #runtime: Promise<GitWasmRuntime> | null = null;

  constructor(options: GitWasmProjectAdapterOptions) {
    if (!options.projectRoot.startsWith("/")) throw toolingError("EGITPROJECTPATH", `project root must be absolute: ${options.projectRoot}`);
    this.projectRoot = normalize(options.projectRoot);
    if (this.projectRoot === "/" || this.projectRoot.includes("\0")) {
      throw toolingError("EGITPROJECTPATH", "Git project root must be narrower than the filesystem root and contain no NUL bytes");
    }
    this.limits = {
      outputBytes: positiveLimit(options.outputBytes ?? 1024 * 1024, "outputBytes"),
      memoryBytes: positiveLimit(options.memoryBytes ?? 256 * 1024 * 1024, "memoryBytes"),
      packfileBytes: positiveLimit(options.packfileBytes ?? 64 * 1024 * 1024, "packfileBytes")
    };
    this.#loadRuntime = options.loadRuntime;
  }

  init(): Promise<GitWasmRuntimeResult> {
    return this.#execute({ command: "init" });
  }

  status(): Promise<GitWasmRuntimeResult> {
    return this.#execute({ command: "status" });
  }

  add(paths: string[]): Promise<GitWasmRuntimeResult> {
    if (paths.length === 0) throw toolingError("EGITPATH", "git add requires at least one project path");
    return this.#execute({ command: "add", paths: paths.map((value) => this.#resolveProjectPath(value)) });
  }

  commit(options: GitCommitOptions): Promise<GitWasmRuntimeResult> {
    const message = options.message.trim();
    if (!message) throw toolingError("EGITCOMMIT", "git commit message must not be empty");
    if (byteLength(message) > 64 * 1024) throw toolingError("EGITCOMMIT", "git commit message exceeds 65536 bytes");
    const name = options.author.name.trim();
    const email = options.author.email.trim();
    if (!name || !email || /[\r\n]/.test(`${name}${email}`)) throw toolingError("EGITAUTHOR", "git author name and email must be non-empty single-line values");
    return this.#execute({ command: "commit", message, author: { name, email } });
  }

  log(maxEntries = 20): Promise<GitWasmRuntimeResult> {
    if (!Number.isSafeInteger(maxEntries) || maxEntries <= 0 || maxEntries > 1000) {
      throw toolingError("EGITLOG", `invalid git log entry limit: ${maxEntries}`);
    }
    return this.#execute({ command: "log", maxEntries });
  }

  fetch(_remote: string): never {
    throw toolingError("EGITNETWORK", "Git fetch is disabled until a host-mediated credential-safe transport is configured");
  }

  clone(_remote: string): never {
    throw toolingError("EGITNETWORK", "Git clone is disabled until a host-mediated credential-safe transport is configured");
  }

  async #execute(operation: GitWasmOperation): Promise<GitWasmRuntimeResult> {
    const runtime = await (this.#runtime ??= this.#loadRuntime());
    const result = await runtime.execute({
      projectRoot: this.projectRoot,
      operation,
      limits: { ...this.limits },
      capabilities: { directTcp: false, fetch: false, credentials: false }
    });
    assertBytes(result.stdout, this.limits.outputBytes, "Git stdout");
    assertBytes(result.stderr, this.limits.outputBytes, "Git stderr");
    if (result.peakMemoryBytes !== undefined && result.peakMemoryBytes > this.limits.memoryBytes) {
      throw toolingError("EGITMEMORYLIMIT", `Git runtime exceeded ${this.limits.memoryBytes} bytes`);
    }
    return result;
  }

  #resolveProjectPath(value: string): string {
    if (!value || value.includes("\0")) throw toolingError("EGITPROJECTPATH", "git path must be non-empty and contain no NUL bytes");
    const resolved = normalize(value.startsWith("/") ? value : join(this.projectRoot, value));
    if (resolved !== this.projectRoot && !resolved.startsWith(`${this.projectRoot}/`)) {
      throw toolingError("EGITPROJECTPATH", `git path is outside the project: ${value}`);
    }
    const projectPath = relative(this.projectRoot, resolved) || ".";
    const comparablePath = projectPath.toLowerCase();
    if (comparablePath === ".git" || comparablePath.startsWith(".git/")) {
      throw toolingError("EGITMETADATA", "direct Git metadata mutation is disabled");
    }
    return projectPath;
  }
}

export function createGitWasmProjectAdapter(options: GitWasmProjectAdapterOptions): GitWasmProjectAdapter {
  return new GitWasmProjectAdapter(options);
}

function positiveLimit(value: number, name: string): number {
  if (!Number.isSafeInteger(value) || value <= 0) throw toolingError("EGITLIMIT", `invalid Git ${name}: ${value}`);
  return value;
}

function assertBytes(value: string, limit: number, label: string): void {
  if (byteLength(value) > limit) throw toolingError("EGITOUTPUTLIMIT", `${label} exceeds ${limit} bytes`);
}

function byteLength(value: string): number {
  return new TextEncoder().encode(value).byteLength;
}

function toolingError(code: string, message: string): Error & { code: string } {
  return Object.assign(new Error(message), { code });
}
