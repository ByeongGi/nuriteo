import { createContainer, type Nuriteo, type NuriteoFileEntry, type NuriteoFileSystemAdapter } from "@nuriteo/sdk";

import { loadSdkRuntime } from "../run-sdk-example.ts";
import { loadContainerCase } from "./load-case.ts";
import {
  caseDirectory,
  filesWithPrefix,
  MISSING_PATH,
  publishedExamplePath,
  readText,
  REPLACED_ENTRY,
  scriptSrcFromHtml,
  writeFilesInOrder
} from "./load-patterns.ts";
import { memoryFilesystem, workspacePath } from "./memory-filesystem.ts";
import { MOUNT_CASE_BOOT_MS } from "./mount-source.ts";
import type { ContainerCase, ContainerCaseFile, ContainerCaseKind } from "./types.ts";

export const loadActions = ["all", "each", "fetch", "replace", "script", "prefix", "missing"] as const;

export type LoadAction = (typeof loadActions)[number];

export type CaseAction = LoadAction | "editor";

export interface OpenedCaseFile {
  path: string;
  text: string;
}

export interface ContainerCaseMount {
  action: CaseAction;
  protocolVersion: number;
  status: string;
  kind: ContainerCaseKind;
  previewScript: string | null;
  entryPath: string;
  entry: string;
  written: readonly string[];
  listing: readonly NuriteoFileEntry[];
  rejectedPath: string | null;
  openedFiles: readonly OpenedCaseFile[] | null;
}

interface LoadPlan {
  filesystem: NuriteoFileSystemAdapter;
  written: readonly string[];
  entryPath: string;
}

export async function runLoadAction(input: {
  kind: ContainerCaseKind;
  action: LoadAction;
  filePath: string;
}): Promise<ContainerCaseMount> {
  const project = await loadContainerCase(input.kind);
  const runtime = await loadSdkRuntime();
  const plan = await planLoad(project, input.action, input.filePath);
  const container = createContainer({
    ...runtime,
    services: { filesystem: plan.filesystem }
  });
  try {
    const ready = await container.boot({ timeoutMs: MOUNT_CASE_BOOT_MS });
    const rejectedPath = await rejectedMissingPath(container, input.action);
    const entry = await readText(container.services.fs, plan.entryPath);
    const listing = await container.services.fs.readdir("/workspace");
    const status = container.status;
    return {
      action: input.action,
      protocolVersion: ready.protocolVersion,
      status,
      kind: project.kind,
      previewScript: project.previewScript,
      entryPath: plan.entryPath,
      entry,
      written: plan.written,
      listing,
      rejectedPath,
      openedFiles: null
    };
  } finally {
    await container.teardown();
  }
}

export async function mountEditorDraft(input: {
  kind: ContainerCaseKind;
  files: readonly ContainerCaseFile[];
  readPath: string;
}): Promise<ContainerCaseMount> {
  const project = await loadContainerCase(input.kind);
  const runtime = await loadSdkRuntime();
  const entryPath = workspacePath(input.readPath);
  const plan = mappedPlan(input.files, entryPath);
  const container = createContainer({
    ...runtime,
    services: { filesystem: plan.filesystem }
  });
  try {
    const ready = await container.boot({ timeoutMs: MOUNT_CASE_BOOT_MS });
    const openedFiles: OpenedCaseFile[] = [];
    for (const file of input.files) {
      openedFiles.push({
        path: file.path,
        text: await readText(container.services.fs, workspacePath(file.path))
      });
    }
    const entry = openedFiles.find((file) => file.path === input.readPath)?.text ?? "";
    const listing = await container.services.fs.readdir("/workspace");
    const status = container.status;
    return {
      action: "editor",
      protocolVersion: ready.protocolVersion,
      status,
      kind: project.kind,
      previewScript: project.previewScript,
      entryPath,
      entry,
      written: plan.written,
      listing,
      rejectedPath: null,
      openedFiles
    };
  } finally {
    await container.teardown();
  }
}

async function planLoad(project: ContainerCase, action: LoadAction, filePath: string): Promise<LoadPlan> {
  const entryPath = workspacePath(project.entry);
  switch (action) {
    case "all":
      return mappedPlan(project.files, entryPath);
    case "each":
      return orderedPlan(project.files, entryPath);
    case "fetch":
      return orderedPlan([await fetchPublishedFile(project.kind, filePath)], workspacePath(filePath));
    case "replace":
      return replacePlan(project.files, entryPath);
    case "script":
      return scriptPlan(project);
    case "prefix":
      return orderedPlan(filesWithPrefix(project.files, caseDirectory(project.kind)), entryPath);
    case "missing":
      return mappedPlan(project.files, entryPath);
    default: {
      const exhaustive: never = action;
      return exhaustive;
    }
  }
}

function mappedPlan(caseFiles: readonly ContainerCaseFile[], entryPath: string): LoadPlan {
  const files = new Map(caseFiles.map((file) => [workspacePath(file.path), file.contents]));
  return {
    filesystem: memoryFilesystem(files),
    written: caseFiles.map((file) => workspacePath(file.path)),
    entryPath
  };
}

async function orderedPlan(caseFiles: readonly ContainerCaseFile[], entryPath: string): Promise<LoadPlan> {
  const files = new Map<string, string>();
  const filesystem = memoryFilesystem(files);
  const written = await writeFilesInOrder(filesystem, caseFiles);
  return { filesystem, written, entryPath };
}

async function replacePlan(caseFiles: readonly ContainerCaseFile[], entryPath: string): Promise<LoadPlan> {
  const plan = mappedPlan(caseFiles, entryPath);
  await plan.filesystem.writeFile(entryPath, REPLACED_ENTRY);
  return plan;
}

function scriptPlan(project: ContainerCase): Promise<LoadPlan> {
  const html = project.files.find((file) => file.path === "index.html");
  const scriptPath = html ? scriptSrcFromHtml(html.contents) : null;
  const script = project.files.find((file) => file.path === scriptPath);
  if (!html || !script) throw new Error("index.html");
  return orderedPlan([html, script], workspacePath(script.path));
}

async function fetchPublishedFile(kind: ContainerCaseKind, filePath: string): Promise<ContainerCaseFile> {
  const url = new URL(publishedExamplePath(kind, filePath), new URL(import.meta.env.BASE_URL, location.origin));
  const response = await fetch(url);
  if (!response.ok) throw new Error(url.href);
  return { path: filePath, contents: await response.text() };
}

async function rejectedMissingPath(container: Nuriteo, action: LoadAction): Promise<string | null> {
  if (action !== "missing") return null;
  try {
    await container.services.fs.readFile(MISSING_PATH);
  } catch (error) {
    if (error instanceof Error) return error.message;
    throw error;
  }
  throw new Error(MISSING_PATH);
}
