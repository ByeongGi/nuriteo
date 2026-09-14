import { join, resolve } from "./path.ts";

export const builtinModules = Object.freeze([
  "assert",
  "assert/strict",
  "buffer",
  "events",
  "fs",
  "module",
  "node:assert",
  "node:assert/strict",
  "node:buffer",
  "node:events",
  "node:fs",
  "node:module",
  "node:os",
  "node:path",
  "node:path/posix",
  "node:process",
  "node:stream",
  "node:stream/promises",
  "node:tty",
  "node:url",
  "node:util",
  "node:zlib",
  "os",
  "path",
  "path/posix",
  "process",
  "stream",
  "stream/promises",
  "tty",
  "url",
  "util",
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
  static _extensions = Object.freeze({
    ".js": true,
    ".cjs": true,
    ".json": true
  });
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

export const moduleBuiltin = Object.freeze({
  Module,
  builtinModules,
  createRequire,
  default: Module,
  enableCompileCache
});

function dirname(path: string): string {
  const index = path.lastIndexOf("/");
  if (index <= 0) return "/";
  return path.slice(0, index);
}
