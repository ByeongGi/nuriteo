import type { RuntimeValue } from "../types.ts";

export const sep = "/";
export const delimiter = ":";

export function normalize(path: string): string {
  assertPath(path);
  if (path.length === 0) return ".";
  const absolute = path.startsWith("/");
  const trailing = path.endsWith("/");
  const parts = normalizeParts(path.split("/"), !absolute);
  const result = `${absolute ? "/" : ""}${parts.join("/")}`;
  if (result.length > 0) return trailing && !result.endsWith("/") ? `${result}/` : result;
  return absolute ? "/" : trailing ? "./" : ".";
}

export function join(...paths: string[]): string {
  return normalize(paths.filter((item) => {
    assertPath(item);
    return item.length > 0;
  }).join("/"));
}

export function resolve(...paths: string[]): string {
  let resolved = "";
  for (let index = paths.length - 1; index >= -1 && !resolved.startsWith("/"); index -= 1) {
    const next = index >= 0 ? paths[index] ?? "" : "/";
    assertPath(next);
    if (next.length > 0) resolved = resolved ? `${next}/${resolved}` : next;
  }
  return normalize(resolved);
}

export function relative(from: string, to: string): string {
  const fromParts = resolve(from).split("/").filter(Boolean);
  const toParts = resolve(to).split("/").filter(Boolean);
  while (fromParts.length > 0 && toParts.length > 0 && fromParts[0] === toParts[0]) {
    fromParts.shift();
    toParts.shift();
  }
  return [...fromParts.map(() => ".."), ...toParts].join("/") || "";
}

export function dirname(path: string): string {
  assertPath(path);
  if (path.length === 0) return ".";
  const normalized = normalize(path);
  if (normalized === "/") return "/";
  const index = normalized.lastIndexOf("/");
  if (index === -1) return ".";
  if (index === 0) return "/";
  return normalized.slice(0, index);
}

export function basename(path: string, suffix = ""): string {
  assertPath(path);
  let base = normalize(path);
  if (base !== "/" && base.endsWith("/")) base = base.slice(0, -1);
  base = base.slice(base.lastIndexOf("/") + 1);
  return suffix && base.endsWith(suffix) ? base.slice(0, -suffix.length) : base;
}

export function extname(path: string): string {
  const base = basename(path);
  const index = base.lastIndexOf(".");
  return index > 0 ? base.slice(index) : "";
}

export function isAbsolute(path: string): boolean {
  assertPath(path);
  return path.startsWith("/");
}

export function parse(path: string): { root: string; dir: string; base: string; ext: string; name: string } {
  const root = isAbsolute(path) ? "/" : "";
  const dir = dirname(path);
  const base = basename(path);
  const ext = extname(path);
  return { root, dir, base, ext, name: ext ? base.slice(0, -ext.length) : base };
}

export function format(pathObject: { dir?: string; root?: string; base?: string; name?: string; ext?: string }): string {
  const dir = pathObject.dir || pathObject.root || "";
  const base = pathObject.base || `${pathObject.name || ""}${pathObject.ext || ""}`;
  return dir ? join(dir, base) : base;
}

export const posix = Object.freeze({
  basename,
  delimiter,
  dirname,
  extname,
  format,
  isAbsolute,
  join,
  normalize,
  parse,
  relative,
  resolve,
  sep
});

export const pathBuiltin = {
  ...posix,
  posix,
  win32: posix
} as typeof posix & { default: typeof posix & { posix: typeof posix; win32: typeof posix }; posix: typeof posix; win32: typeof posix };
Object.defineProperty(pathBuiltin, "default", { configurable: true, enumerable: false, value: pathBuiltin, writable: true });

function normalizeParts(parts: string[], allowAboveRoot: boolean): string[] {
  const output: string[] = [];
  for (const part of parts) {
    if (!part || part === ".") continue;
    if (part === "..") {
      if (output.length > 0 && output.at(-1) !== "..") output.pop();
      else if (allowAboveRoot) output.push("..");
      continue;
    }
    output.push(part);
  }
  return output;
}

function assertPath(path: RuntimeValue): asserts path is string {
  if (typeof path !== "string") throw new TypeError("Path must be a string");
}
