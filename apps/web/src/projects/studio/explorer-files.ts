const HIDDEN_INSTALL_DIRECTORIES = new Set(["node_modules", ".pnpm-store"]);

export function isInstalledDependencyPath(path: string): boolean {
  return path.split("/").some((segment) => HIDDEN_INSTALL_DIRECTORIES.has(segment));
}

export function visibleStudioExplorerFiles<T extends { readonly path: string }>(files: readonly T[]): T[] {
  return files.filter((file) => !isInstalledDependencyPath(file.path));
}
