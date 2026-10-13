import type { ProjectWorkspaceEditorSaveEvent } from "./editor-bridge.ts";

export interface ProjectWorkspaceSourceEditTarget<Result = unknown> {
  applySourceEdit(path: string, data: string): Result;
}

export interface ProjectWorkspaceSourceEditBridgeOptions {
  root?: string;
}

export type ProjectWorkspaceSourceEditBridge<Result = unknown> = (
  event: ProjectWorkspaceEditorSaveEvent
) => Result;

export function createProjectWorkspaceSourceEditBridge<Result = unknown>(
  target: ProjectWorkspaceSourceEditTarget<Result>,
  options: ProjectWorkspaceSourceEditBridgeOptions = {}
): ProjectWorkspaceSourceEditBridge<Result> {
  return (event) => target.applySourceEdit(relativeSourcePath(event, options.root), event.data);
}

function relativeSourcePath(event: ProjectWorkspaceEditorSaveEvent, root?: string): string {
  if (!root) return event.relativePath;
  const normalizedRoot = root.replaceAll("\\", "/").replace(/\/+$/, "");
  const normalizedPath = event.path.replaceAll("\\", "/");
  if (!normalizedPath.startsWith(`${normalizedRoot}/`)) return event.relativePath;
  return normalizedPath.slice(normalizedRoot.length).replace(/^\/+/, "");
}
