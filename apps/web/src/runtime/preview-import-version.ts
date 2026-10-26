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

export function previewModuleRefreshPath(paths: readonly string[]): string {
  for (const candidate of ["src/main.tsx", "src/main.jsx", "src/main.ts", "src/main.js", "src/App.tsx", "src/App.jsx"]) {
    if (paths.includes(candidate)) return candidate;
  }
  return "package.json";
}
