import type { NuriteoFileSystemAdapter } from "@nuriteo/sdk";

import { workspacePath } from "./memory-filesystem.ts";
import type { ContainerCaseFile, ContainerCaseKind } from "./types.ts";

export const REPLACED_ENTRY = "replaced-entry\n";
export const MISSING_PATH = "/workspace/missing.txt";

const SCRIPT_SRC = /<script\b[^>]*\bsrc="([^"]+)"[^>]*>/i;

export function publishedExamplePath(kind: ContainerCaseKind, filePath: string): string {
  return `examples/${kind}/${filePath}`;
}

export function scriptSrcFromHtml(html: string): string | null {
  const match = SCRIPT_SRC.exec(html);
  const src = match?.[1];
  if (!src) return null;
  return src.replace(/^\/+/, "");
}

export function filesWithPrefix(files: readonly ContainerCaseFile[], prefix: string): ContainerCaseFile[] {
  const directory = prefix.endsWith("/") ? prefix : `${prefix}/`;
  return files.filter((file) => file.path.startsWith(directory));
}

export function caseDirectory(kind: ContainerCaseKind): string {
  if (kind === "spa") return "src/";
  return "app/";
}

export async function writeFilesInOrder(
  filesystem: NuriteoFileSystemAdapter,
  files: readonly ContainerCaseFile[]
): Promise<string[]> {
  const written: string[] = [];
  for (const file of files) {
    const path = workspacePath(file.path);
    await filesystem.writeFile(path, file.contents);
    written.push(path);
  }
  return written;
}

export async function readText(filesystem: NuriteoFileSystemAdapter, path: string): Promise<string> {
  const read = await filesystem.readFile(path);
  return typeof read === "string" ? read : new TextDecoder().decode(read);
}
