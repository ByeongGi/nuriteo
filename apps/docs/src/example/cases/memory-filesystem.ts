import type { NuriteoFileEntry, NuriteoFileSystemAdapter } from "@nuriteo/sdk";

export function workspacePath(relativePath: string): string {
  return `/workspace/${relativePath.replace(/^\/+/, "")}`;
}

export function listWorkspace(files: ReadonlyMap<string, string>, directory: string): NuriteoFileEntry[] {
  const prefix = directory.endsWith("/") ? directory : `${directory}/`;
  const seen = new Map<string, NuriteoFileEntry>();
  for (const filePath of files.keys()) {
    if (!filePath.startsWith(prefix)) continue;
    const rest = filePath.slice(prefix.length);
    const slash = rest.indexOf("/");
    const name = slash === -1 ? rest : rest.slice(0, slash);
    if (name.length === 0) continue;
    const path = `${prefix}${name}`;
    const type = slash === -1 ? "file" : "directory";
    const existing = seen.get(path);
    const directoryWins = existing?.type === "file" && type === "directory";
    if (!existing || directoryWins) seen.set(path, { path, type });
  }
  return [...seen.values()].sort((left, right) => left.path.localeCompare(right.path));
}

export function memoryFilesystem(files: Map<string, string>): NuriteoFileSystemAdapter {
  return {
    async readFile(path) {
      const value = files.get(path);
      if (value === undefined) throw new Error(path);
      return value;
    },
    async writeFile(path, data) {
      files.set(path, typeof data === "string" ? data : new TextDecoder().decode(data));
    },
    async readdir(path) {
      return listWorkspace(files, path);
    }
  };
}
