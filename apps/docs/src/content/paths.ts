export function pageHref(path: string): string {
  if (path === "/" || path.endsWith("/")) return path;
  return `${path}/`;
}

export function normalizePath(pathname: string): string {
  if (pathname.length > 1 && pathname.endsWith("/")) return pathname.slice(0, -1);
  return pathname;
}
