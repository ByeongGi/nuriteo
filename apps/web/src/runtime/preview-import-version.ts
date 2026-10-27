export function versionPreviewImportSpecifier(specifier: string, version: string | undefined): string {
  if (!version || specifier.includes("nuriteo_hmr=")) return specifier;
  if (specifier.startsWith("/node_modules/")) {
    const hashIndex = specifier.indexOf("#");
    const withoutHash = hashIndex >= 0 ? specifier.slice(0, hashIndex) : specifier;
    const hash = hashIndex >= 0 ? specifier.slice(hashIndex) : "";
    const joiner = withoutHash.includes("?") ? "&" : "?";
    return `${withoutHash}${joiner}nuriteo_hmr=${encodeURIComponent(version)}${hash}`;
  }
  if ((specifier.startsWith("./") || specifier.startsWith("../")) && !specifier.includes("?")) {
    return `${specifier}?nuriteo_hmr=${encodeURIComponent(version)}`;
  }
  return specifier;
}

const PREVIEW_ENTRY_CANDIDATES = [
  "src/main.tsx",
  "src/main.jsx",
  "src/main.ts",
  "src/main.js",
  "src/App.tsx",
  "src/App.jsx",
  "app/page.tsx",
  "app/page.jsx",
  "app/page.js",
  "pages/index.tsx",
  "pages/index.jsx",
  "pages/index.js",
  "app/layout.tsx",
  "app/layout.jsx",
  "app/layout.js"
];

export function previewModuleRefreshPath(paths: readonly string[]): string {
  for (const candidate of PREVIEW_ENTRY_CANDIDATES) {
    if (paths.includes(candidate)) return candidate;
  }
  return paths.find((path) => isPreviewSourceModule(path)) ?? "src/main.tsx";
}

function isPreviewSourceModule(path: string): boolean {
  return !path.split("/").some((segment) => segment === "node_modules" || segment === ".pnpm-store")
    && /\.(?:css|[cm]?[jt]sx?)$/iu.test(path);
}
