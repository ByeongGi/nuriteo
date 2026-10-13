import { join, resolve } from "./path.ts";

export const builtinModules = Object.freeze([
  "assert",
  "assert/strict",
  "async_hooks",
  "buffer",
  "child_process",
  "constants",
  "console",
  "crypto",
  "dns",
  "dns/promises",
  "diagnostics_channel",
  "events",
  "fs",
  "fs/promises",
  "http",
  "http2",
  "https",
  "module",
  "net",
  "node:assert",
  "node:assert/strict",
  "node:async_hooks",
  "node:buffer",
  "node:child_process",
  "node:constants",
  "node:console",
  "node:crypto",
  "node:dns",
  "node:dns/promises",
  "node:diagnostics_channel",
  "node:events",
  "node:fs",
  "node:fs/promises",
  "node:http",
  "node:http2",
  "node:https",
  "node:module",
  "node:net",
  "node:os",
  "node:path",
  "node:path/posix",
  "node:perf_hooks",
  "node:process",
  "node:querystring",
  "node:readline",
  "node:stream",
  "node:stream/promises",
  "node:stream/web",
  "node:string_decoder",
  "node:timers",
  "node:timers/promises",
  "node:tls",
  "node:tty",
  "node:url",
  "node:util",
  "node:util/types",
  "node:v8",
  "node:vm",
  "node:wasi",
  "node:worker_threads",
  "node:zlib",
  "os",
  "path",
  "path/posix",
  "perf_hooks",
  "process",
  "querystring",
  "readline",
  "stream",
  "stream/promises",
  "stream/web",
  "string_decoder",
  "timers",
  "timers/promises",
  "tls",
  "tty",
  "url",
  "util",
  "util/types",
  "v8",
  "vm",
  "wasi",
  "worker_threads",
  "zlib"
]);

export class Module {
  id: string;
  filename: string;
  loaded = false;
  exports: unknown = {};
  children: Module[] = [];
  paths: string[];

  constructor(id = "", parent?: Module | null) {
    this.id = id;
    this.filename = id;
    this.paths = Module._nodeModulePaths(id ? dirname(id) : "/workspace");
    if (parent) parent.children.push(this);
  }

  require(_specifier: string): unknown {
    throw new Error("Module.prototype.require is not wired in browser runtime preflight");
  }

  static builtinModules = builtinModules;
  static _extensions: Record<string, unknown> = {
    ".js": true,
    ".cjs": true,
    ".json": true
  };
  static _cache = Object.create(null) as Record<string, Module>;

  static _nodeModulePaths(from: string): string[] {
    const paths: string[] = [];
    let current = resolve(from || "/workspace");
    while (current !== "/") {
      paths.push(join(current, "node_modules"));
      current = dirname(current);
    }
    paths.push("/node_modules");
    return paths;
  }

  static _resolveFilename(request: string, parent?: { filename?: string; paths?: string[] } | null): string {
    if (builtinModules.includes(request)) return request;
    if (request.startsWith("/") || request.startsWith("./") || request.startsWith("../")) {
      return resolve(parent?.filename ? dirname(parent.filename) : "/workspace", request);
    }
    const base = parent?.paths?.[0] || "/workspace/node_modules";
    return join(base, request);
  }
}

export function createRequire(filename: string): (specifier: string) => unknown {
  const parent = new Module(filename);
  return (specifier: string) => parent.require(specifier);
}

export function enableCompileCache(): { status: number; directory?: string; message?: string } {
  return { status: 0 };
}

export function isBuiltin(specifier: string): boolean {
  return builtinModules.includes(specifier);
}

export function syncBuiltinESMExports(): void {}

export const moduleBuiltin = Object.freeze({
  Module,
  _cache: Module._cache,
  _extensions: Module._extensions,
  _nodeModulePaths: Module._nodeModulePaths,
  _resolveFilename: Module._resolveFilename,
  builtinModules,
  createRequire,
  default: Module,
  enableCompileCache,
  isBuiltin,
  syncBuiltinESMExports
});

function dirname(path: string): string {
  const index = path.lastIndexOf("/");
  if (index <= 0) return "/";
  return path.slice(0, index);
}
