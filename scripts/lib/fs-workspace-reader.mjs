import { lstatSync, readFileSync, readdirSync, readlinkSync } from "node:fs";
import { resolve, sep } from "node:path";
import { posix } from "node:path";

export function createNodeFsWorkspaceReader(options) {
  return new NodeFsWorkspaceReader(options);
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
