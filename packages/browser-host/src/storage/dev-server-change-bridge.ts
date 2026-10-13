import type {
  ProjectWorkspaceEditorChangeEvent,
  ProjectWorkspaceEditorChangeKind
} from "./editor-bridge.ts";

export type ProjectWorkspaceDevServerChangeKind =
  | "ignored"
  | "source-create"
  | "source-delete"
  | "source-rename"
  | "source-save";

export interface ProjectWorkspaceDevServerDiagnostic {
  code: "EDEVSERVER_SOURCE_DELETED" | "EDEVSERVER_SOURCE_RENAMED";
  file: string;
  message: string;
  previousPath?: string;
  recoveryCommand: string;
  severity: "warning";
  source: "editor";
}

export interface ProjectWorkspaceDevServerChangeResult<Result = unknown> {
  diagnostic?: ProjectWorkspaceDevServerDiagnostic;
  hmrResult?: Result;
  kind: ProjectWorkspaceDevServerChangeKind;
  path: string;
  previousPath?: string;
  relativePath: string;
}

export interface ProjectWorkspaceDevServerChangeBridgeOptions {
  onDiagnostic?: (diagnostic: ProjectWorkspaceDevServerDiagnostic) => void;
  root?: string;
  sourcePattern?: RegExp;
}

export interface ProjectWorkspaceDevServerChangeTarget<Result = unknown> {
  applySourceEdit(path: string, data: string): Result;
}

export type ProjectWorkspaceDevServerChangeBridge<Result = unknown> = (
  event: ProjectWorkspaceEditorChangeEvent
) => ProjectWorkspaceDevServerChangeResult<Result>;

export function createProjectWorkspaceDevServerChangeBridge<Result = unknown>(
  target: ProjectWorkspaceDevServerChangeTarget<Result>,
  options: ProjectWorkspaceDevServerChangeBridgeOptions = {}
): ProjectWorkspaceDevServerChangeBridge<Result> {
  const sourcePattern = options.sourcePattern || /^src\/.+\.(c|m)?(j|t)sx?$/;
  return (event) => {
    const relativePath = relativeSourcePath(event, options.root);
    const base = {
      path: event.path,
      ...(event.previousPath ? { previousPath: event.previousPath } : {}),
      relativePath
    };
    if (!sourcePattern.test(relativePath)) return { ...base, kind: "ignored" };
    if ((event.kind === "save" || event.kind === "create") && event.data !== undefined) {
      const kind = event.kind === "save" ? "source-save" : "source-create";
      return { ...base, kind, hmrResult: target.applySourceEdit(relativePath, event.data) };
    }
    if (event.kind === "rename" || event.kind === "delete") {
      const diagnostic = diagnosticFor(event.kind, event.path, event.previousPath);
      options.onDiagnostic?.(diagnostic);
      return {
        ...base,
        diagnostic,
        kind: event.kind === "rename" ? "source-rename" : "source-delete"
      };
    }
    return { ...base, kind: "ignored" };
  };
}

function diagnosticFor(
  kind: Extract<ProjectWorkspaceEditorChangeKind, "delete" | "rename">,
  path: string,
  previousPath?: string
): ProjectWorkspaceDevServerDiagnostic {
  const action = kind === "rename" ? "renamed" : "deleted";
  return {
    code: kind === "rename" ? "EDEVSERVER_SOURCE_RENAMED" : "EDEVSERVER_SOURCE_DELETED",
    file: path,
    message: `Source file ${action}; rebuild preview or update imports if HMR cannot recover.`,
    ...(previousPath ? { previousPath } : {}),
    recoveryCommand: "vite build",
    severity: "warning",
    source: "editor"
  };
}

function relativeSourcePath(event: ProjectWorkspaceEditorChangeEvent, root?: string): string {
  if (!root) return event.relativePath;
  const normalizedRoot = root.replaceAll("\\", "/").replace(/\/+$/, "");
  const normalizedPath = event.path.replaceAll("\\", "/");
  if (!normalizedPath.startsWith(`${normalizedRoot}/`)) return event.relativePath;
  return normalizedPath.slice(normalizedRoot.length).replace(/^\/+/, "");
}
