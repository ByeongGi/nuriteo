export function displayPath(path: string): string {
  return path.replace(/^\/workspace\/[^/]+\//, "");
}

export function pickFirstFile(snapshot: PreviewWorkflowSnapshot): string | null {
  const files = snapshot.project?.listFiles() || [];
  const preferred =
    files.find((file) => /main\.(jsx|tsx|js|ts)$/.test(file.path)) ||
    files.find((file) => /page\.(jsx|tsx|js|ts)$/.test(file.path)) ||
    files.find((file) => file.path.endsWith("package.json")) ||
    files[0];
  return preferred?.path ?? null;
}

export function resolveProjectFile(snapshot: PreviewWorkflowSnapshot, relativeOrAbs: string): string | null {
  const files = snapshot.project?.listFiles() || [];
  if (files.length === 0) return null;
  const needle = relativeOrAbs.replace(/^\.\//, "").replace(/^\/+/, "");
  const exact = files.find(
    (file) => file.path === relativeOrAbs || file.path.endsWith(`/${needle}`) || displayPath(file.path) === needle
  );
  return exact?.path ?? null;
}

export function basename(path: string): string {
  const parts = path.split("/").filter(Boolean);
  return parts.at(-1) || path;
}

export function isDescendantPath(parent: string, child: string): boolean {
  const prefix = parent.endsWith("/") ? parent : `${parent}/`;
  return child === parent || child.startsWith(prefix);
}

export function parentDir(path: string): string {
  const index = path.lastIndexOf("/");
  return index <= 0 ? path : path.slice(0, index);
}

export function joinPath(root: string, relative: string): string {
  const cleaned = relative.replace(/^\/+/, "").replaceAll("\\", "/");
  return `${root.replace(/\/+$/, "")}/${cleaned}`.replace(/\/+/g, "/");
}

export function portFromSnapshot(snapshot: PreviewWorkflowSnapshot): number {
  return snapshot.session?.port || 5173;
}

export function simpleGlobMatch(path: string, glob: string): boolean {
  const patterns = glob
    .split(",")
    .map((part) => part.trim())
    .filter(Boolean);
  if (patterns.length === 0) return true;
  return patterns.some((pattern) => {
    const escaped = pattern
      .replace(/[.+^${}()|[\]\\]/g, "\\$&")
      .replace(/\*\*/g, ":::DOUBLE_STAR:::")
      .replace(/\*/g, "[^/]*")
      .replace(/:::DOUBLE_STAR:::/g, ".*")
      .replace(/\?/g, ".");
    return new RegExp(`^${escaped}$`).test(path);
  });
}

export function buildPreviewUrl(basePreviewUrl: string, path: string): string {
  try {
    const url = new URL(basePreviewUrl, window.location.origin);
    const marker = "/__preview/";
    const index = url.pathname.indexOf(marker);
    if (index < 0) return basePreviewUrl;
    const parts = url.pathname.slice(index + marker.length).split("/");
    const projectId = parts[0] || "preview-service";
    const port = parts[1] || "5173";
    const normalized = path.startsWith("/") ? path : `/${path}`;
    url.pathname = `${marker}${projectId}/${port}${normalized === "/" ? "/" : normalized}`;
    return `${url.pathname}${url.search}`;
  } catch {
    return basePreviewUrl;
  }
}
