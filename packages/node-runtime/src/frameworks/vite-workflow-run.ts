import { join } from "../builtins/path.ts";
import { createViteDependencyArtifactsFromWorkspace, mergeViteDependencyArtifacts, readerExists } from "./vite-artifacts.ts";
import type { VitePackageManifest, ViteProductDependencyArtifact } from "./vite-artifacts.ts";
import type { ViteProductAsyncBindingReadinessBlocker, ViteProductAsyncModuleBlocker, ViteProductBuildResult, ViteProductCliBackedWorkflowResult, ViteProductCliBuildRegistration, ViteProductCliExecutionResult, ViteProductCliHmrRegistration, ViteProductCliServerRegistration, ViteProductCliTransformRegistration, ViteProductDependencyArtifactClosureIteration, ViteProductDependencyArtifactClosureOptions, ViteProductDependencyArtifactClosureResult, ViteProductDevServerSnapshot, ViteProductDevServerSource, ViteProductHmrResult, ViteProductHmrUpdate, ViteProductInstallResult, ViteProductModuleTransformSource, ViteProductPackageManager, ViteProductPreviewResult, ViteProductReloadRecoveryResult, ViteProductSourceEditResult, ViteProductTemplate, ViteProductWorkflowOptions, ViteProductWorkflowResult } from "./vite-workflow-types.ts";
import { ViteProductWorkflow } from "./vite-workflow.ts";
import { normalizeServedPath } from "./vite-workflow-preview.ts";
import type { ViteProductCliTransformRequestInput, ViteProductCliTransformResult, ViteProductPackageSource } from "./vite-workflow-types.ts";
import type { PackageManagerWorkspaceMount } from "../package-managers/workspace.ts";
import type { CliRunResult, RuntimeEnv } from "../types.ts";
import type { CliEvaluationCapturedGlobalCall } from "../package-managers/cli-evaluator.ts";
import type { CliModuleGraph, CliModuleGraphIssue } from "../package-managers/cli-module-graph.ts";
import type { WasmAdapterPolicy, WasmAdapterPolicyAction } from "../wasm-adapters/index.ts";
import type { ViteDependencyMaterializationPlan, ViteDependencyMaterializationOptionalKind, ViteDependencyMaterializationKind, ViteDependencyMaterializationWasmReplacement, ViteDependencyMaterializationItem, ViteDependencyMaterializationOptionalItem, ViteDependencyMaterializationSummary, ViteRuntimeCapability, ViteRuntimeCapabilityStatus } from "./vite-materialization.ts";
import type { CliEntryReadiness } from "../package-managers/cli-entry-readiness.ts";
import type { RuntimeHttpResponse } from "../net/index.ts";

export function runViteProductWorkflow(options: ViteProductWorkflowOptions): ViteProductWorkflowResult {
  return new ViteProductWorkflow(options).run();
}

export function runViteProductCliBackedWorkflow(options: ViteProductWorkflowOptions): Promise<ViteProductCliBackedWorkflowResult> {
  return new ViteProductWorkflow(options).runCliBacked();
}


export function createViteDependencyArtifactClosureFromWorkspace(
  options: ViteProductDependencyArtifactClosureOptions
): ViteProductDependencyArtifactClosureResult {
  const nodeModulesRoot = normalizeServedPath(options.nodeModulesRoot).replace(/\/$/, "");
  const maxIterations = options.maxIterations ?? 8;
  let artifacts = options.initialArtifacts || [];
  const iterations: ViteProductDependencyArtifactClosureIteration[] = [];
  let remainingPlan = inspectDependencyMaterializationPlan(options, artifacts);

  for (let iteration = 0; iteration < maxIterations; iteration += 1) {
    const planNames = remainingPlan.missing
      .filter((item) => item.kind !== "native-hold")
      .flatMap((item) => item.artifactNames);
    const manifestDependencyNames = dependencyNamesFromArtifacts(artifacts);
    const extractableNames = uniquePackageNames([...planNames, ...manifestDependencyNames])
      .filter((name) => !artifacts.some((artifact) => artifact.name === name))
      .filter((name) => readerExists(options.reader, join(nodeModulesRoot, name, "package.json")))
      .sort((left, right) => left.localeCompare(right));
    if (extractableNames.length === 0) break;

    const extracted = createViteDependencyArtifactsFromWorkspace({
      names: extractableNames,
      nodeModulesRoot,
      reader: options.reader
    });
    artifacts = mergeViteDependencyArtifacts(artifacts, extracted).artifacts;
    remainingPlan = inspectDependencyMaterializationPlan(options, artifacts);
    iterations.push({
      extracted: extracted.map((artifact) => artifact.name),
      plan: remainingPlan
    });
  }

  return {
    artifacts,
    iterations,
    remainingPlan
  };
}

export function dependencyNamesFromArtifacts(artifacts: readonly ViteProductDependencyArtifact[]): string[] {
  return uniquePackageNames(artifacts.flatMap((artifact) => {
    const packageJsonMount = artifact.mounts.find((mount) => mount.path === "package.json");
    if (!packageJsonMount) return [];
    try {
      const manifest = JSON.parse(packageJsonMount.data) as VitePackageManifest;
      return Object.keys(manifest.dependencies || {});
    } catch {
      return [];
    }
  }));
}

export function runViteReactProductWorkflow(options: ViteProductWorkflowOptions): ViteProductWorkflowResult {
  return runViteProductWorkflow({ ...options, template: options.template || "react" });
}

export function runViteReactCliBackedWorkflow(options: ViteProductWorkflowOptions): Promise<ViteProductCliBackedWorkflowResult> {
  return runViteProductCliBackedWorkflow({ ...options, template: options.template || "react" });
}

export function createViteHmrUpdate(path: string, label: string, timestamp = Date.now()): ViteProductHmrUpdate {
  return {
    type: "update",
    updates: [
      {
        type: path.endsWith(".css") ? "css-update" : "js-update",
        path,
        acceptedPath: path,
        timestamp,
        explicitImportRequired: false,
        ssrInvalidates: [],
        label
      }
    ]
  };
}

export type ViteReactPackageManager = ViteProductPackageManager;
export type ViteReactCliBackedWorkflowResult = ViteProductCliBackedWorkflowResult;
export type ViteReactProductWorkflowOptions = ViteProductWorkflowOptions;
export type ViteReactProductWorkflowResult = ViteProductWorkflowResult;
export type ViteReactCliBuildRegistration = ViteProductCliBuildRegistration;
export type ViteReactCliExecutionResult = ViteProductCliExecutionResult;
export type ViteReactCliHmrRegistration = ViteProductCliHmrRegistration;
export type ViteReactCliServerRegistration = ViteProductCliServerRegistration;
export type ViteReactCliTransformRegistration = ViteProductCliTransformRegistration;
export type ViteReactDevServerSource = ViteProductDevServerSource;
export type ViteReactModuleTransformSource = ViteProductModuleTransformSource;
export type ViteReactInstallResult = ViteProductInstallResult;
export type ViteReactDevServerSnapshot = ViteProductDevServerSnapshot;
export type ViteReactHmrUpdate = ViteProductHmrUpdate;
export type ViteReactPreviewResult = ViteProductPreviewResult;
export type ViteReactHmrResult = ViteProductHmrResult;
export type ViteReactSourceEditResult = ViteProductSourceEditResult;
export type ViteReactBuildResult = ViteProductBuildResult;
export type ViteReactReloadRecoveryResult = ViteProductReloadRecoveryResult;

export function createViteMounts(projectRoot: string, template: ViteProductTemplate, label: string): PackageManagerWorkspaceMount[] {
  const entry = template === "react"
    ? "./src/main.jsx"
    : template === "vanilla"
      ? "./src/main.js"
      : "./src/main.js";
  const messagePath = template === "vanilla" ? "src/message.js" : "src/message.js";
  return [
    {
      path: join(projectRoot, "package.json"),
      data: JSON.stringify({
        name: `vite-${template}-product-workflow`,
        version: "1.0.0",
        private: true,
        type: "module",
        scripts: {
          dev: "vite --host 127.0.0.1",
          build: "vite build",
          preview: "vite preview --host 127.0.0.1"
        },
        dependencies: {
          vite: "8.2.0",
          ...(template === "vanilla" ? {} : { typescript: "6.0.3" }),
          ...dependenciesForTemplate(template)
        }
      })
    },
    {
      path: join(projectRoot, "index.html"),
      data: `<!doctype html><html><head><meta charset="UTF-8" /></head><body><div id="app"></div><script type="module" src="${entry}"></script></body></html>\n`
    },
    ...sourceMountsForTemplate(projectRoot, template),
    {
      path: join(projectRoot, messagePath),
      data: `export const label = "${label}";\n`
    },
    {
      path: join(projectRoot, "src/style.css"),
      data: "body { margin: 0; font-family: system-ui, sans-serif; }\n#app { padding: 1rem; }\n"
    }
  ];
}

export function createLockfile(manager: ViteProductPackageManager, packages: string[]): string {
  if (manager === "npm") {
    return JSON.stringify({
      lockfileVersion: 3,
      packages: Object.fromEntries(packages.map((pkg) => [`node_modules/${pkg}`, { version: "product-fixture" }]))
    });
  }
  if (manager === "yarn") {
    return [
      "# yarn lockfile v1",
      ...packages.flatMap((pkg) => [`${pkg}@product-fixture:`, "  version \"product-fixture\""])
    ].join("\n") + "\n";
  }
  return [
    "lockfileVersion: '9.0'",
    "importers:",
    "  .:",
    "    dependencies:",
    ...packages.map((pkg) => `      ${pkg}: product-fixture`)
  ].join("\n") + "\n";
}

export function packagesForTemplate(template: ViteProductTemplate): string[] {
  const base = template === "vanilla" ? ["vite"] : ["vite", "typescript"];
  return [...base, ...Object.keys(dependenciesForTemplate(template))];
}

export function uniquePackageNames(packages: string[]): string[] {
  return [...new Set(packages)];
}

export function hasCapturedViteGlobalCalls(result: CliRunResult): result is CliRunResult & { capturedGlobalCalls: CliEvaluationCapturedGlobalCall[] } {
  return "capturedGlobalCalls" in result && Array.isArray(result.capturedGlobalCalls);
}

export function applyCapturedViteGlobalCalls(
  calls: readonly CliEvaluationCapturedGlobalCall[],
  target: {
    buildRegistrations: ViteProductCliBuildRegistration[];
    hmrRegistrations: ViteProductCliHmrRegistration[];
    serverRegistrations: ViteProductCliServerRegistration[];
    transformRegistrations: ViteProductCliTransformRegistration[];
    broadcastHmr: (update: ViteProductHmrUpdate) => ViteProductHmrUpdate;
  }
): void {
  for (const call of calls) {
    const registration = call.args[0];
    if (!isObjectRecord(registration)) continue;
    if (call.name === "__viteRegisterBuild") {
      target.buildRegistrations.push({
        command: "build",
        outDir: typeof registration.outDir === "string" ? registration.outDir : "dist",
        source: "vite-cli"
      });
    } else if (call.name === "__viteRegisterDevServer") {
      target.serverRegistrations.push({
        command: "dev",
        host: typeof registration.host === "string" ? registration.host : "127.0.0.1",
        port: typeof registration.port === "number" ? registration.port : 5173,
        source: "vite-cli"
      });
    } else if (call.name === "__viteRegisterHmrChannel") {
      target.hmrRegistrations.push({
        channel: "hmr",
        source: "vite-cli",
        transport: "loopback",
        ...(registration.sendUpdate ? { sendUpdate: (update: ViteProductHmrUpdate) => target.broadcastHmr(update) } : {})
      });
    } else if (call.name === "__viteRegisterTransform") {
      target.transformRegistrations.push({
        mode: "browser-esm",
        source: "vite-cli",
        ...(registration.transformRequest
          ? {
            transformRequest(request: ViteProductCliTransformRequestInput): ViteProductCliTransformResult {
              return { code: `// worker proxy transform:${request.path}\n${request.source}` };
            }
          }
          : {})
      });
    }
  }
}

export function isObjectRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null;
}

export function isForcedWasiEnv(env: RuntimeEnv): boolean {
  return env.NAPI_RS_FORCE_WASI === "error" || env.NAPI_RS_FORCE_WASI === "true";
}

export function classifyAsyncModuleBlocker(stderr: string): ViteProductAsyncModuleBlocker | null {
  const match = stderr.match(/ERR_REQUIRE_ASYNC_MODULE: ([^\n]+)/);
  if (!match?.[1]) return null;
  return {
    module: match[1],
    reason: "sync-require-of-async-esm"
  };
}

export function classifyAsyncBindingReadinessBlocker(stderr: string): ViteProductAsyncBindingReadinessBlocker | null {
  if (!stderr.includes("Class extends value undefined is not a constructor or null")) return null;
  return {
    reason: "async-binding-namespace-not-ready"
  };
}

export function createDependencyMaterializationPlan(
  graph: CliModuleGraph,
  dependencyArtifacts: readonly ViteProductDependencyArtifact[],
  wasmAdapterPolicy: WasmAdapterPolicy | null
): ViteDependencyMaterializationPlan {
  const satisfied = uniquePackageNames(dependencyArtifacts.map((artifact) => artifact.name)).sort();
  const satisfiedSet = new Set(satisfied);
  const missingSpecifiersByPackage = new Map<string, Set<string>>();
  for (const issue of graph.issues) {
    if (issue.kind !== "missing-module") continue;
    const packageName = packageNameFromSpecifier(issue.specifier);
    if (!packageName || packageName === "vite" || satisfiedSet.has(packageName)) continue;
    const specifiers = missingSpecifiersByPackage.get(packageName) || new Set<string>();
    specifiers.add(issue.specifier);
    missingSpecifiersByPackage.set(packageName, specifiers);
  }
  const missing = [...missingSpecifiersByPackage.entries()]
    .map(([name, specifiers]) => ({
      artifactNames: artifactNamesForDependency(name, wasmAdapterPolicy),
      kind: classifyDependencyMaterialization(name, wasmAdapterPolicy),
      name,
      nextAction: nextActionForDependencyMaterialization(name, wasmAdapterPolicy),
      specifiers: [...specifiers].sort(),
      ...wasmReplacementForDependency(name, wasmAdapterPolicy)
    }))
    .sort((left, right) => left.name.localeCompare(right.name));
  const optional = graph.issues
    .filter((issue): issue is CliModuleGraphIssue & { kind: ViteDependencyMaterializationOptionalKind } => issue.kind.startsWith("optional-"))
    .map((issue) => ({
      kind: issue.kind,
      nextAction: nextActionForOptionalDependencyMaterialization(issue),
      specifier: issue.specifier
    }))
    .sort((left, right) => left.specifier.localeCompare(right.specifier));
  return {
    summary: createDependencyMaterializationSummary(missing, optional, satisfied),
    missing,
    optional,
    satisfied
  };
}

export function inspectDependencyMaterializationPlan(
  options: ViteProductDependencyArtifactClosureOptions,
  dependencyArtifacts: readonly ViteProductDependencyArtifact[]
): ViteDependencyMaterializationPlan {
  const workflow = new ViteProductWorkflow({
    manager: options.manager,
    vitePackageArtifact: options.vitePackageArtifact,
    dependencyArtifacts: [...dependencyArtifacts],
    ...(options.wasmAdapterPolicy === undefined ? {} : { wasmAdapterPolicy: options.wasmAdapterPolicy }),
    ...(options.projectRoot === undefined ? {} : { projectRoot: options.projectRoot })
  });
  workflow.install();
  return workflow.inspectRealCliReadiness().dependencyMaterializationPlan;
}

export function packageNameFromSpecifier(specifier: string): string | null {
  if (specifier.startsWith(".") || specifier.startsWith("/") || specifier.startsWith("#") || specifier.startsWith("node:")) return null;
  const parts = specifier.split("/");
  if (specifier.startsWith("@")) return parts.length >= 2 ? `${parts[0]}/${parts[1]}` : null;
  return parts[0] || null;
}

export function isPackageAliasName(aliasName: string, packageName: string | undefined): boolean {
  if (!packageName) return false;
  return aliasName.endsWith("-cjs") && aliasName.slice(0, -4) === packageName;
}

export function classifyDependencyMaterialization(name: string, wasmAdapterPolicy: WasmAdapterPolicy | null): ViteDependencyMaterializationKind {
  const resolved = resolveWasmDependency(name, wasmAdapterPolicy);
  if (resolved?.action === "use-wasm") return "wasm-adapter-candidate";
  if (name === "esbuild" || name === "rolldown") return "wasm-adapter-candidate";
  if (name === "lightningcss") return "native-hold";
  return "package-artifact";
}

export function nextActionForDependencyMaterialization(name: string, wasmAdapterPolicy: WasmAdapterPolicy | null): string {
  const kind = classifyDependencyMaterialization(name, wasmAdapterPolicy);
  if (kind === "wasm-adapter-candidate") {
    return "Materialize the JavaScript package surface and route native binding requests through an integrity-pinned WASM adapter.";
  }
  if (kind === "native-hold") {
    return "Keep this dependency optional or blocked until a supported browser/WASM replacement is proven.";
  }
  return "Extract this package from an installed node_modules tree and mount it as a dependency artifact.";
}

export function wasmReplacementForDependency(
  name: string,
  wasmAdapterPolicy: WasmAdapterPolicy | null
): { wasm?: ViteDependencyMaterializationWasmReplacement } {
  const resolved = resolveWasmDependency(name, wasmAdapterPolicy);
  if (resolved?.action !== "use-wasm") return {};
  return {
    wasm: {
      ...(resolved.adapterName === undefined ? {} : { adapterName: resolved.adapterName }),
      fallbackPolicy: resolved.fallbackPolicy,
      ...(resolved.status === undefined ? {} : { status: resolved.status }),
      wasmPackage: resolved.wasmPackage
    }
  };
}

export function artifactNamesForDependency(name: string, wasmAdapterPolicy: WasmAdapterPolicy | null): string[] {
  const resolved = resolveWasmDependency(name, wasmAdapterPolicy);
  if (resolved?.action !== "use-wasm") return [name];
  return uniquePackageNames([name, resolved.wasmPackage]);
}

export function resolveWasmDependency(name: string, wasmAdapterPolicy: WasmAdapterPolicy | null): WasmAdapterPolicyAction | null {
  if (!wasmAdapterPolicy) return null;
  try {
    return wasmAdapterPolicy.resolvePackage(name);
  } catch {
    return null;
  }
}

export function nextActionForOptionalDependencyMaterialization(issue: CliModuleGraphIssue): string {
  if (issue.kind === "optional-native-probe") {
    return "Leave this native probe optional unless the package path becomes required by the selected project.";
  }
  if (issue.kind === "optional-cache-probe") {
    return "Leave this cache optimization optional; runtime execution must continue without it.";
  }
  return "Leave this dependency optional unless a project feature explicitly imports it.";
}

export function createDependencyMaterializationSummary(
  missing: readonly ViteDependencyMaterializationItem[],
  optional: readonly ViteDependencyMaterializationOptionalItem[],
  satisfied: readonly string[]
): ViteDependencyMaterializationSummary {
  const missingByKind: Record<ViteDependencyMaterializationKind, number> = {
    "package-artifact": 0,
    "wasm-adapter-candidate": 0,
    "native-hold": 0
  };
  for (const item of missing) {
    missingByKind[item.kind] += 1;
  }
  return {
    missingByKind,
    missingCount: missing.length,
    optionalCount: optional.length,
    satisfiedCount: satisfied.length
  };
}

export function missingCapabilitiesForTemplate(template: ViteProductTemplate): ViteRuntimeCapability[] {
  const capabilities: ViteRuntimeCapability[] = [
    "actual-vite-cli-module-execution",
    "real-vite-http-module-transform",
    "real-vite-hmr-protocol"
  ];
  if (template !== "react" && template !== "vanilla") capabilities.push("framework-plugin-module-execution");
  return capabilities;
}

export function createViteCapabilityStatus(options: {
  cliEntryReadiness: CliEntryReadiness;
  cliModuleGraph: CliModuleGraph;
  missingCapabilities: ViteRuntimeCapability[];
  vitePackageSource: ViteProductPackageSource;
}): ViteRuntimeCapabilityStatus[] {
  const statuses: ViteRuntimeCapabilityStatus[] = [
    createCapabilityStatus({
      capability: "esm-cli-entrypoint",
      evidence: "The Vite bin entrypoint is classified as ESM and accepted by the async CLI evaluator.",
      nextAction: "Expand CLI entrypoint classification before executing this package through the browser guest runtime.",
      status: options.cliEntryReadiness.status === "ready" ? "ready" : "blocked"
    }),
    createCapabilityStatus({
      capability: "minimal-vite-cli-module-graph",
      evidence: "The materialized Vite CLI module graph resolves bin/vite.js and dist node modules without missing-module issues.",
      nextAction: "Resolve the reported Vite CLI module graph issues before CLI-backed workflow execution.",
      status: options.cliModuleGraph.supported ? "ready" : "blocked"
    }),
    {
      capability: "cli-registration-hooks",
      evidence: "The materialized Vite CLI graph emits dev server, build, HMR, and transform registrations through runtime globals.",
      status: "ready"
    },
    {
      capability: "cli-backed-dev-build-workflow",
      evidence: "The product workflow can execute the Vite CLI entrypoint before starting dev/build lifecycle adapters.",
      status: "ready"
    }
  ];
  if (options.vitePackageSource === "mounted-artifact") {
    statuses.push({
      capability: "mounted-vite-artifact-input",
      evidence: "The workflow accepted an externally mounted Vite package artifact and analyzed that artifact's bin/module graph.",
      status: "ready"
    });
  }

  for (const capability of options.missingCapabilities) {
    statuses.push({
      capability,
      evidence: evidenceForMissingCapability(capability),
      nextAction: nextActionForMissingCapability(capability),
      status: "blocked"
    });
  }
  return statuses;
}

export function createCapabilityStatus(options: ViteRuntimeCapabilityStatus & { nextAction: string }): ViteRuntimeCapabilityStatus {
  if (options.status === "ready") {
    return {
      capability: options.capability,
      evidence: options.evidence,
      status: "ready"
    };
  }
  return options;
}

export function evidenceForMissingCapability(capability: ViteRuntimeCapability): string {
  switch (capability) {
    case "actual-vite-cli-module-execution":
      return "The current product workflow executes the materialized Vite CLI graph, not the vendored Vite package source.";
    case "real-vite-http-module-transform":
      return "HTTP module serving still uses the product adapter transform contract instead of Vite server transform middleware.";
    case "real-vite-hmr-protocol":
      return "HMR currently sends Vite wire-compatible payloads from the adapter instead of the real Vite server HMR implementation.";
    case "framework-plugin-module-execution":
      return "Vue and Svelte product workflows still model plugin readiness instead of executing framework plugins through Vite.";
  }
}

export function nextActionForMissingCapability(capability: ViteRuntimeCapability): string {
  switch (capability) {
    case "actual-vite-cli-module-execution":
      return "Vendor or install the real Vite package artifact and run its CLI/module graph through the async browser guest evaluator.";
    case "real-vite-http-module-transform":
      return "Route preview module requests through real Vite transform middleware after the vendored server module boots.";
    case "real-vite-hmr-protocol":
      return "Connect the real Vite HMR channel to the preview socket lifecycle and preserve update diagnostics.";
    case "framework-plugin-module-execution":
      return "Execute the selected framework plugin module path under the same Vite server runtime.";
  }
}

export function dependenciesForTemplate(template: ViteProductTemplate): Record<string, string> {
  if (template === "vanilla") return {};
  if (template === "react") {
    return {
      "@vitejs/plugin-react": "latest",
      react: "18.3.1",
      "react-dom": "18.3.1"
    };
  }
  if (template === "vue-runtime") return { vue: "3.5.25" };
  return {
    "@sveltejs/vite-plugin-svelte": "7.3.0",
    svelte: "5.57.0"
  };
}

export function sourceMountsForTemplate(
  projectRoot: string,
  template: ViteProductTemplate
): PackageManagerWorkspaceMount[] {
  if (template === "vanilla") {
    return [{
      path: join(projectRoot, "src/main.js"),
      data: "import { label } from \"./message.js\";\nimport \"./style.css\";\nconst app = document.querySelector(\"#app\");\nif (app) app.textContent = `${label}:1`;\n"
    }];
  }
  if (template === "react") {
    return [{
      path: join(projectRoot, "src/main.jsx"),
      data: "import React from \"react\";\nimport { createRoot } from \"react-dom/client\";\nimport { label } from \"./message.js\";\ncreateRoot(document.getElementById(\"app\")).render(`${label}:1`);\n"
    }];
  }
  if (template === "vue-runtime") {
    return [{
      path: join(projectRoot, "src/main.js"),
      data: "import { createApp, h } from \"vue\";\nimport { label } from \"./message.js\";\nglobalThis.__fixtureState ||= { count: 1 };\ncreateApp({ render: () => h(\"div\", { id: \"app\" }, `${label}:${globalThis.__fixtureState.count}`) }).mount(\"#app\");\n"
    }];
  }
  return [
    {
      path: join(projectRoot, "vite.config.js"),
      data: "import { svelte } from \"@sveltejs/vite-plugin-svelte\";\nexport default { plugins: [svelte()] };\n"
    },
    {
      path: join(projectRoot, "src/main.js"),
      data: "import App from \"./App.svelte\";\nexport default new App({ target: document.getElementById(\"app\") });\n"
    },
    {
      path: join(projectRoot, "src/App.svelte"),
      data: "<script>import { label } from \"./message.js\"; globalThis.__fixtureState ||= { count: 1 };</script>\n<div id=\"app\">{label}:{globalThis.__fixtureState.count}</div>\n"
    }
  ];
}

export function renderHtml(label: string, count: number): string {
  // Fallback used by build() smoke output when a full preview document is not needed.
  return `<!doctype html><div id="app">${label}:${count}</div>`;
}

export function toRuntimeHttpResponse(preview: ViteProductPreviewResult): RuntimeHttpResponse {
  return {
    statusCode: preview.statusCode,
    headers: preview.headers || { "content-type": "text/html; charset=utf-8" },
    body: preview.body
  };
}

export function previewBodyText(body: ViteProductPreviewResult["body"]): string {
  if (typeof body !== "string") throw new Error("Expected a text Preview response");
  return body;
}

export function decodePreviewText(bytes: Uint8Array): string | null {
  try {
    return new TextDecoder("utf-8", { fatal: true }).decode(bytes);
  } catch {
    return null;
  }
}

export function toResponseBody(body: RuntimeHttpResponse["body"]): BodyInit {
  if (!(body instanceof Uint8Array)) return body || "";
  const copy = new Uint8Array(body.byteLength);
  copy.set(body);
  return copy.buffer;
}

export function contentTypeForPath(path: string): string {
  const pathname = path.split(/[?#]/u, 1)[0] ?? path;
  if (pathname.endsWith(".css")) return "text/css; charset=utf-8";
  if (pathname.endsWith(".html")) return "text/html; charset=utf-8";
  if (pathname.endsWith(".svelte") || /\.(?:[cm]?[jt]sx?)$/iu.test(pathname)) {
    return "text/javascript; charset=utf-8";
  }
  return "application/octet-stream";
}
