import type { ProjectWorkspaceStore } from "./project-workspace.ts";

export type ProjectWorkspaceTreeNodeType = "directory" | "file";

export interface ProjectWorkspaceTreeNode {
  children?: ProjectWorkspaceTreeNode[];
  dirty?: boolean;
  name: string;
  path: string;
  type: ProjectWorkspaceTreeNodeType;
}

export interface ProjectWorkspaceEditorFile {
  data: string;
  dirty: boolean;
  path: string;
}

export interface ProjectWorkspaceEditorSaveEvent extends ProjectWorkspaceEditorFile {
  relativePath: string;
}

export type ProjectWorkspaceEditorChangeKind =
  | "create"
  | "delete"
  | "discard"
  | "edit"
  | "rename"
  | "save";

export interface ProjectWorkspaceEditorChangeEvent {
  data?: string;
  dirty: boolean;
  kind: ProjectWorkspaceEditorChangeKind;
  path: string;
  previousPath?: string;
  relativePath: string;
}

export interface ProjectWorkspaceEditorBridgeOptions {
  onChange?: (event: ProjectWorkspaceEditorChangeEvent) => void;
  onSave?: (event: ProjectWorkspaceEditorSaveEvent) => void;
}

export interface ProjectWorkspaceSearchMatch {
  column: number;
  line: number;
  path: string;
  snippet: string;
}

export class ProjectWorkspaceEditorBridge {
  readonly store: ProjectWorkspaceStore;
  #dirty = new Map<string, string>();
  #onChange: ((event: ProjectWorkspaceEditorChangeEvent) => void) | null;
  #onSave: ((event: ProjectWorkspaceEditorSaveEvent) => void) | null;

  constructor(store: ProjectWorkspaceStore, options: ProjectWorkspaceEditorBridgeOptions = {}) {
    this.store = store;
    this.#onChange = options.onChange || null;
    this.#onSave = options.onSave || null;
  }

  tree(): ProjectWorkspaceTreeNode[] {
    const root: ProjectWorkspaceTreeNode = {
      children: [],
      name: basename(this.store.root),
      path: this.store.root,
      type: "directory"
    };
    for (const file of this.#allKnownFiles()) {
      insertTreeFile(root, file.path, this.#dirty.has(file.path));
    }
    return sortTree(root.children || []);
  }

  openFile(path: string): ProjectWorkspaceEditorFile {
    const normalized = this.#projectPath(path);
    return {
      path: normalized,
      data: this.#dirty.get(normalized) ?? this.store.readText(normalized),
      dirty: this.#dirty.has(normalized)
    };
  }

  createFile(path: string, data = ""): ProjectWorkspaceEditorFile {
    const normalized = this.#projectPath(path);
    if (this.#exists(normalized)) throw Object.assign(new Error(`Project file already exists: ${normalized}`), { code: "EEXIST" });
    this.store.writeText(normalized, data);
    this.#dirty.delete(normalized);
    const file = { path: normalized, data, dirty: false };
    this.#emitChange("create", file);
    return file;
  }

  editText(path: string, data: string): ProjectWorkspaceEditorFile {
    const normalized = this.#projectPath(path);
    if (!this.#exists(normalized)) throw Object.assign(new Error(`No such project file: ${normalized}`), { code: "ENOENT" });
    this.#dirty.set(normalized, data);
    const file = { path: normalized, data, dirty: true };
    this.#emitChange("edit", file);
    return file;
  }

  saveFile(path: string): ProjectWorkspaceEditorFile {
    const normalized = this.#projectPath(path);
    const data = this.#dirty.get(normalized);
    if (data === undefined) return this.openFile(normalized);
    this.store.writeText(normalized, data);
    this.#dirty.delete(normalized);
    const file = { path: normalized, data, dirty: false };
    this.#onSave?.({ ...file, relativePath: this.#relativePath(normalized) });
    this.#emitChange("save", file);
    return file;
  }

  saveAll(): ProjectWorkspaceEditorFile[] {
    const paths = [...this.#dirty.keys()].sort();
    return paths.map((path) => this.saveFile(path));
  }

  discard(path: string): ProjectWorkspaceEditorFile {
    const normalized = this.#projectPath(path);
    this.#dirty.delete(normalized);
    const file = this.openFile(normalized);
    this.#emitChange("discard", file);
    return file;
  }

  renameFile(from: string, to: string): ProjectWorkspaceEditorFile {
    const fromPath = this.#projectPath(from);
    const toPath = this.#projectPath(to);
    if (!this.#exists(fromPath)) throw Object.assign(new Error(`No such project file: ${fromPath}`), { code: "ENOENT" });
    if (this.#exists(toPath)) throw Object.assign(new Error(`Project file already exists: ${toPath}`), { code: "EEXIST" });
    const data = this.#dirty.get(fromPath) ?? this.store.readText(fromPath);
    this.store.files.delete(fromPath);
    this.#dirty.delete(fromPath);
    this.store.writeText(toPath, data);
    const file = { path: toPath, data, dirty: false };
    this.#emitChange("rename", file, fromPath);
    return file;
  }

  deleteFile(path: string): void {
    const normalized = this.#projectPath(path);
    if (!this.#exists(normalized)) throw Object.assign(new Error(`No such project file: ${normalized}`), { code: "ENOENT" });
    const data = this.#dirty.get(normalized) ?? this.store.readText(normalized);
    this.store.files.delete(normalized);
    this.#dirty.delete(normalized);
    this.#emitChange("delete", { path: normalized, data, dirty: false });
  }

  dirtyFiles(): ProjectWorkspaceEditorFile[] {
    return [...this.#dirty.entries()]
      .sort(([left], [right]) => left.localeCompare(right))
      .map(([path, data]) => ({ path, data, dirty: true }));
  }

  search(query: string): ProjectWorkspaceSearchMatch[] {
    if (!query) return [];
    const matches: ProjectWorkspaceSearchMatch[] = [];
    for (const file of this.#allKnownFiles()) {
      const lines = file.data.split("\n");
      for (let index = 0; index < lines.length; index += 1) {
        const lineText = lines[index];
        if (lineText === undefined) continue;
        const column = lineText.indexOf(query);
        if (column < 0) continue;
        matches.push({
          path: file.path,
          line: index + 1,
          column: column + 1,
          snippet: lineText.trim()
        });
      }
    }
    return matches;
  }

  #allKnownFiles(): ProjectWorkspaceEditorFile[] {
    const files = new Map(this.store.listFiles().map((file) => [file.path, file.data]));
    for (const [path, data] of this.#dirty) files.set(path, data);
    return [...files.entries()]
      .sort(([left], [right]) => left.localeCompare(right))
      .map(([path, data]) => ({ path, data, dirty: this.#dirty.has(path) }));
  }

  #exists(path: string): boolean {
    if (this.#dirty.has(path)) return true;
    try {
      this.store.readText(path);
      return true;
    } catch {
      return false;
    }
  }

  #projectPath(path: string): string {
    const normalized = normalizePath(path);
    if (normalized === this.store.root || normalized.startsWith(`${this.store.root}/`)) return normalized;
    return `${this.store.root}/${normalized.replace(/^\/+/, "")}`;
  }

  #relativePath(path: string): string {
    return path.slice(this.store.root.length).replace(/^\/+/, "");
  }

  #emitChange(kind: ProjectWorkspaceEditorChangeKind, file: ProjectWorkspaceEditorFile, previousPath?: string): void {
    this.#onChange?.({
      data: file.data,
      dirty: file.dirty,
      kind,
      path: file.path,
      ...(previousPath ? { previousPath } : {}),
      relativePath: this.#relativePath(file.path)
    });
  }
}

export function createProjectWorkspaceEditorBridge(
  store: ProjectWorkspaceStore,
  options: ProjectWorkspaceEditorBridgeOptions = {}
): ProjectWorkspaceEditorBridge {
  return new ProjectWorkspaceEditorBridge(store, options);
}

function insertTreeFile(root: ProjectWorkspaceTreeNode, path: string, dirty: boolean): void {
  const relative = path.slice(root.path.length).replace(/^\/+/, "");
  const segments = relative.split("/").filter(Boolean);
  let current = root;
  for (const [index, segment] of segments.entries()) {
    const childPath = `${current.path}/${segment}`;
    const isFile = index === segments.length - 1;
    let child = current.children?.find((node) => node.name === segment);
    if (!child) {
      child = {
        ...(isFile ? { dirty } : { children: [] }),
        name: segment,
        path: childPath,
        type: isFile ? "file" : "directory"
      };
      current.children = [...(current.children || []), child];
    }
    current = child;
  }
}

function sortTree(nodes: ProjectWorkspaceTreeNode[]): ProjectWorkspaceTreeNode[] {
  return nodes
    .map((node) => ({
      ...node,
      ...(node.children ? { children: sortTree(node.children) } : {})
    }))
    .sort((left, right) => {
      if (left.type !== right.type) return left.type === "directory" ? -1 : 1;
      return left.name.localeCompare(right.name);
    });
}

function normalizePath(path: string): string {
  const normalized = path.replaceAll("\\", "/").replace(/\/+/g, "/");
  if (normalized === "") return "/";
  if (normalized === "/") return "/";
  return normalized.endsWith("/") ? normalized.slice(0, -1) : normalized;
}

function basename(path: string): string {
  const normalized = normalizePath(path);
  const index = normalized.lastIndexOf("/");
  return normalized.slice(index + 1) || "/";
}
