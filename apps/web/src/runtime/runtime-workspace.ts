import type { FileSystemTree, PreviewWorkflowController, PreviewWorkflowSnapshot } from "@nuriteo/workspace-runtime";

import { RuntimeAdapterError } from "#src/runtime/runtime-adapter-error.ts";
import type {
  RuntimeBundleFile,
  RuntimeTerminalFileChange,
  RuntimeViewState,
  RuntimeWorkspaceFile,
  RuntimeWorkspacePort,
  RuntimeWorkspaceState
} from "#src/runtime/runtime-adapter.ts";

const MAX_TEMPLATE_FILES = 256;
const MAX_TEMPLATE_FILE_BYTES = 1024 * 1024;
const MAX_TEMPLATE_TOTAL_BYTES = 8 * 1024 * 1024;

type WorkspaceController = Pick<PreviewWorkflowController,
  | "loadTemplate"
  | "exportTreeJson"
  | "importProjectFiles"
  | "exportProjectFiles"
  | "createTextFile"
  | "createDirectory"
  | "movePath"
  | "renameFile"
  | "deleteFile"
  | "deletePath"
  | "saveTextFile"
>;

export interface RuntimeWorkspaceOwner {
  readonly projectId: string;
  readonly displayName: string;
  readonly controller: WorkspaceController;
}

export interface RuntimeWorkspaceHost<Owner extends RuntimeWorkspaceOwner> {
  requireReady(): Owner;
  isCurrent(current: Owner): boolean;
  projectId(): string | null;
  localDraftAccess(): RuntimeViewState["localDraftAccess"];
  applySnapshot(current: Owner, snapshot: PreviewWorkflowSnapshot): void;
  publicState(): RuntimeViewState;
}

export interface RuntimeWorkspaceBundle<Owner extends RuntimeWorkspaceOwner> {
  readonly port: RuntimeWorkspacePort;
  markMutation(): void;
  synchronize(current: Owner): void;
  reset(): void;
}

function createEmptyWorkspaceState(): RuntimeWorkspaceState {
  return {
    status: "empty",
    projectId: null,
    root: null,
    files: [],
    directories: [],
    totalBytes: 0,
    errorCode: null
  };
}

function copyWorkspaceState(value: RuntimeWorkspaceState): RuntimeWorkspaceState {
  return { ...value, directories: [...value.directories], files: value.files.map((file) => ({ ...file })) };
}

function decodeRuntimeBundleFiles(
  files: readonly RuntimeBundleFile[]
): {
  files: Array<{ path: string; kind: "text" | "binary"; bytes: Uint8Array }>;
  text: Map<string, string>;
  totalBytes: number;
} {
  if (files.length > MAX_TEMPLATE_FILES) {
    throw new Error("Saved Project file count is outside the Runtime limit.");
  }
  const strictDecoder = new TextDecoder("utf-8", { fatal: true });
  const decoded: Array<{ path: string; kind: "text" | "binary"; bytes: Uint8Array }> = [];
  const text = new Map<string, string>();
  let totalBytes = 0;
  let previousPath: string | undefined;
  for (const file of files) {
    if (
      !isSafeRuntimeBundlePath(file.path)
      || (file.kind !== "text" && file.kind !== "binary")
      || file.bytes.byteLength > MAX_TEMPLATE_FILE_BYTES
    ) {
      throw new Error("Saved Project contains an unsupported Runtime file.");
    }
    totalBytes += file.bytes.byteLength;
    if (!Number.isSafeInteger(totalBytes) || totalBytes > MAX_TEMPLATE_TOTAL_BYTES) {
      throw new Error("Saved Project exceeds the Runtime byte limit.");
    }
    if (previousPath !== undefined && compareUtf8Paths(previousPath, file.path) >= 0) {
      throw new Error("Saved Project paths are not unique and ordered.");
    }
    const bytes = Uint8Array.from(file.bytes);
    decoded.push({ path: file.path, kind: file.kind, bytes });
    if (file.kind === "text") text.set(file.path, strictDecoder.decode(bytes));
    previousPath = file.path;
  }
  return { files: decoded, text, totalBytes };
}

function verifyRuntimeBundleRoundTrip(
  expected: readonly { path: string; kind: "text" | "binary"; bytes: Uint8Array }[],
  actual: readonly { path: string; kind: "text" | "binary"; bytes: Uint8Array }[]
): void {
  if (actual.length !== expected.length) throw new Error("Runtime materialization changed the verified Project file set.");
  for (const [index, file] of expected.entries()) {
    const candidate = actual[index];
    if (
      candidate?.path !== file.path
      || candidate.kind !== file.kind
      || candidate.bytes.byteLength !== file.bytes.byteLength
      || candidate.bytes.some((byte, byteIndex) => byte !== file.bytes[byteIndex])
    ) throw new Error("Runtime materialization changed verified Project bytes.");
  }
}

function isSafeRuntimeBundlePath(path: string): boolean {
  if (
    path.length === 0
    || path !== path.normalize("NFC")
    || path.startsWith("/")
    || path.includes("\\")
    || /[\u0000-\u001f\u007f]/u.test(path)
    || new TextEncoder().encode(path).byteLength > 512
  ) return false;
  const segments = path.split("/");
  return segments.length <= 32 && segments.every((segment) =>
    segment.length > 0
    && segment !== "."
    && segment !== ".."
    && new TextEncoder().encode(segment).byteLength <= 255
  );
}

function compareUtf8Paths(left: string, right: string): number {
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

export function snapshotRuntimeFiles(
  files: readonly { readonly bytes: Uint8Array; readonly path: string }[]
): ReadonlyMap<string, Uint8Array> {
  return new Map(files.map((file) => [file.path, Uint8Array.from(file.bytes)]));
}

export function diffRuntimeFiles(
  before: ReadonlyMap<string, Uint8Array>,
  after: ReadonlyMap<string, Uint8Array>
): RuntimeTerminalFileChange[] {
  const paths = new Set([...before.keys(), ...after.keys()]);
  const created = [...paths]
    .filter((path) => !before.has(path) && after.has(path))
    .sort(compareUtf8Paths);
  const deleted = [...paths]
    .filter((path) => before.has(path) && !after.has(path))
    .sort(compareUtf8Paths);
  const changes: RuntimeTerminalFileChange[] = [];
  const renamedCreations = new Set<string>();
  const renamedDeletions = new Set<string>();
  for (const previousPath of deleted) {
    const previous = before.get(previousPath);
    if (!previous) continue;
    const path = created.find((candidate) => {
      const next = after.get(candidate);
      return !renamedCreations.has(candidate) && Boolean(next && equalBytes(previous, next));
    });
    if (!path) continue;
    renamedCreations.add(path);
    renamedDeletions.add(previousPath);
    changes.push({ kind: "rename", path, previousPath });
  }
  for (const path of [...paths].sort(compareUtf8Paths)) {
    const previous = before.get(path);
    const next = after.get(path);
    if (!previous && next) {
      if (!renamedCreations.has(path)) changes.push({ kind: "create", path });
      continue;
    }
    if (previous && !next) {
      if (!renamedDeletions.has(path)) changes.push({ kind: "delete", path });
      continue;
    }
    if (previous && next && !equalBytes(previous, next)) changes.push({ kind: "content", path });
  }
  return changes;
}

function equalBytes(left: Uint8Array, right: Uint8Array): boolean {
  if (left.byteLength !== right.byteLength) return false;
  return left.every((value, index) => value === right[index]);
}

export function projectRoot(projectId: string): string {
  return `/workspace/projects/${projectId}`;
}

function flattenTemplateTree(tree: FileSystemTree): {
  files: RuntimeWorkspaceFile[];
  text: Map<string, string>;
  totalBytes: number;
} {
  const files: RuntimeWorkspaceFile[] = [];
  const text = new Map<string, string>();
  let totalBytes = 0;

  function visit(entries: FileSystemTree, parent = ""): void {
    for (const [name, entry] of Object.entries(entries)) {
      if (!name || name === "." || name === ".." || name.includes("/") || name.includes("\\")) {
        throw new Error("unsafe template path");
      }
      const path = parent ? `${parent}/${name}` : name;
      if ("directory" in entry) {
        visit(entry.directory, path);
        continue;
      }
      const content = entry.file.contents;
      const sizeBytes = new TextEncoder().encode(content).byteLength;
      if (sizeBytes > MAX_TEMPLATE_FILE_BYTES) throw new Error("template file exceeds limit");
      totalBytes += sizeBytes;
      if (totalBytes > MAX_TEMPLATE_TOTAL_BYTES) throw new Error("template exceeds total limit");
      files.push({ path, name, kind: "text", sizeBytes });
      text.set(path, content);
      if (files.length > MAX_TEMPLATE_FILES) throw new Error("template file count exceeds limit");
    }
  }

  visit(tree);
  if (files.length === 0) throw new Error("template is empty");
  files.sort((left, right) => left.path.localeCompare(right.path));
  return { files, text, totalBytes };
}

export function createRuntimeWorkspace<Owner extends RuntimeWorkspaceOwner>(
  host: RuntimeWorkspaceHost<Owner>
): RuntimeWorkspaceBundle<Owner> {
  let workspaceState = createEmptyWorkspaceState();
  let workspaceText = new Map<string, string>();
  let workspaceRevision = 0;

  function markWorkspaceMutation(): void {
    if (workspaceRevision >= Number.MAX_SAFE_INTEGER) {
      throw new RuntimeAdapterError("RUNTIME_REVISION_EXHAUSTED", "The Local Draft revision limit was reached.");
    }
    workspaceRevision += 1;
  }

  function synchronize(current: Owner): void {
    if (!host.isCurrent(current) || workspaceState.status !== "ready") return;
    const exported = [...current.controller.exportProjectFiles()]
      .sort((left, right) => compareUtf8Paths(left.path, right.path));
    const decoded = decodeRuntimeBundleFiles(exported);
    workspaceText = decoded.text;
    workspaceState = {
      ...workspaceState,
      files: decoded.files.map((file) => ({
        path: file.path,
        name: file.path.split("/").at(-1) ?? file.path,
        kind: file.kind,
        sizeBytes: file.bytes.byteLength
      })),
      totalBytes: decoded.totalBytes
    };
  }

  const workspace: RuntimeWorkspacePort = {
    async materializeTemplate(template) {
      const current = host.requireReady();
      workspaceState = {
        ...createEmptyWorkspaceState(),
        status: "materializing",
        projectId: host.projectId(),
        root: projectRoot(current.projectId)
      };
      try {
        current.controller.loadTemplate(template, { label: current.displayName });
        const materialized = flattenTemplateTree(current.controller.exportTreeJson());
        workspaceText = materialized.text;
        workspaceState = {
          status: "ready",
          projectId: current.projectId,
          root: projectRoot(current.projectId),
          files: materialized.files,
          directories: [],
          totalBytes: materialized.totalBytes,
          errorCode: null
        };
        markWorkspaceMutation();
        return copyWorkspaceState(workspaceState);
      } catch {
        workspaceText = new Map();
        workspaceState = {
          ...createEmptyWorkspaceState(),
          status: "failed",
          projectId: current.projectId,
          root: projectRoot(current.projectId),
          errorCode: "RUNTIME_MATERIALIZATION_FAILED"
        };
        throw new RuntimeAdapterError(
          "RUNTIME_MATERIALIZATION_FAILED",
          "The starter template could not be materialized safely."
        );
      }
    },
    async materializeBundle(files) {
      const current = host.requireReady();
      workspaceState = {
        ...createEmptyWorkspaceState(),
        status: "materializing",
        projectId: host.projectId(),
        root: projectRoot(current.projectId)
      };
      try {
        const decoded = decodeRuntimeBundleFiles(files);
        current.controller.importProjectFiles(decoded.files, current.displayName);
        const exported = current.controller.exportProjectFiles();
        verifyRuntimeBundleRoundTrip(decoded.files, exported);
        workspaceText = decoded.text;
        workspaceState = {
          status: "ready",
          projectId: current.projectId,
          root: projectRoot(current.projectId),
          files: decoded.files.map((file) => ({
            path: file.path,
            name: file.path.split("/").at(-1) ?? file.path,
            kind: file.kind,
            sizeBytes: file.bytes.byteLength
          })),
          directories: [],
          totalBytes: decoded.totalBytes,
          errorCode: null
        };
        markWorkspaceMutation();
        return copyWorkspaceState(workspaceState);
      } catch {
        workspaceText = new Map();
        workspaceState = {
          ...createEmptyWorkspaceState(),
          status: "failed",
          projectId: current.projectId,
          root: projectRoot(current.projectId),
          errorCode: "RUNTIME_MATERIALIZATION_FAILED"
        };
        throw new RuntimeAdapterError(
          "RUNTIME_MATERIALIZATION_FAILED",
          "The saved Project could not be materialized safely."
        );
      }
    },
    getState() { return copyWorkspaceState(workspaceState); },
    exportBundleFiles() {
      const current = host.requireReady();
      return current.controller.exportProjectFiles();
    },
    snapshotBundleFiles() {
      return { revision: workspaceRevision, files: workspace.exportBundleFiles() };
    },
    currentRevision() { return workspaceRevision; },
    readText(path) {
      host.requireReady();
      const content = workspaceText.get(path);
      if (content === undefined) throw new RuntimeAdapterError("RUNTIME_FILE_UNAVAILABLE", "The selected text file is unavailable.");
      return content;
    },
    createText(path, content = "") {
      const current = host.requireReady();
      if (host.localDraftAccess() !== "writer") throw new RuntimeAdapterError("ELEASEHELD", "Another tab owns this Local Draft writer lease.");
      const sizeBytes = new TextEncoder().encode(content).byteLength;
      if (
        workspaceState.status !== "ready"
        || !isSafeRuntimeBundlePath(path)
        || workspaceState.files.some((file) => file.path === path)
        || workspaceState.files.length >= MAX_TEMPLATE_FILES
        || sizeBytes > MAX_TEMPLATE_FILE_BYTES
        || workspaceState.totalBytes + sizeBytes > MAX_TEMPLATE_TOTAL_BYTES
      ) throw new RuntimeAdapterError("RUNTIME_FILE_CREATE_FAILED", "The Project file could not be created safely.");
      try {
        const snapshot = current.controller.createTextFile(path, content);
        workspaceText.set(path, content);
        workspaceState = {
          ...workspaceState,
          totalBytes: workspaceState.totalBytes + sizeBytes,
          files: [...workspaceState.files, { path, name: path.split("/").at(-1) ?? path, kind: "text" as const, sizeBytes }]
            .sort((left, right) => left.path.localeCompare(right.path))
        };
        markWorkspaceMutation();
        host.applySnapshot(current, snapshot);
        return host.publicState();
      } catch {
        throw new RuntimeAdapterError("RUNTIME_FILE_CREATE_FAILED", "The Project file could not be created safely.");
      }
    },
    createDirectory(path) {
      const current = host.requireReady();
      if (host.localDraftAccess() !== "writer") throw new RuntimeAdapterError("ELEASEHELD", "Another tab owns this Local Draft writer lease.");
      if (workspaceState.status !== "ready" || !isSafeRuntimeBundlePath(path) || workspaceState.files.some((file) => file.path === path)) {
        throw new RuntimeAdapterError("RUNTIME_FILE_CREATE_FAILED", "The Project directory could not be created safely.");
      }
      try {
        const snapshot = current.controller.createDirectory(path);
        workspaceState = {
          ...workspaceState,
          directories: workspaceState.directories.includes(path)
            ? workspaceState.directories
            : [...workspaceState.directories, path].sort()
        };
        markWorkspaceMutation();
        host.applySnapshot(current, snapshot);
        return host.publicState();
      } catch {
        throw new RuntimeAdapterError("RUNTIME_FILE_CREATE_FAILED", "The Project directory could not be created safely.");
      }
    },
    movePath(from, to) {
      const current = host.requireReady();
      if (host.localDraftAccess() !== "writer") throw new RuntimeAdapterError("ELEASEHELD", "Another tab owns this Local Draft writer lease.");
      if (workspaceState.status !== "ready" || !isSafeRuntimeBundlePath(from) || !isSafeRuntimeBundlePath(to) || from === to || to.startsWith(`${from}/`)) {
        throw new RuntimeAdapterError("RUNTIME_FILE_RENAME_FAILED", "The Project path could not be moved safely.");
      }
      try {
        const snapshot = current.controller.movePath(from, to);
        const rewrite = (path: string) => path === from || path.startsWith(`${from}/`) ? `${to}${path.slice(from.length)}` : path;
        const nextText = new Map<string, string>();
        for (const [path, content] of workspaceText) nextText.set(rewrite(path), content);
        workspaceText = nextText;
        workspaceState = {
          ...workspaceState,
          files: workspaceState.files
            .map((file) => {
              const path = rewrite(file.path);
              return path === file.path ? file : { ...file, path, name: path.split("/").at(-1) ?? path };
            })
            .sort((left, right) => left.path.localeCompare(right.path)),
          directories: [...new Set(workspaceState.directories.map(rewrite))].sort()
        };
        markWorkspaceMutation();
        host.applySnapshot(current, snapshot);
        return host.publicState();
      } catch {
        throw new RuntimeAdapterError("RUNTIME_FILE_RENAME_FAILED", "The Project path could not be moved safely.");
      }
    },
    renameText(from, to) {
      const current = host.requireReady();
      if (host.localDraftAccess() !== "writer") throw new RuntimeAdapterError("ELEASEHELD", "Another tab owns this Local Draft writer lease.");
      const content = workspaceText.get(from);
      if (
        workspaceState.status !== "ready"
        || content === undefined
        || !isSafeRuntimeBundlePath(to)
        || workspaceState.files.some((file) => file.path === to)
      ) throw new RuntimeAdapterError("RUNTIME_FILE_RENAME_FAILED", "The Project file could not be renamed safely.");
      try {
        const snapshot = current.controller.renameFile(from, to);
        workspaceText.delete(from);
        workspaceText.set(to, content);
        workspaceState = {
          ...workspaceState,
          files: workspaceState.files
            .map((file) => file.path === from ? { ...file, path: to, name: to.split("/").at(-1) ?? to } : file)
            .sort((left, right) => left.path.localeCompare(right.path))
        };
        markWorkspaceMutation();
        host.applySnapshot(current, snapshot);
        return host.publicState();
      } catch {
        throw new RuntimeAdapterError("RUNTIME_FILE_RENAME_FAILED", "The Project file could not be renamed safely.");
      }
    },
    deleteText(path) {
      const current = host.requireReady();
      if (host.localDraftAccess() !== "writer") throw new RuntimeAdapterError("ELEASEHELD", "Another tab owns this Local Draft writer lease.");
      const content = workspaceText.get(path);
      const file = workspaceState.files.find((candidate) => candidate.path === path);
      if (workspaceState.status !== "ready" || content === undefined || file?.kind !== "text") {
        throw new RuntimeAdapterError("RUNTIME_FILE_DELETE_FAILED", "The Project file could not be deleted safely.");
      }
      try {
        const snapshot = current.controller.deleteFile(path);
        workspaceText.delete(path);
        workspaceState = {
          ...workspaceState,
          totalBytes: workspaceState.totalBytes - file.sizeBytes,
          files: workspaceState.files.filter((candidate) => candidate.path !== path)
        };
        markWorkspaceMutation();
        host.applySnapshot(current, snapshot);
        return host.publicState();
      } catch {
        throw new RuntimeAdapterError("RUNTIME_FILE_DELETE_FAILED", "The Project file could not be deleted safely.");
      }
    },
    deletePath(path) {
      const current = host.requireReady();
      if (host.localDraftAccess() !== "writer") throw new RuntimeAdapterError("ELEASEHELD", "Another tab owns this Local Draft writer lease.");
      const matches = (candidate: string) => candidate === path || candidate.startsWith(`${path}/`);
      const removing = workspaceState.status === "ready" ? workspaceState.files.filter((file) => matches(file.path)) : [];
      const removingDirectory = workspaceState.status === "ready" && workspaceState.directories.some(matches);
      if (workspaceState.status !== "ready" || !isSafeRuntimeBundlePath(path) || (removing.length === 0 && !removingDirectory)) {
        throw new RuntimeAdapterError("RUNTIME_FILE_DELETE_FAILED", "The Project path could not be deleted safely.");
      }
      try {
        const snapshot = current.controller.deletePath(path);
        for (const file of removing) workspaceText.delete(file.path);
        workspaceState = {
          ...workspaceState,
          totalBytes: workspaceState.totalBytes - removing.reduce((total, file) => total + file.sizeBytes, 0),
          files: workspaceState.files.filter((file) => !matches(file.path)),
          directories: workspaceState.directories.filter((directory) => !matches(directory))
        };
        markWorkspaceMutation();
        host.applySnapshot(current, snapshot);
        return host.publicState();
      } catch {
        throw new RuntimeAdapterError("RUNTIME_FILE_DELETE_FAILED", "The Project path could not be deleted safely.");
      }
    },
    writeText(path, content) {
      const current = host.requireReady();
      if (host.localDraftAccess() !== "writer") {
        throw new RuntimeAdapterError("ELEASEHELD", "Another tab owns this Local Draft writer lease.");
      }
      const previous = workspaceText.get(path);
      if (workspaceState.status !== "ready" || previous === undefined) {
        throw new RuntimeAdapterError("RUNTIME_FILE_UNAVAILABLE", "The selected text file is unavailable.");
      }
      const sizeBytes = new TextEncoder().encode(content).byteLength;
      const previousBytes = new TextEncoder().encode(previous).byteLength;
      const nextTotal = workspaceState.totalBytes - previousBytes + sizeBytes;
      if (sizeBytes > MAX_TEMPLATE_FILE_BYTES || nextTotal > MAX_TEMPLATE_TOTAL_BYTES) {
        throw new RuntimeAdapterError("RUNTIME_EDIT_LIMIT_EXCEEDED", "The text edit exceeds the Local Draft limit.");
      }
      try {
        const snapshot = current.controller.saveTextFile(path, content);
        workspaceText.set(path, content);
        workspaceState = {
          ...workspaceState,
          totalBytes: nextTotal,
          files: workspaceState.files.map((file) => file.path === path ? { ...file, sizeBytes } : file)
        };
        markWorkspaceMutation();
        host.applySnapshot(current, snapshot);
        return host.publicState();
      } catch {
        throw new RuntimeAdapterError("RUNTIME_EDIT_FAILED", "The text edit could not be saved safely.");
      }
    }
  };

  return {
    port: workspace,
    markMutation: markWorkspaceMutation,
    synchronize,
    reset() {
      workspaceState = createEmptyWorkspaceState();
      workspaceText = new Map();
      workspaceRevision = 0;
    }
  };
}
