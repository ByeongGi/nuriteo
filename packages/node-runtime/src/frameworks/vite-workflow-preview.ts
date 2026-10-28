import { join } from "../builtins/path.ts";


import type { ViteProductCliHmrRegistration, ViteProductCliHmrSendUpdate, ViteProductCliTransformRegistration, ViteProductCliTransformRequest } from "./vite-workflow-types.ts";
import { transpileTypeScript } from "../transforms/typescript.ts";

export interface PreviewModuleContext {
  importerPath: string;
  projectRoot: string;
  workspace: { exists(path: string): boolean; isFile?(path: string): boolean; readText(path: string): string };
}

export function transformViteModuleSource(
  path: string,
  source: string,
  moduleTransformSource: "adapter" | "vite-cli" | string = "adapter",
  resolveSpecifier?: (specifier: string) => string | undefined,
  context?: PreviewModuleContext
): string {
  if (!/\.(?:[cm]?jsx?|tsx?)$/.test(path)) return source;
  const finish = (value: string) => applyPreviewCommonJs(path, value, context);
  if (moduleTransformSource === "vite-cli") {
    return finish(rewriteBrowserModuleImports(`// transformed by vite-cli\n${source}`, resolveSpecifier));
  }
  const rewrite = (value: string) => rewriteBrowserModuleImports(value, resolveSpecifier);
  // Adapter preview path: emit browser-runnable ESM for TS/JSX so React/Vite edits show up.
  if (/\.(?:[cm]?tsx?|jsx)$/.test(path)) {
    try {
      const result = transpileTypeScript(source, {
        fileName: path,
        jsx: /\.(?:jsx|tsx)$/.test(path) ? "react-jsx" : "react"
      });
      return finish(rewrite(result.code));
    } catch {
      return finish(rewrite(source));
    }
  }
  return finish(rewrite(source));
}

export function previewExportTarget(manifest: { exports?: unknown }, subpath: string): string | undefined {
  const exportsField = manifest.exports;
  if (typeof exportsField === "string") return subpath === "." ? exportsField : undefined;
  if (!exportsField || typeof exportsField !== "object" || Array.isArray(exportsField)) return undefined;
  const record = exportsField as Record<string, unknown>;
  if (Object.prototype.hasOwnProperty.call(record, subpath)) return unwrapExportCondition(record[subpath]);
  if (isConditionalExportMap(record)) return subpath === "." ? unwrapExportCondition(record) : undefined;
  let best: { length: number; target: unknown } | undefined;
  for (const [pattern, target] of Object.entries(record)) {
    const star = pattern.indexOf("*");
    if (star < 0 || target == null) continue;
    const prefix = pattern.slice(0, star);
    const suffix = pattern.slice(star + 1);
    if (!subpath.startsWith(prefix) || (suffix.length > 0 && !subpath.endsWith(suffix))) continue;
    const matched = subpath.slice(prefix.length, subpath.length - suffix.length);
    if (!matched || matched.startsWith("/") || matched.split("/").includes("..")) continue;
    if (best && prefix.length <= best.length) continue;
    best = { length: prefix.length, target: replaceExportStars(target, matched) };
  }
  return best ? unwrapExportCondition(best.target) : undefined;
}

export function isConditionalExportMap(record: Record<string, unknown>): boolean {
  return Object.keys(record).some((key) => !key.startsWith("."));
}

export function replaceExportStars(value: unknown, matched: string): unknown {
  if (typeof value === "string") return value.replaceAll("*", matched);
  if (Array.isArray(value)) return value.map((item) => replaceExportStars(item, matched));
  if (!value || typeof value !== "object") return value;
  const next: Record<string, unknown> = {};
  for (const [key, item] of Object.entries(value as Record<string, unknown>)) next[key] = replaceExportStars(item, matched);
  return next;
}

export function unwrapExportCondition(value: unknown): string | undefined {
  if (typeof value === "string") return value;
  if (Array.isArray(value)) {
    for (const item of value) {
      const resolved = unwrapExportCondition(item);
      if (resolved) return resolved;
    }
    return undefined;
  }
  if (!value || typeof value !== "object") return undefined;
  const record = value as Record<string, unknown>;
  for (const condition of ["browser", "import", "module", "default"]) {
    if (!(condition in record)) continue;
    const resolved = unwrapExportCondition(record[condition]);
    if (resolved) return resolved;
  }
  return undefined;
}

export function shouldKeepInstalledPackage(
  workspace: { exists(path: string): boolean; readText(path: string): string },
  manifestPath: string
): boolean {
  if (!workspace.exists(manifestPath)) return false;
  try {
    const manifest = JSON.parse(workspace.readText(manifestPath)) as { nuriteoFixture?: unknown; version?: unknown };
    if (manifest.nuriteoFixture === true) return false;
    if (manifest.version === "product-fixture" || manifest.version === "browser-native-shim") return false;
    return true;
  } catch {
    return true;
  }
}

export function resolveInstalledPreviewSpecifier(
  projectRoot: string,
  specifier: string,
  workspace: { exists(path: string): boolean; isFile?(path: string): boolean; readText(path: string): string }
): string | undefined {
  if (!specifier || specifier.startsWith(".") || specifier.startsWith("/") || specifier.startsWith("node:")) return undefined;
  const parts = specifier.split("/");
  const packageName = specifier.startsWith("@") ? parts.slice(0, 2).join("/") : parts[0];
  if (!packageName || (specifier.startsWith("@") && parts.length < 2)) return undefined;
  const subpath = specifier === packageName ? "." : `./${specifier.slice(packageName.length + 1)}`;
  const packageRoot = join(projectRoot, "node_modules", packageName);
  const manifestPath = join(packageRoot, "package.json");
  if (!workspaceHasFile(workspace, manifestPath)) return undefined;
  let manifest: { browser?: unknown; exports?: unknown; main?: string; module?: string; version?: string };
  try {
    manifest = JSON.parse(workspace.readText(manifestPath)) as typeof manifest;
  } catch {
    return undefined;
  }
  if (manifest.version === "product-fixture") return undefined;
  const hasExports = manifest.exports != null;
  const browserMain = typeof manifest.browser === "string" ? manifest.browser : undefined;
  const target = hasExports
    ? previewExportTarget(manifest, subpath)
    : subpath === "."
      ? manifest.module ?? browserMain ?? manifest.main ?? "./index.js"
      : subpath;
  if (!target || target.includes("..")) return undefined;
  const relative = target.replace(/^\.\//u, "");
  const resolved = resolvePreviewFile(join(packageRoot, relative), workspace);
  if (!resolved) return undefined;
  const url = `/${resolved.slice(projectRoot.length).replace(/^\/+/u, "")}`;
  return resolved.endsWith(".json") ? `${url}?nuriteo-module=json` : url;
}

export function rewriteBrowserModuleImports(source: string, resolveSpecifier?: (specifier: string) => string | undefined): string {
  let next = source.replace(
    /import\s+["'](\.[^"']+\.(?:css|scss|sass|less))["'];?/g,
    (_full, specifier: string) => (
      `(() => { const href = new URL(${JSON.stringify(specifier)}, import.meta.url).href; if (![...document.querySelectorAll('link[rel="stylesheet"]')].some((node) => node.href === href)) { const link = document.createElement("link"); link.rel = "stylesheet"; link.href = href; document.head.appendChild(link); } })();`
    )
  );
  next = next.replace(
    /from\s+["'](\.[^"']+)["']/g,
    (full, specifier: string) => {
      if (/\.[a-z0-9]+$/i.test(specifier)) return full;
      return full.replace(specifier, `${specifier}.js`);
    }
  );
  if (!resolveSpecifier) return next;
  return next.replace(
    /(from\s+|import\s*\(\s*|import\s+)(["'])([^"']+)\2/g,
    (full, prefix: string, quote: string, specifier: string) => {
      if (specifier.startsWith(".") || specifier.startsWith("/") || specifier.startsWith("node:")) return full;
      const resolved = resolveSpecifier(specifier);
      return resolved ? `${prefix}${quote}${resolved}${quote}` : full;
    }
  );
}

export function previewJsonModuleSource(source: string): string {
  return `export default ${JSON.stringify(JSON.parse(source))};\n`;
}

export function finishPreviewModule(
  path: string,
  source: string,
  resolveSpecifier?: (specifier: string) => string | undefined,
  context?: PreviewModuleContext
): string {
  const stripped = source.startsWith("#!") ? source.replace(/^#![^\n]*\n?/u, "") : source;
  const rewritten = rewriteBrowserModuleImports(stripped, resolveSpecifier);
  return applyPreviewCommonJs(path, rewritten, context);
}

export function applyPreviewCommonJs(path: string, source: string, context?: PreviewModuleContext): string {
  const stripped = source.startsWith("#!") ? source.replace(/^#![^\n]*\n?/u, "") : source;
  if (!context || !shouldWrapPreviewCommonJs(path, stripped, previewPackageType(context.projectRoot, context.importerPath, context.workspace))) {
    return stripped;
  }
  return wrapPreviewCommonJs(stripped, (specifier) => resolvePreviewDependency(context, specifier));
}

export function shouldWrapPreviewCommonJs(path: string, source: string, packageType: "module" | "commonjs"): boolean {
  const normalized = path.replaceAll("\\", "/");
  if (!normalized.includes("/node_modules/")) return false;
  if (/\.mjs$/iu.test(normalized)) return false;
  if (hasEsmSyntax(source)) return false;
  if (/\.cjs$/iu.test(normalized)) return true;
  if (!/\.js$/iu.test(normalized)) return false;
  return packageType !== "module";
}

export function previewPackageType(
  projectRoot: string,
  filePath: string,
  workspace: { exists(path: string): boolean; isFile?(path: string): boolean; readText(path: string): string }
): "module" | "commonjs" {
  const root = projectRoot.replace(/\/+$/u, "");
  let dir = parentPath(filePath);
  while (dir === root || dir.startsWith(`${root}/`)) {
    const manifestPath = `${dir}/package.json`;
    if (workspaceHasFile(workspace, manifestPath)) {
      try {
        const parsed = JSON.parse(workspace.readText(manifestPath)) as { type?: string };
        return parsed.type === "module" ? "module" : "commonjs";
      } catch {
        return "commonjs";
      }
    }
    if (dir === root) break;
    const parent = parentPath(dir);
    if (parent === dir) break;
    dir = parent;
  }
  return "commonjs";
}

export function resolvePreviewDependency(context: PreviewModuleContext, specifier: string): string | undefined {
  if (specifier.startsWith(".")) {
    const resolved = resolvePreviewFile(join(parentPath(context.importerPath), specifier), context.workspace);
    if (!resolved || !resolved.startsWith(context.projectRoot)) return undefined;
    const url = `/${resolved.slice(context.projectRoot.length).replace(/^\/+/u, "")}`;
    return resolved.endsWith(".json") ? `${url}?nuriteo-module=json` : url;
  }
  return resolveInstalledPreviewSpecifier(context.projectRoot, specifier, context.workspace);
}

export function resolvePreviewFile(
  path: string,
  workspace: { exists(path: string): boolean; isFile?(path: string): boolean }
): string | undefined {
  const candidates = [
    path,
    `${path}.js`,
    `${path}.mjs`,
    `${path}.cjs`,
    `${path}.json`,
    join(path, "index.js"),
    join(path, "index.mjs"),
    join(path, "index.cjs"),
    join(path, "index.json")
  ];
  return candidates.find((candidate) => workspaceHasFile(workspace, candidate));
}

export function workspaceHasFile(
  workspace: { exists(path: string): boolean; isFile?(path: string): boolean },
  path: string
): boolean {
  return workspace.isFile ? workspace.isFile(path) : workspace.exists(path);
}

export function parentPath(path: string): string {
  const trimmed = path.replace(/\/+$/u, "");
  const index = trimmed.lastIndexOf("/");
  return index <= 0 ? "/" : trimmed.slice(0, index);
}

export function wrapPreviewCommonJs(source: string, resolveDependency: (specifier: string) => string | undefined): string {
  const specifiers = collectStaticRequires(source);
  const imports: string[] = [];
  const entries: string[] = [];
  for (const specifier of specifiers) {
    const resolved = resolveDependency(specifier);
    if (!resolved) continue;
    const binding = `__nuriteoReq${imports.length}`;
    imports.push(`import * as ${binding} from ${JSON.stringify(resolved)};`);
    entries.push(`${JSON.stringify(specifier)}: () => __nuriteoCjsInterop(${binding})`);
  }
  const names = collectCjsExportNames(source);
  const named = names.map((name) => `export const ${name} = __nuriteoExports.${name};`).join("\n");
  return [
    ...imports,
    "function __nuriteoCjsInterop(namespace) {",
    "  if (namespace == null || (typeof namespace !== \"object\" && typeof namespace !== \"function\")) return namespace;",
    "  const names = Object.keys(namespace).filter((key) => key !== \"default\" && key !== \"__esModule\");",
    "  const fallback = \"default\" in namespace ? namespace.default : namespace;",
    "  if (names.length === 0) return fallback;",
    "  const target = fallback && (typeof fallback === \"object\" || typeof fallback === \"function\") ? fallback : { default: fallback };",
    "  for (const key of names) {",
    "    if (key in target) continue;",
    "    try { Object.defineProperty(target, key, { configurable: true, enumerable: true, get() { return namespace[key]; } }); } catch {}",
    "  }",
    "  return target;",
    "}",
    "const __nuriteoRequireMap = {",
    entries.join(",\n"),
    "};",
    "function __nuriteoRequire(id) {",
    "  const load = __nuriteoRequireMap[id];",
    "  if (typeof load !== \"function\") throw new Error(`Nuriteo preview cannot resolve require(${JSON.stringify(id)})`);",
    "  return load();",
    "}",
    "const __nuriteoModule = { exports: {} };",
    "const __nuriteoExportObject = __nuriteoModule.exports;",
    "(function (require, module, exports) {",
    source,
    "}).call(__nuriteoExportObject, __nuriteoRequire, __nuriteoModule, __nuriteoExportObject);",
    "const __nuriteoExports = __nuriteoModule.exports;",
    "const __nuriteoDefault = __nuriteoExports != null && __nuriteoExports.__esModule ? __nuriteoExports.default : __nuriteoExports;",
    "export default __nuriteoDefault;",
    named
  ].filter((line) => line !== "").join("\n");
}

export function collectStaticRequires(source: string): string[] {
  const found: string[] = [];
  const length = source.length;
  let index = 0;
  let mode: "code" | "line" | "block" | "single" | "double" | "template" = "code";
  while (index < length) {
    const current = source[index] ?? "";
    const next = source[index + 1] ?? "";
    if (mode === "line") {
      if (current === "\n") mode = "code";
      index += 1;
      continue;
    }
    if (mode === "block") {
      if (current === "*" && next === "/") {
        mode = "code";
        index += 2;
        continue;
      }
      index += 1;
      continue;
    }
    if (mode === "single" || mode === "double") {
      if (current === "\\") {
        index += 2;
        continue;
      }
      if ((mode === "single" && current === "'") || (mode === "double" && current === "\"")) mode = "code";
      index += 1;
      continue;
    }
    if (mode === "template") {
      if (current === "\\") {
        index += 2;
        continue;
      }
      if (current === "`") mode = "code";
      index += 1;
      continue;
    }
    if (current === "/" && next === "/") {
      mode = "line";
      index += 2;
      continue;
    }
    if (current === "/" && next === "*") {
      mode = "block";
      index += 2;
      continue;
    }
    if (current === "'") {
      mode = "single";
      index += 1;
      continue;
    }
    if (current === "\"") {
      mode = "double";
      index += 1;
      continue;
    }
    if (current === "`") {
      mode = "template";
      index += 1;
      continue;
    }
    if (source.startsWith("require", index) && (index === 0 || !/[\w$]/u.test(source[index - 1] ?? ""))) {
      const specifier = readRequireSpecifier(source, index + "require".length);
      if (specifier) found.push(specifier);
    }
    index += 1;
  }
  return [...new Set(found)];
}

export function readRequireSpecifier(source: string, start: number): string | undefined {
  let index = start;
  while (index < source.length && /\s/u.test(source[index] ?? "")) index += 1;
  if (source[index] !== "(") return undefined;
  index += 1;
  while (index < source.length && /\s/u.test(source[index] ?? "")) index += 1;
  const quote = source[index];
  if (quote !== "'" && quote !== "\"") return undefined;
  index += 1;
  let specifier = "";
  while (index < source.length) {
    const current = source[index] ?? "";
    if (current === "\\") {
      specifier += source[index + 1] ?? "";
      index += 2;
      continue;
    }
    if (current === quote) {
      index += 1;
      while (index < source.length && /\s/u.test(source[index] ?? "")) index += 1;
      return source[index] === ")" ? specifier : undefined;
    }
    if (current === "\n") return undefined;
    specifier += current;
    index += 1;
  }
  return undefined;
}

export function collectCjsExportNames(source: string): string[] {
  const stripped = stripSyntaxNoise(source);
  const names = new Set<string>();
  for (const match of stripped.matchAll(/(?:^|[^\w$])(?:module\.)?exports\.([A-Za-z_$][\w$]*)/gu)) {
    if (match[1] && match[1] !== "__esModule") names.add(match[1]);
  }
  const assign = stripped.search(/module\.exports\s*=\s*\{/u);
  if (assign >= 0) {
    const brace = stripped.indexOf("{", assign);
    if (brace >= 0) collectObjectKeys(stripped, brace, names);
  }
  return [...names].filter((name) => /^[A-Za-z_$][\w$]*$/u.test(name) && !reservedExportNames.has(name));
}

export const reservedExportNames = new Set([
  "await", "break", "case", "catch", "class", "const", "continue", "debugger", "default", "delete",
  "do", "else", "enum", "eval", "export", "extends", "false", "finally", "for", "function", "if",
  "implements", "import", "in", "instanceof", "interface", "let", "new", "null", "package", "private",
  "protected", "public", "return", "static", "super", "switch", "this", "throw", "true", "try",
  "typeof", "var", "void", "while", "with", "yield", "__esModule"
]);

export function collectObjectKeys(source: string, braceIndex: number, names: Set<string>): void {
  let depth = 0;
  let index = braceIndex;
  let mode: "code" | "single" | "double" = "code";
  let token = "";
  while (index < source.length) {
    const current = source[index] ?? "";
    if (mode === "single" || mode === "double") {
      if (current === "\\") {
        index += 2;
        continue;
      }
      if ((mode === "single" && current === "'") || (mode === "double" && current === "\"")) mode = "code";
      index += 1;
      continue;
    }
    if (current === "'") {
      mode = "single";
      index += 1;
      continue;
    }
    if (current === "\"") {
      mode = "double";
      index += 1;
      continue;
    }
    if (current === "{") {
      depth += 1;
      token = "";
      index += 1;
      continue;
    }
    if (current === "}") {
      depth -= 1;
      if (depth === 0) {
        addShorthandKey(token, names);
        return;
      }
      token = "";
      index += 1;
      continue;
    }
    if (depth === 1 && current === ":") {
      addObjectKey(token, names);
      token = "";
      index += 1;
      continue;
    }
    if (depth === 1 && current === ",") {
      addShorthandKey(token, names);
      token = "";
      index += 1;
      continue;
    }
    token = depth === 1 ? `${token}${current}` : "";
    index += 1;
  }
}

export function addObjectKey(token: string, names: Set<string>): void {
  const key = token.trim().match(/([A-Za-z_$][\w$]*|'(?:\\.|[^'])*'|"(?:\\.|[^"])*")$/u)?.[1];
  if (!key || key === "default") return;
  const name = key.startsWith("'") || key.startsWith("\"") ? key.slice(1, -1) : key;
  if (/^[A-Za-z_$][\w$]*$/u.test(name) && name !== "__esModule") names.add(name);
}

export function addShorthandKey(token: string, names: Set<string>): void {
  const key = token.trim().match(/([A-Za-z_$][\w$]*)$/u)?.[1];
  if (key && key !== "default" && key !== "__esModule") names.add(key);
}

export function hasEsmSyntax(source: string): boolean {
  const stripped = stripSyntaxNoise(source);
  return /(?:^|[^\w$])(?:import|export)\s/u.test(stripped) || /(?:^|[^\w$])import\s*\(/u.test(stripped);
}

export function stripSyntaxNoise(source: string): string {
  return source
    .replace(/\/\*[\s\S]*?\*\//gu, " ")
    .replace(/(^|[^\\])\/\/[^\n]*/gu, "$1")
    .replace(/'(?:\\.|[^'\\])*'/gu, "''")
    .replace(/"(?:\\.|[^"\\])*"/gu, "\"\"")
    .replace(/`(?:\\.|[^`\\])*`/gu, "``");
}

export function normalizeServedPath(path: string): string {
  const normalized = path.replaceAll("\\", "/").replace(/\/+/g, "/");
  return normalized.startsWith("/") ? normalized : `/${normalized}`;
}

export function hmrLabelForSource(path: string, source: string): string {
  const label = source.match(/label\s*=\s*"([^"]+)"/)?.[1];
  if (label) return label;
  const segments = path.split("/").filter(Boolean);
  return segments.at(-1) || path;
}

export function assertViteDevCommand(command: string): void {
  if (!/^vite(\s|$)/.test(command) || command.includes(" build") || command.includes(" preview")) {
    throw new Error(`unsupported Vite dev command: ${command}`);
  }
}

export function assertViteBuildCommand(command: string): void {
  if (command !== "vite build") throw new Error(`unsupported Vite build command: ${command}`);
}

export function commandArgs(command: string): string[] {
  return command.split(/\s+/).slice(1).filter(Boolean);
}

export function parseViteReadyPort(stdout: string): number | null {
  const match = stdout.match(/http:\/\/(?:127\.0\.0\.1|localhost):(\d+)\//);
  return match?.[1] ? Number(match[1]) : null;
}

export function latestHmrSendUpdate(registrations: ViteProductCliHmrRegistration[]): ViteProductCliHmrSendUpdate | null {
  for (let index = registrations.length - 1; index >= 0; index -= 1) {
    const registration = registrations[index];
    if (registration?.sendUpdate) return registration.sendUpdate;
  }
  return null;
}

export function latestTransformRequest(registrations: ViteProductCliTransformRegistration[]): ViteProductCliTransformRequest | null {
  for (let index = registrations.length - 1; index >= 0; index -= 1) {
    const registration = registrations[index];
    if (registration?.transformRequest) return registration.transformRequest;
  }
  return null;
}
