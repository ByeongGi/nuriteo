import { ProjectWorkspaceStore } from "../../browser-host/src/storage/index.ts";


import type { FileSystemTree, PreviewProjectFile, PreviewProjectFileInput, ProductWorkflow } from "./controller-contracts.ts";


export interface NormalizedRelayResponse {
  status: number;
  headers: Record<string, string>;
  body: string;
}

export const MAX_IMPORTED_PROJECT_FILES = 256;

export const MAX_IMPORTED_PROJECT_FILE_BYTES = 1024 * 1024;

export const MAX_IMPORTED_PROJECT_TOTAL_BYTES = 8 * 1024 * 1024;

export const MAX_IMPORTED_PROJECT_PATH_BYTES = 512;

export const MAX_IMPORTED_PROJECT_PATH_SEGMENTS = 32;

export const MAX_IMPORTED_PROJECT_PATH_SEGMENT_BYTES = 255;

export function normalizeRelativeProjectPath(path: string): string {
  const relative = path.replace(/^\/+/u, "").replace(/\/+$/u, "");
  if (!relative || relative.split("/").some((segment) => segment === "" || segment === "." || segment === "..")) {
    throw new Error(`Invalid project path: ${path}`);
  }
  return relative;
}

export function isAdapterFrameworkFixture(workflow: ProductWorkflow): boolean {
  for (const name of ["next", "vite"]) {
    const manifestPath = `${workflow.projectRoot}/node_modules/${name}/package.json`;
    if (!workflow.workspace.exists(manifestPath)) continue;
    try {
      const manifest = JSON.parse(workflow.workspace.readText(manifestPath)) as { nuriteoFixture?: unknown; version?: unknown };
      if (manifest.nuriteoFixture === true || manifest.version === "product-fixture") return true;
    } catch {
      return true;
    }
  }
  return false;
}

export function readLockedDependencyVersions(workflow: ProductWorkflow): Map<string, string> {
  const versions = new Map<string, string>();
  const root = workflow.projectRoot;
  const packageLock = `${root}/package-lock.json`;
  if (workflow.workspace.exists(packageLock)) {
    try {
      const parsed = JSON.parse(workflow.workspace.readText(packageLock)) as { packages?: Record<string, { version?: string }> };
      for (const [path, entry] of Object.entries(parsed.packages ?? {})) {
        const marker = "node_modules/";
        const index = path.lastIndexOf(marker);
        if (index < 0 || !entry.version) continue;
        const name = path.slice(index + marker.length);
        if (!name || name.includes("/node_modules/")) continue;
        versions.set(name, entry.version);
      }
    } catch {
      /* ignore an unreadable lockfile and use package.json ranges */
    }
  }
  const pnpmLock = `${root}/pnpm-lock.yaml`;
  if (workflow.workspace.exists(pnpmLock)) {
    try {
      for (const line of workflow.workspace.readText(pnpmLock).split("\n")) {
        const match = /^\s*\/?((?:@[^/\s]+\/)?[^@\s]+)@([0-9][^:\s]*):?\s*$/u.exec(line);
        if (match?.[1] && match[2]) versions.set(match[1], match[2]);
      }
    } catch {
      /* ignore an unreadable lockfile and use package.json ranges */
    }
  }
  return versions;
}

export function isBrowserToolchainPackage(name: string): boolean {
  return name === "vite"
    || name === "typescript"
    || name === "esbuild"
    || name === "tsx"
    || name.startsWith("@types/")
    || name.startsWith("@vitejs/")
    || name.startsWith("@sveltejs/vite-plugin");
}

export function normalizeExportPrefix(path?: string): string {
  if (!path) return "";
  return path.replace(/^\/+|\/+$/g, "").replace(/^\.\//, "");
}

export function validateImportedProjectFiles(
  files: readonly PreviewProjectFileInput[]
): PreviewProjectFile[] {
  if (files.length > MAX_IMPORTED_PROJECT_FILES) {
    throw new Error("Imported Project exceeds the Runtime file limit");
  }
  const encoder = new TextEncoder();
  const paths = new Set<string>();
  const validated: PreviewProjectFile[] = [];
  let totalBytes = 0;
  for (const input of files) {
    if (!isSafeImportedProjectPath(input.path) || paths.has(input.path)) {
      throw new Error("Imported Project contains an unsafe or duplicate path");
    }
    paths.add(input.path);
    let file: PreviewProjectFile;
    if ("content" in input) {
      if (typeof input.content !== "string") {
        throw new Error("Imported Project contains invalid text content");
      }
      file = { path: input.path, kind: "text", bytes: encoder.encode(input.content) };
    } else {
      if ((input.kind !== "text" && input.kind !== "binary") || !(input.bytes instanceof Uint8Array)) {
        throw new Error("Imported Project contains an invalid file");
      }
      file = { path: input.path, kind: input.kind, bytes: Uint8Array.from(input.bytes) };
    }
    if (file.bytes.byteLength > MAX_IMPORTED_PROJECT_FILE_BYTES) {
      throw new Error("Imported Project exceeds the Runtime per-file limit");
    }
    totalBytes += file.bytes.byteLength;
    if (!Number.isSafeInteger(totalBytes) || totalBytes > MAX_IMPORTED_PROJECT_TOTAL_BYTES) {
      throw new Error("Imported Project exceeds the Runtime byte limit");
    }
    validated.push(file);
  }
  return validated;
}

export function isSafeImportedProjectPath(path: unknown): path is string {
  if (
    typeof path !== "string"
    || path.length === 0
    || path !== path.normalize("NFC")
    || path.startsWith("/")
    || /^[A-Za-z]:\//u.test(path)
    || path.includes("\\")
    || /[\u0000-\u001f\u007f]/u.test(path)
    || hasUnpairedSurrogate(path)
  ) return false;
  const encoder = new TextEncoder();
  if (encoder.encode(path).byteLength > MAX_IMPORTED_PROJECT_PATH_BYTES) return false;
  const segments = path.split("/");
  return segments.length <= MAX_IMPORTED_PROJECT_PATH_SEGMENTS && segments.every((segment) =>
    segment.length > 0
    && segment !== "."
    && segment !== ".."
    && encoder.encode(segment).byteLength <= MAX_IMPORTED_PROJECT_PATH_SEGMENT_BYTES
  );
}

export function hasUnpairedSurrogate(value: string): boolean {
  for (let index = 0; index < value.length; index += 1) {
    const unit = value.charCodeAt(index);
    if (unit >= 0xd800 && unit <= 0xdbff) {
      const trailing = value.charCodeAt(index + 1);
      if (!(trailing >= 0xdc00 && trailing <= 0xdfff)) return true;
      index += 1;
    } else if (unit >= 0xdc00 && unit <= 0xdfff) {
      return true;
    }
  }
  return false;
}

export function relativeProjectPath(path: string, root: string): string {
  const normalizedRoot = root.replace(/\/+$/, "");
  if (!normalizedRoot) return path.replace(/^\/+/, "");
  if (path === normalizedRoot) return "";
  if (path.startsWith(`${normalizedRoot}/`)) return path.slice(normalizedRoot.length + 1);
  return path.replace(/^\/+/, "");
}

export function pathBasename(path: string): string {
  const parts = path.split("/").filter(Boolean);
  return parts.at(-1) || path;
}

export function classifyProjectBytes(bytes: Uint8Array): "text" | "binary" {
  try {
    new TextDecoder("utf-8", { fatal: true }).decode(bytes);
    return "text";
  } catch {
    return "binary";
  }
}

export function compareUtf8Path(left: string, right: string): number {
  const encoder = new TextEncoder();
  const leftBytes = encoder.encode(left);
  const rightBytes = encoder.encode(right);
  const length = Math.min(leftBytes.byteLength, rightBytes.byteLength);
  for (let index = 0; index < length; index += 1) {
    const difference = (leftBytes[index] ?? 0) - (rightBytes[index] ?? 0);
    if (difference !== 0) return difference;
  }
  return leftBytes.byteLength - rightBytes.byteLength;
}

export function insertFileSystemTreeEntry(tree: FileSystemTree, relativePath: string, contents: string): void {
  const segments = relativePath.split("/").filter(Boolean);
  if (segments.length === 0) return;
  let cursor = tree;
  for (let index = 0; index < segments.length; index += 1) {
    const name = segments[index]!;
    const isFile = index === segments.length - 1;
    if (isFile) {
      cursor[name] = { file: { contents } };
      return;
    }
    const existing = cursor[name];
    if (!existing || !("directory" in existing)) {
      cursor[name] = { directory: {} };
    }
    const node = cursor[name];
    if (!node || !("directory" in node)) return;
    cursor = node.directory;
  }
}

export function projectHasGitMarker(project: ProjectWorkspaceStore | null): boolean {
  if (!project) return false;
  for (const file of project.listFiles()) {
    const relative = relativeProjectPath(file.path, project.root);
    if (relative === ".git" || relative.startsWith(".git/")) return true;
  }
  return false;
}
