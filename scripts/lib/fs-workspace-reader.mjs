import { lstatSync, readFileSync, readdirSync, readlinkSync } from "node:fs";
import { resolve, sep } from "node:path";
import { posix } from "node:path";

export function createNodeFsWorkspaceReader(options) {
  return new NodeFsWorkspaceReader(options);
}

export function createFallbackWorkspaceReader(readers) {
  return new FallbackWorkspaceReader(readers);
}

class NodeFsWorkspaceReader {
  #root;
  #virtualRoot;

  constructor(options) {
    this.#root = resolve(options.root);
    this.#virtualRoot = normalizeVirtualPath(options.virtualRoot || "/");
  }

  readText(path) {
    return readFileSync(this.#toNativePath(path), "utf8");
  }

  listDir(path) {
    return readdirSync(this.#toNativePath(path)).sort();
  }

  readlink(path) {
    return readlinkSync(this.#toNativePath(path));
  }

  exists(path) {
    try {
      lstatSync(this.#toNativePath(path));
      return true;
    } catch {
      return false;
    }
  }

  #toNativePath(path) {
    const virtualPath = normalizeVirtualPath(path);
    const relativePath = relativeVirtualPath(this.#virtualRoot, virtualPath);
    const nativePath = resolve(this.#root, ...relativePath.split("/").filter(Boolean));
    if (nativePath !== this.#root && !nativePath.startsWith(`${this.#root}${sep}`)) {
      throw Object.assign(new Error(`Path escapes workspace root: ${path}`), { code: "EACCES" });
    }
    return nativePath;
  }
}

class FallbackWorkspaceReader {
  #readers;

  constructor(readers) {
    this.#readers = readers;
  }

  readText(path) {
    for (const reader of this.#readers) {
      try {
        return reader.readText(path);
      } catch {
        // Try the next mounted root.
      }
    }
    throw Object.assign(new Error(`No such file: ${path}`), { code: "ENOENT" });
  }

  listDir(path) {
    const entries = new Set();
    let found = false;
    for (const reader of this.#readers) {
      try {
        for (const entry of reader.listDir(path)) entries.add(entry);
        found = true;
      } catch {
        // Try the next mounted root.
      }
    }
    if (!found) throw Object.assign(new Error(`No such directory: ${path}`), { code: "ENOENT" });
    return [...entries].sort();
  }

  readlink(path) {
    for (const reader of this.#readers) {
      try {
        return reader.readlink(path);
      } catch {
        // Try the next mounted root.
      }
    }
    throw Object.assign(new Error(`Not a symbolic link: ${path}`), { code: "EINVAL" });
  }

  exists(path) {
    return this.#readers.some((reader) => reader.exists(path));
  }
}

function relativeVirtualPath(root, path) {
  if (root === "/") return path.slice(1);
  if (path === root) return "";
  if (path.startsWith(`${root}/`)) return path.slice(root.length + 1);
  throw Object.assign(new Error(`Path is outside virtual root: ${path}`), { code: "ENOENT" });
}

function normalizeVirtualPath(path) {
  const normalized = posix.normalize(`/${path.replaceAll("\\", "/")}`);
  return normalized === "/" ? "/" : normalized.replace(/\/$/, "");
}
