import { createProjectWorkspaceStore, type ProjectWorkspaceStore } from "../storage/project-workspace.ts";
import { createProjectHealthCheck, type ProjectHealthReport } from "./health-check.ts";
import { getProjectTemplate, type TemplateId } from "./templates.ts";
import { importPublicGitHubRepo, type GitHubImportOptions } from "./github-import.ts";
import { exportProjectZip, importProjectZip, type ZipProjectFile } from "./zip-adapter.ts";
import type { PackageScriptDetection, SupportedPackageManager } from "./package-detect.ts";

export interface MaterializedProject {
  store: ProjectWorkspaceStore;
  files: ZipProjectFile[];
  health: ProjectHealthReport;
  source: "template" | "zip" | "github" | "snapshot";
}

export interface MaterializeOptions {
  projectId?: string;
  root?: string;
  overrides?: PackageScriptDetection["overrides"];
  defaultPackageManager?: SupportedPackageManager;
}

export function materializeTemplate(
  templateId: TemplateId,
  options: MaterializeOptions = {}
): MaterializedProject {
  const template = getProjectTemplate(templateId);
  return materializeFiles(template.files, {
    ...options,
    source: "template",
    metadata: {
      framework: template.framework,
      name: template.name,
      packageManager: template.packageManager,
      templateId: template.id
    },
    defaultPackageManager: options.defaultPackageManager || template.packageManager
  });
}

export function materializeZip(
  bytes: Uint8Array | ArrayBuffer,
  options: MaterializeOptions = {}
): MaterializedProject {
  const imported = importProjectZip(bytes);
  if (imported.diagnostics.some((entry) => entry.level === "error")) {
    const store = createEmptyStore(options);
    const health = createProjectHealthCheck({
      files: [],
      ...(options.overrides ? { overrides: options.overrides } : {})
    });
    health.diagnostics.unshift(...imported.diagnostics);
    health.ok = false;
    return { store, files: [], health, source: "zip" };
  }
  return materializeFiles(imported.files, {
    ...options,
    source: "zip",
    metadata: {
      name: "Imported zip project"
    }
  });
}

export async function materializeGitHubUrl(
  url: string,
  options: MaterializeOptions & GitHubImportOptions = {}
): Promise<MaterializedProject> {
  const imported = await importPublicGitHubRepo(url, options);
  if (imported.diagnostics.some((entry) => entry.level === "error")) {
    const store = createEmptyStore(options);
    const health = createProjectHealthCheck({
      files: [],
      ...(options.overrides ? { overrides: options.overrides } : {})
    });
    health.diagnostics.unshift(...imported.diagnostics);
    health.ok = false;
    return { store, files: [], health, source: "github" };
  }
  return materializeFiles(imported.files, {
    ...options,
    source: "github",
    metadata: {
      name: "Imported GitHub project",
      sourceUrl: url
    }
  });
}

export function exportMaterializedProjectZip(store: ProjectWorkspaceStore, rootDirectory?: string): Uint8Array {
  return exportProjectZip({
    ...(rootDirectory ? { rootDirectory } : {}),
    files: store.listFiles().map((file) => ({
      path: relativeToRoot(file.path, store.root),
      data: file.data
    }))
  });
}

function materializeFiles(
  files: ZipProjectFile[],
  options: MaterializeOptions & {
    source: MaterializedProject["source"];
    metadata?: Record<string, string>;
  }
): MaterializedProject {
  const projectId = options.projectId || `project-${options.source}`;
  const root = options.root || "/workspace/app";
  const store = createProjectWorkspaceStore({
    projectId,
    root,
    metadata: options.metadata || {}
  });
  for (const file of files) {
    store.writeText(joinRoot(root, file.path), file.data);
  }
  const health = createProjectHealthCheck({
    files,
    ...(options.overrides ? { overrides: options.overrides } : {}),
    ...(options.defaultPackageManager ? { defaultPackageManager: options.defaultPackageManager } : {})
  });
  return {
    store,
    files,
    health,
    source: options.source
  };
}

function createEmptyStore(options: MaterializeOptions): ProjectWorkspaceStore {
  return createProjectWorkspaceStore({
    projectId: options.projectId || "project-empty",
    root: options.root || "/workspace/app",
    metadata: {}
  });
}

function joinRoot(root: string, relative: string): string {
  const clean = relative.replace(/^\/+/, "");
  return `${root.replace(/\/+$/, "")}/${clean}`;
}

function relativeToRoot(path: string, root: string): string {
  const normalizedRoot = root.replace(/\/+$/, "");
  if (path === normalizedRoot) return "";
  if (path.startsWith(`${normalizedRoot}/`)) return path.slice(normalizedRoot.length + 1);
  return path.replace(/^\/+/, "");
}
