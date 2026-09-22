import {
  createProjectWorkspaceDevServerChangeBridge,
  createProjectWorkspaceEditorBridge,
  ProjectWorkspaceEditorBridge,
  ProjectWorkspaceStore,
  type ProjectWorkspaceEditorChangeEvent,
  type ProjectWorkspaceEditorSaveEvent
} from "../../browser-host/src/storage/index.ts";
import {
  exportMaterializedProjectZip,
  exportProjectZip,
  materializeGitHubUrl,
  materializeTemplate,
  materializeZip,
  workflowTemplateForProjectTemplate,
  type MaterializedProject,
  type ProjectHealthReport,
  type SupportedPackageManager,
  type TemplateId
} from "../../browser-host/src/onboarding/index.ts";
import {
  NextProductWorkflow,
  type NextProductBuildResult,
  type NextProductInstallResult
} from "../../node-runtime/src/frameworks/next-workflow.ts";
import {
  ViteProductWorkflow,
  type ViteProductBuildResult,
  type ViteProductInstallResult,
  type ViteProductPackageManager,
  type ViteProductTemplate
} from "../../node-runtime/src/frameworks/vite-workflow.ts";

type ProductWorkflow = ViteProductWorkflow | NextProductWorkflow;
type ProductInstallResult = ViteProductInstallResult | NextProductInstallResult;
type ProductBuildResult = ViteProductBuildResult | NextProductBuildResult;
import {
  createHmrClient,
  createPreviewRelay,
  createPreviewServiceWorker,
  createPreviewSessionRegistry,
  createPreviewUrl,
  createVitePreviewErrorDiagnostic,
  HmrClient,
  PreviewRelay,
  PreviewRelayError,
  PreviewServiceWorker,
  type HmrClientError,
  type HmrClientSnapshot,
  type HmrClientState,
  type PreviewContainer,
  type PreviewDiagnostic,
  type PreviewErrorStage,
  type PreviewRecoveryAction,
  type PreviewSession,
  type PreviewSessionRegistry
} from "../../preview/src/index.ts";
import {
  createPreviewReliabilitySession,
  type PreviewReliabilitySession
} from "./reliability.ts";
import { createPreviewShellSession, type PreviewShellSession } from "./shell.ts";
import {
  injectPreviewErrorBridge,
  shouldInjectPreviewErrorBridge
} from "./preview-inject.ts";
import type { RuntimeRecoveryActionKind } from "../../browser-host/src/observability/recovery-actions.ts";
import type { TerminalRunResult } from "../../node-runtime/src/shell/index.ts";

export type FileSystemTree = {
  [name: string]: { file: { contents: string } } | { directory: FileSystemTree };
};

export interface PreviewChangeStatus {
  dirty: string[];
  untrackedHint: string;
  hasGitMarker: boolean;
}

export const PHASES = Object.freeze({
  idle: "idle",
  templateLoaded: "template_loaded",
  installing: "installing",
  installed: "installed",
  startingDev: "starting_dev",
  previewReady: "preview_ready",
  hmrConnected: "hmr_connected",
  building: "building",
  built: "built",
  failed: "failed"
} as const);

export type PreviewWorkflowPhase = (typeof PHASES)[keyof typeof PHASES];

export type PreviewWorkflowEventType =
  | "log"
  | "phase"
  | "error"
  | "editor-change"
  | "hmr-update"
  | "diagnostic"
  | "import-failed"
  | "template-loaded"
  | "override"
  | "hmr"
  | "preview-ready"
  | "build";

export interface PreviewWorkflowLastError {
  source: string;
  message: string;
  stack?: string;
}

export interface PreviewWorkflowUiDiagnostic {
  code?: string;
  message: string;
  level?: string;
  file?: string;
  stack?: string;
  recoveryActions?: Array<{
    kind: PreviewRecoveryAction["kind"] | RuntimeRecoveryActionKind | (string & {});
    label: string;
  }>;
}

export interface PreviewWorkflowSnapshot {
  phase: PreviewWorkflowPhase;
  projectId: string | null;
  manager: ViteProductPackageManager | SupportedPackageManager | null;
  template: ViteProductTemplate | "next-app" | null;
  source: MaterializedProject["source"] | null;
  health: ProjectHealthReport | null;
  packageManagerOverride: SupportedPackageManager | null;
  previewUrl: string | null;
  hmrState: HmrClientState | "idle";
  install: ProductInstallResult | null;
  build: ProductBuildResult | null;
  lastError: PreviewWorkflowLastError | null;
  diagnostics: PreviewWorkflowUiDiagnostic[];
  logs: string[];
  editor: ProjectWorkspaceEditorBridge | null;
  project: ProjectWorkspaceStore | null;
  workflow: ProductWorkflow | null;
  session: PreviewSession | null;
}

export interface PreviewWorkflowEvent {
  type: PreviewWorkflowEventType;
  detail: Record<string, unknown>;
  snapshot: PreviewWorkflowSnapshot;
}

export type PreviewWorkflowListener = (event: PreviewWorkflowEvent) => void;

export interface PreviewWorkflowController {
  on(listener: PreviewWorkflowListener): () => boolean;
  getSnapshot(): PreviewWorkflowSnapshot;
  loadViteReactTemplate(options?: { label?: string }): PreviewWorkflowSnapshot;
  loadTemplate(templateId?: TemplateId, options?: { label?: string }): PreviewWorkflowSnapshot;
  importZipFile(file: Blob): Promise<PreviewWorkflowSnapshot>;
  importGitHub(url: string): Promise<PreviewWorkflowSnapshot>;
  exportZip(): Uint8Array;
  exportTreeJson(path?: string): FileSystemTree;
  exportPathZip(relativePath: string): Uint8Array;
  setPackageManagerOverride(value: SupportedPackageManager | null | ""): void;
  setPreviewErrorBridge(enabled: boolean): void;
  getChangeStatus(): PreviewChangeStatus;
  runPreview(): Promise<PreviewWorkflowSnapshot>;
  restartDev(): Promise<PreviewWorkflowSnapshot>;
  reconnectHmr(): Promise<HmrClientSnapshot>;
  runBuild(): Promise<PreviewWorkflowSnapshot>;
  ensureServiceWorker(): Promise<ServiceWorkerRegistration>;
  clearPackageCache(): { freedBytes: number; evicted: number };
  resolveWriterConflict(): void;
  runRecoveryAction(kind: RuntimeRecoveryActionKind | string): Promise<unknown>;
  simulateQuotaPressure(bytes?: number): void;
  runShellCommand(command: string): Promise<TerminalRunResult>;
  cancelShellCommand(): boolean;
  log(line: unknown): void;
}

export interface PreviewWorkflowControllerOptions {
  ttlMs?: number;
  relayTimeoutMs?: number;
  previewPort?: number;
}

interface PreviewWorkflowState {
  phase: PreviewWorkflowPhase;
  project: ProjectWorkspaceStore | null;
  editor: ProjectWorkspaceEditorBridge | null;
  workflow: ProductWorkflow | null;
  install: ProductInstallResult | null;
  build: ProductBuildResult | null;
  session: PreviewSession | null;
  previewUrl: string | null;
  hmr: HmrClient | null;
  hmrState: HmrClientState | "idle";
  health: ProjectHealthReport | null;
  source: MaterializedProject["source"] | null;
  packageManagerOverride: SupportedPackageManager | null;
  sessions: PreviewSessionRegistry;
  relay: PreviewRelay;
  serviceWorker: PreviewServiceWorker;
  lastError: PreviewWorkflowLastError | null;
  logs: string[];
  diagnostics: PreviewWorkflowUiDiagnostic[];
  fetchBridgeBound: boolean;
  previewErrorBridge: boolean;
  reliability: PreviewReliabilitySession;
  lastPreviewPort: number | null;
}

interface NormalizedRelayResponse {
  status: number;
  headers: Record<string, string>;
  body: string;
}

const SOURCE_FILE_RE = /\.(?:jsx?|tsx?|css|html|json|md|svelte|vue)$/;

export function createPreviewWorkflowController(
  options: PreviewWorkflowControllerOptions = {}
): PreviewWorkflowController {
  const listeners = new Set<PreviewWorkflowListener>();
  // Product sessions stay warm while the IDE tab is open. Short TTLs caused
  // intermittent "stale preview session" once the iframe went quiet.
  const sessions = createPreviewSessionRegistry({ ttlMs: options.ttlMs ?? 24 * 60 * 60 * 1000 });
  const relay = createPreviewRelay({ sessions, timeoutMs: options.relayTimeoutMs ?? 1500 });
  let sessionHeartbeat: ReturnType<typeof setInterval> | null = null;
  const state: PreviewWorkflowState = {
    phase: PHASES.idle,
    project: null,
    editor: null,
    workflow: null,
    install: null,
    build: null,
    session: null,
    previewUrl: null,
    hmr: null,
    hmrState: "idle",
    health: null,
    source: null,
    packageManagerOverride: null,
    sessions,
    relay,
    serviceWorker: createPreviewServiceWorker({ relay }),
    lastError: null,
    logs: [],
    diagnostics: [],
    fetchBridgeBound: false,
    previewErrorBridge: false,
    reliability: createPreviewReliabilitySession(),
    lastPreviewPort: options.previewPort ?? 5173
  };

  function stopSessionHeartbeat(): void {
    if (sessionHeartbeat !== null) {
      clearInterval(sessionHeartbeat);
      sessionHeartbeat = null;
    }
  }

  function startSessionHeartbeat(): void {
    stopSessionHeartbeat();
    if (typeof setInterval !== "function") return;
    sessionHeartbeat = setInterval(() => {
      try {
        ensureLiveSession({ quiet: true });
      } catch {
        /* ignore idle heartbeat failures */
      }
    }, 20_000);
  }

  function bindPreviewSession(port: number): PreviewSession {
    if (state.session) state.sessions.delete(state.session.sessionId);
    state.lastPreviewPort = port;
    state.session = state.sessions.create({
      origin: location.origin,
      projectId: state.workflow?.projectId || state.project?.projectId || "preview-service",
      port,
      container: createWorkflowPreviewContainer(() => state.workflow)
    });
    state.previewUrl = createPreviewUrl(state.session, "/");
    startSessionHeartbeat();
    return state.session;
  }

  function ensureLiveSession(opts: { quiet?: boolean } = {}): PreviewSession {
    if (!state.workflow) throw new Error("Load a template before serving preview");
    const port = state.session?.port || state.lastPreviewPort || 5173;
    if (state.session) {
      const live = state.sessions.get(state.session.sessionId, {
        origin: location.origin,
        projectId: state.workflow.projectId
      });
      if (live) {
        state.session = live;
        state.previewUrl = createPreviewUrl(live, "/");
        return live;
      }
      if (!opts.quiet) log("preview session expired; rebinding");
    }
    return bindPreviewSession(port);
  }

  function emit(type: PreviewWorkflowEventType, detail: Record<string, unknown> = {}): void {
    const snapshot = getSnapshot();
    for (const listener of listeners) listener({ type, detail, snapshot });
  }

  function log(line: unknown): void {
    const text = typeof line === "string" ? line : JSON.stringify(line);
    state.logs.push(text);
    if (state.logs.length > 400) state.logs.splice(0, state.logs.length - 400);
    emit("log", { line: text });
  }

  function setPhase(phase: PreviewWorkflowPhase): void {
    state.phase = phase;
    emit("phase", { phase });
  }

  function applyStorageDiagnostic(error: unknown): void {
    const diagnostic = state.reliability.handleStorageError(error);
    if (!diagnostic) return;
    const plan = state.reliability.createRecoveryPlan([diagnostic]);
    state.diagnostics = [{
      code: diagnostic.code,
      message: diagnostic.remediation ? `${diagnostic.message} ${diagnostic.remediation}` : diagnostic.message,
      level: diagnostic.severity,
      recoveryActions: plan.actions.map((action) => ({
        kind: action.kind,
        label: action.label
      }))
    }];
    setPhase(PHASES.failed);
    emit("diagnostic", { diagnostic });
  }

  try {
    state.reliability.acquireWriter();
  } catch (error) {
    applyStorageDiagnostic(error);
  }

  function mapErrorStage(source: string): PreviewErrorStage {
    if (source === "build" || source === "hmr") return source;
    return "runtime";
  }

  function setError(error: unknown, source = "workflow"): PreviewDiagnostic {
    const message = error instanceof Error ? error.message : String(error);
    const lastError: PreviewWorkflowLastError = {
      source,
      message,
      ...(error instanceof Error && error.stack ? { stack: error.stack } : {})
    };
    state.lastError = lastError;
    const diagnostic = createVitePreviewErrorDiagnostic({
      source: mapErrorStage(source),
      error: error instanceof Error ? error : new Error(message),
      command: source === "build" ? "pnpm run build" : "pnpm run dev"
    });
    state.diagnostics = [diagnostic];
    setPhase(PHASES.failed);
    emit("error", { error: state.lastError, diagnostic });
    return diagnostic;
  }

  function clearRuntime(): void {
    stopSessionHeartbeat();
    try { state.hmr?.close(); } catch { /* ignore */ }
    try { state.workflow?.stopDevServer(); } catch { /* ignore */ }
    if (state.session) state.sessions.delete(state.session.sessionId);
    state.hmr = null;
    state.hmrState = "idle";
    state.session = null;
    state.previewUrl = null;
    state.install = null;
    state.build = null;
    state.lastError = null;
    state.diagnostics = [];
    state.health = null;
    state.source = null;
    state.project = null;
    state.editor = null;
    state.workflow = null;
  }

  function attachEditor(project: ProjectWorkspaceStore, workflow: ProductWorkflow): void {
    const editor = createProjectWorkspaceEditorBridge(project, {
      onChange(event: ProjectWorkspaceEditorChangeEvent) {
        emit("editor-change", { event });
      },
      onSave(event: ProjectWorkspaceEditorSaveEvent) {
        if (!state.workflow) return;
        try {
          const relative = event.relativePath || event.path.slice(workflow.projectRoot.length + 1);
          const result = state.workflow.applySourceEdit(relative, event.data);
          log(`hmr update ${relative}`);
          emit("hmr-update", { result });
        } catch (error) {
          setError(error, "hmr");
        }
      }
    });

    createProjectWorkspaceDevServerChangeBridge(workflow, {
      root: workflow.projectRoot,
      onDiagnostic(diagnostic) {
        const action: PreviewRecoveryAction = {
          kind: "restart-dev-server",
          label: "Restart dev server"
        };
        state.diagnostics = [{
          code: diagnostic.code,
          message: diagnostic.message,
          file: diagnostic.file,
          level: "warning",
          recoveryActions: [action]
        }];
        emit("diagnostic", { diagnostic });
      }
    });

    state.project = project;
    state.editor = editor;
  }

  function applyMaterializedProject(
    materialized: MaterializedProject,
    loadOptions: { label?: string; templateId?: TemplateId; workflowTemplate?: "react" | "vanilla" | "next" } = {}
  ): PreviewWorkflowSnapshot {
    const label = loadOptions.label ?? "cargo";
    clearRuntime();
    state.health = materialized.health;
    state.source = materialized.source;
    state.diagnostics = materialized.health.diagnostics.map((entry) => {
      const diagnostic: PreviewWorkflowUiDiagnostic = {
        code: entry.code,
        message: entry.recoveryHint ? `${entry.message} ${entry.recoveryHint}` : entry.message,
        level: entry.level
      };
      if (entry.recoveryHint) {
        diagnostic.recoveryActions = [{ kind: "show-terminal", label: "Review guidance" }];
      }
      return diagnostic;
    });

    if (!materialized.health.ok) {
      state.project = materialized.store;
      state.editor = createProjectWorkspaceEditorBridge(materialized.store);
      setPhase(PHASES.failed);
      log(`import failed source=${materialized.source}`);
      emit("import-failed", { health: materialized.health });
      return getSnapshot();
    }

    const manager: ViteProductPackageManager = state.packageManagerOverride
      || materialized.health.detection.packageManager
      || "pnpm";
    const kind = loadOptions.workflowTemplate
      || (loadOptions.templateId ? workflowTemplateForProjectTemplate(loadOptions.templateId) : null)
      || detectWorkflowKind(materialized)
      || "vanilla";

    const workflow: ProductWorkflow = kind === "next"
      ? new NextProductWorkflow({
        manager,
        projectId: materialized.store.projectId || "preview-service",
        projectRoot: materialized.store.root || "/workspace/app",
        initialTitle: label === "cargo" ? "Next.js" : label,
        port: options.previewPort ?? 3000
      })
      : new ViteProductWorkflow({
        manager,
        template: kind === "react" ? "react" : "vanilla",
        projectId: materialized.store.projectId || "preview-service",
        projectRoot: materialized.store.root || "/workspace/app",
        initialLabel: label,
        port: options.previewPort ?? 5173
      });

    // Drop scaffold leftovers so the selected template owns the workspace.
    removeConflictingScaffoldFiles(workflow, materialized.files.map((file) => file.path));

    for (const file of materialized.files) {
      if (
        !SOURCE_FILE_RE.test(file.path)
        && file.path !== "package.json"
        && file.path !== "index.html"
        && !file.path.endsWith(".js")
        && !file.path.endsWith(".css")
      ) {
        continue;
      }
      try {
        workflow.workspace.writeText(`${workflow.projectRoot}/${file.path}`, file.data);
      } catch {
        /* ignore unwritable seed paths */
      }
    }

    state.workflow = workflow;
    attachEditor(materialized.store, workflow);
    setPhase(PHASES.templateLoaded);
    log(`loaded ${materialized.source} project (${manager}, ${kind})`);
    emit("template-loaded", {
      projectId: workflow.projectId,
      source: materialized.source,
      health: materialized.health,
      workflowTemplate: kind
    });
    return getSnapshot();
  }

  function detectWorkflowKind(materialized: MaterializedProject): "react" | "vanilla" | "next" {
    const paths = new Set(materialized.files.map((file) => file.path));
    const packageJson = materialized.files.find((file) => file.path === "package.json")?.data || "";
    if (packageJson.includes("\"next\"") || [...paths].some((path) => path.startsWith("app/") || path.startsWith("pages/"))) {
      return "next";
    }
    if ([...paths].some((path) => /\.(?:jsx|tsx)$/.test(path))) return "react";
    return "vanilla";
  }

  function removeConflictingScaffoldFiles(
    workflow: ProductWorkflow,
    keepRelativePaths: string[]
  ): void {
    const keep = new Set(keepRelativePaths.map((path) => path.replace(/^\/+/, "")));
    const candidates = [
      "index.html",
      "vite.config.ts",
      "vite.config.js",
      "next.config.ts",
      "next.config.js",
      "src/main.jsx",
      "src/main.tsx",
      "src/main.js",
      "src/main.ts",
      "src/App.tsx",
      "src/App.jsx",
      "src/App.css",
      "src/index.css",
      "src/message.js",
      "src/message.ts",
      "src/App.svelte",
      "src/style.css",
      "app/page.tsx",
      "app/page.jsx",
      "app/page.js",
      "app/layout.tsx",
      "app/layout.jsx",
      "app/globals.css",
      "dev.js",
      "build.js"
    ];
    for (const relative of candidates) {
      if (keep.has(relative)) continue;
      const absolute = `${workflow.projectRoot}/${relative}`;
      try {
        if (workflow.workspace.exists(absolute)) workflow.workspace.remove(absolute);
      } catch {
        /* ignore missing/unremovable leftovers */
      }
    }
  }

  function packageOverrides(): { packageManager: SupportedPackageManager } | undefined {
    return state.packageManagerOverride
      ? { packageManager: state.packageManagerOverride }
      : undefined;
  }

  function setPackageManagerOverride(value: SupportedPackageManager | null | ""): void {
    state.packageManagerOverride = value || null;
    emit("override", { packageManagerOverride: state.packageManagerOverride });
  }

  function loadViteReactTemplate(loadOptions: { label?: string } = {}): PreviewWorkflowSnapshot {
    return loadTemplate("vite-react", loadOptions);
  }

  function loadTemplate(
    templateId: TemplateId = "vite-react",
    loadOptions: { label?: string } = {}
  ): PreviewWorkflowSnapshot {
    const overrides = packageOverrides();
    const materialized = materializeTemplate(templateId, {
      projectId: "preview-service",
      root: "/workspace/app",
      ...(overrides ? { overrides } : {})
    });
    return applyMaterializedProject(materialized, {
      ...loadOptions,
      templateId,
      workflowTemplate: workflowTemplateForProjectTemplate(templateId)
    });
  }

  async function importZipFile(file: Blob): Promise<PreviewWorkflowSnapshot> {
    const bytes = new Uint8Array(await file.arrayBuffer());
    const overrides = packageOverrides();
    const materialized = materializeZip(bytes, {
      projectId: "preview-service-zip",
      root: "/workspace/app",
      ...(overrides ? { overrides } : {})
    });
    return applyMaterializedProject(materialized);
  }

  async function importGitHub(url: string): Promise<PreviewWorkflowSnapshot> {
    const overrides = packageOverrides();
    const materialized = await materializeGitHubUrl(url, {
      projectId: "preview-service-github",
      root: "/workspace/app",
      ...(overrides ? { overrides } : {})
    });
    return applyMaterializedProject(materialized);
  }

  function exportZip(): Uint8Array {
    if (!state.project) throw new Error("No project to export");
    return exportMaterializedProjectZip(state.project, state.project.projectId || "project");
  }

  function exportTreeJson(path?: string): FileSystemTree {
    if (!state.project) throw new Error("No project to export");
    const root = state.project.root;
    const prefix = normalizeExportPrefix(path);
    const tree: FileSystemTree = {};
    for (const file of state.project.listFiles()) {
      const relative = relativeProjectPath(file.path, root);
      if (!relative) continue;
      if (prefix) {
        if (relative !== prefix && !relative.startsWith(`${prefix}/`)) continue;
        const trimmed = relative === prefix ? pathBasename(relative) : relative.slice(prefix.length + 1);
        if (!trimmed) continue;
        insertFileSystemTreeEntry(tree, trimmed, file.data);
        continue;
      }
      insertFileSystemTreeEntry(tree, relative, file.data);
    }
    return tree;
  }

  function exportPathZip(relativePath: string): Uint8Array {
    if (!state.project) throw new Error("No project to export");
    const prefix = normalizeExportPrefix(relativePath);
    if (!prefix) throw new Error("exportPathZip requires a relative path");
    const files = state.project.listFiles()
      .map((file) => ({
        path: relativeProjectPath(file.path, state.project!.root),
        data: file.data
      }))
      .filter((file) => file.path === prefix || file.path.startsWith(`${prefix}/`))
      .map((file) => ({
        path: file.path === prefix ? pathBasename(file.path) : file.path.slice(prefix.length + 1),
        data: file.data
      }))
      .filter((file) => Boolean(file.path));
    if (files.length === 0) throw new Error(`No files found under ${prefix}`);
    return exportProjectZip({
      rootDirectory: state.project.projectId || "project",
      files
    });
  }

  function setPreviewErrorBridge(enabled: boolean): void {
    state.previewErrorBridge = Boolean(enabled);
  }

  function getChangeStatus(): PreviewChangeStatus {
    const dirty = (state.editor?.dirtyFiles() || [])
      .map((file) => relativeProjectPath(file.path, state.project?.root || ""))
      .filter(Boolean)
      .sort((left, right) => left.localeCompare(right));
    const hasGitMarker = projectHasGitMarker(state.project);
    return {
      dirty,
      untrackedHint: hasGitMarker
        ? "Editor dirty buffers only (not git status); .git marker present in project store."
        : "Editor dirty buffers only — not a real git working tree.",
      hasGitMarker
    };
  }

  async function ensureServiceWorker(): Promise<ServiceWorkerRegistration> {
    if (!("serviceWorker" in navigator)) {
      throw new Error("Service workers are unavailable in this browser session");
    }
    const registration = await navigator.serviceWorker.register("/preview-sw.js", { scope: "/" });
    await navigator.serviceWorker.ready;
    return registration;
  }

  function bindPreviewFetchBridge(): void {
    if (state.fetchBridgeBound) return;
    navigator.serviceWorker?.addEventListener("message", onServiceWorkerMessage);
    state.fetchBridgeBound = true;
  }

  async function onServiceWorkerMessage(event: MessageEvent): Promise<void> {
    const data = event.data as { type?: string; path?: string; method?: string } | null;
    if (data?.type !== "preview-sw:fetch") return;
    const port = event.ports[0];
    if (!port) return;
    try {
      if (!state.workflow) {
        port.postMessage({
          status: 503,
          headers: { "content-type": "text/plain; charset=utf-8" },
          body: "Preview workflow is not running."
        });
        return;
      }
      const session = ensureLiveSession({ quiet: true });
      const previewPath = stripPreviewPrefix(data.path || "/", session);
      let response: Response;
      try {
        response = await state.relay.request({
          sessionId: session.sessionId,
          origin: location.origin,
          projectId: state.workflow.projectId,
          path: previewPath,
          method: data.method || "GET"
        });
      } catch (error) {
        if (!(error instanceof PreviewRelayError) || error.code !== "ESTALESESSION") throw error;
        const rebound = ensureLiveSession();
        response = await state.relay.request({
          sessionId: rebound.sessionId,
          origin: location.origin,
          projectId: state.workflow.projectId,
          path: stripPreviewPrefix(data.path || "/", rebound),
          method: data.method || "GET"
        });
      }
      port.postMessage(await normalizeRelayResponse(response));
    } catch (error) {
      const diagnostic = setError(error, "preview");
      port.postMessage({
        status: 502,
        headers: { "content-type": "text/plain; charset=utf-8" },
        body: diagnostic.message
      });
    }
  }

  function stripPreviewPrefix(pathname: string, session: PreviewSession): string {
    const base = new URL(session.baseUrl).pathname;
    if (pathname.startsWith(base)) {
      const rest = pathname.slice(base.length);
      return rest ? `/${rest}` : "/";
    }
    return "/";
  }

  function createWorkflowPreviewContainer(getWorkflow: () => ProductWorkflow | null): PreviewContainer {
    return {
      async fetch(input: string) {
        const workflow = getWorkflow();
        if (!workflow) {
          return new Response("Preview workflow is not running.", {
            status: 503,
            headers: { "content-type": "text/plain; charset=utf-8" }
          });
        }
        const url = new URL(input, "http://127.0.0.1");
        const preview = workflow.preview(`${url.pathname}${url.search}`);
        const headers = preview.headers || { "content-type": "text/html; charset=utf-8" };
        const contentType = headers["content-type"] || headers["Content-Type"];
        const body = maybeInjectPreviewErrorBridge(preview.body || "", contentType);
        return new Response(body, {
          status: preview.statusCode,
          headers
        });
      }
    };
  }

  async function normalizeRelayResponse(response: unknown): Promise<NormalizedRelayResponse> {
    const corpHeaders = {
      "Cross-Origin-Resource-Policy": "same-origin",
      "Cross-Origin-Embedder-Policy": "require-corp"
    };
    if (response && typeof response === "object" && "text" in response && typeof (response as Response).text === "function") {
      const webResponse = response as Response;
      const headers: Record<string, string> = {
        "content-type": "text/html; charset=utf-8",
        ...corpHeaders,
        ...(headersToObject(webResponse.headers) || {})
      };
      return {
        status: webResponse.status || 500,
        headers,
        body: maybeInjectPreviewErrorBridge(await webResponse.text(), headers["content-type"] || headers["Content-Type"])
      };
    }
    const legacy = response as {
      statusCode?: number;
      status?: number;
      headers?: Record<string, string>;
      body?: string;
    };
    const headers: Record<string, string> = {
      "content-type": "text/html; charset=utf-8",
      ...corpHeaders,
      ...(legacy.headers || {})
    };
    return {
      status: legacy.statusCode || legacy.status || 500,
      headers,
      body: maybeInjectPreviewErrorBridge(legacy.body || "", headers["content-type"] || headers["Content-Type"])
    };
  }

  function maybeInjectPreviewErrorBridge(body: string, contentType: string | undefined): string {
    if (!state.previewErrorBridge) return body;
    if (!shouldInjectPreviewErrorBridge(contentType)) return body;
    return injectPreviewErrorBridge(body);
  }

  function headersToObject(headers: Headers | Record<string, string> | null | undefined): Record<string, string> | null {
    if (!headers) return null;
    const out: Record<string, string> = {};
    if (typeof (headers as Headers).forEach === "function") {
      (headers as Headers).forEach((value, key) => {
        out[key] = value;
      });
      return out;
    }
    return { ...(headers as Record<string, string>) };
  }

  async function connectHmr(): Promise<HmrClientSnapshot> {
    if (!state.workflow) throw new Error("Load a template before connecting HMR");
    try { state.hmr?.close(); } catch { /* ignore */ }
    const workflow = state.workflow;
    const hmr = createHmrClient({
      maxRetries: 3,
      connect: () => workflow.connectHmr()
    });
    hmr.on("open", () => {
      state.hmrState = "connected";
      if (state.phase === PHASES.previewReady || state.phase === PHASES.hmrConnected) {
        setPhase(PHASES.hmrConnected);
      }
      emit("hmr", { state: state.hmrState });
    });
    hmr.on("reconnect", () => {
      state.hmrState = "reconnecting";
      emit("hmr", { state: state.hmrState });
    });
    hmr.on("close", () => {
      state.hmrState = "closed";
      emit("hmr", { state: state.hmrState });
    });
    hmr.on("error", (payload) => {
      const event = payload as HmrClientError;
      state.hmrState = "error";
      setError(new Error(event?.message || "HMR connection failed"), "hmr");
    });
    state.hmr = hmr;
    hmr.start();
    return hmr.snapshot();
  }

  async function runPreview(): Promise<PreviewWorkflowSnapshot> {
    if (!state.workflow) loadTemplate("vite-react");
    if (!state.workflow) throw new Error("Failed to load preview workflow");
    if (state.health && !state.health.ok) {
      throw new Error(
        state.health.diagnostics.find((entry) => entry.level === "error")?.message
          || "Project health check failed"
      );
    }
    try {
      setPhase(PHASES.installing);
      log("install start");
      state.install = state.workflow.install();
      log(`install ok packages=${state.install.packages.join(",")}`);
      setPhase(PHASES.installed);

      setPhase(PHASES.startingDev);
      const dev = state.workflow.startDevServerFromPackageScript("dev");
      log(`dev server ready :${dev.port}`);

      await ensureServiceWorker();
      bindPreviewFetchBridge();

      bindPreviewSession(dev.port);
      setPhase(PHASES.previewReady);
      await connectHmr();
      emit("preview-ready", { previewUrl: state.previewUrl, sessionId: state.session?.sessionId });
      return getSnapshot();
    } catch (error) {
      setError(error, "preview");
      throw error;
    }
  }

  async function restartDev(): Promise<PreviewWorkflowSnapshot> {
    if (!state.workflow) throw new Error("No running workflow to restart");
    try {
      setPhase(PHASES.startingDev);
      const recovery = state.workflow.restart();
      log(`dev restarted preview=${String(recovery.previewAfterRestart || "").slice(0, 48)}`);
      const port = state.session?.port || state.lastPreviewPort || 5173;
      if (state.session) {
        const replaced = state.sessions.replace(state.session.sessionId, {
          port,
          serverState: "running",
          lastErrorCode: null,
          container: createWorkflowPreviewContainer(() => state.workflow)
        });
        if (replaced) {
          state.session = replaced;
          state.previewUrl = createPreviewUrl(replaced, "/");
          startSessionHeartbeat();
        } else {
          bindPreviewSession(port);
        }
      } else {
        bindPreviewSession(port);
      }
      setPhase(PHASES.previewReady);
      await connectHmr();
      emit("preview-ready", { previewUrl: state.previewUrl, restarted: true });
      return getSnapshot();
    } catch (error) {
      setError(error, "preview");
      throw error;
    }
  }

  async function reconnectHmr(): Promise<HmrClientSnapshot> {
    const snapshot = await connectHmr();
    log(`hmr reconnect -> ${snapshot.state}`);
    return snapshot;
  }

  async function runBuild(): Promise<PreviewWorkflowSnapshot> {
    if (!state.workflow) throw new Error("Load a template before building");
    try {
      setPhase(PHASES.building);
      state.build = state.workflow.buildFromPackageScript("build");
      log(`build ok files=${state.build.files.join(",")}`);
      setPhase(PHASES.built);
      emit("build", { build: state.build });
      return getSnapshot();
    } catch (error) {
      setError(error, "build");
      throw error;
    }
  }

  function clearPackageCache(): { freedBytes: number; evicted: number } {
    const result = state.reliability.clearPackageCache();
    log(`cleared package cache freedBytes=${result.freedBytes} evicted=${result.evicted}`);
    if (state.phase === PHASES.failed && state.diagnostics.some((entry) => entry.code === "EOPFSQUOTA")) {
      setPhase(state.workflow ? PHASES.templateLoaded : PHASES.idle);
      state.diagnostics = [];
      state.lastError = null;
    }
    emit("log", { line: "cache-cleared", result });
    return result;
  }

  function resolveWriterConflict(): void {
    state.reliability.forceTakeWriter();
    log(`writer lease acquired owner=${state.reliability.owner}`);
    if (state.diagnostics.some((entry) => entry.code === "ELEASEHELD")) {
      setPhase(state.workflow ? PHASES.templateLoaded : PHASES.idle);
      state.diagnostics = [];
      state.lastError = null;
    }
    emit("log", { line: "writer-lease-resolved" });
  }

  function simulateQuotaPressure(bytes = 4096): void {
    state.reliability = createPreviewReliabilitySession({
      policy: {
        storage: {
          quotaBytesDefault: 2048,
          evictionPrefixes: ["cache/", "packages/"],
          protectedPrefixes: ["projects/"],
          writerLeaseTtlMs: 30_000
        }
      }
    });
    state.reliability.acquireWriter();
    state.reliability.writeCacheFile("projects/keep.json", "protected");
    try {
      state.reliability.writeCacheFile("cache/pressure.json", "x".repeat(bytes));
    } catch (error) {
      applyStorageDiagnostic(error);
      throw error;
    }
  }

  async function runRecoveryAction(kind: RuntimeRecoveryActionKind | string): Promise<unknown> {
    if (kind === "clear-cache") return clearPackageCache();
    if (kind === "resolve-writer-conflict") {
      resolveWriterConflict();
      return { owner: state.reliability.owner };
    }
    if (kind === "reset-runtime") return restartDev();
    if (kind === "retry") return runPreview();
    if (kind === "restart-dev-server") return restartDev();
    if (kind === "rerun-build") return runBuild();
    throw new Error(`Unsupported recovery action: ${kind}`);
  }

  const shell: PreviewShellSession = createPreviewShellSession({
    getCwd: () => state.workflow?.projectRoot || state.project?.root || "/workspace/app",
    getProject: () => state.project,
    onChunk(chunk) {
      log(`[${chunk.stream}] ${chunk.data.replace(/\n$/, "")}`);
    },
    async install() {
      if (!state.workflow) loadTemplate("vite-react");
      if (!state.workflow) return { stdout: "", stderr: "no workflow\n", exitCode: 1 };
      try {
        setPhase(PHASES.installing);
        state.install = state.workflow.install();
        setPhase(PHASES.installed);
        const stdout = `install ok packages=${state.install.packages.join(",")}\n`;
        log(stdout.trim());
        return { stdout, stderr: "", exitCode: 0 };
      } catch (error) {
        setError(error, "preview");
        return {
          stdout: "",
          stderr: `${error instanceof Error ? error.message : String(error)}\n`,
          exitCode: 1
        };
      }
    },
    async runDev() {
      try {
        await runPreview();
        return {
          stdout: `dev server ready ${state.previewUrl || ""}\n`,
          stderr: "",
          exitCode: 0
        };
      } catch (error) {
        return {
          stdout: "",
          stderr: `${error instanceof Error ? error.message : String(error)}\n`,
          exitCode: 1
        };
      }
    },
    async runBuild() {
      try {
        await runBuild();
        return {
          stdout: `build ok files=${(state.build?.files || []).join(",")}\n`,
          stderr: "",
          exitCode: 0
        };
      } catch (error) {
        return {
          stdout: "",
          stderr: `${error instanceof Error ? error.message : String(error)}\n`,
          exitCode: 1
        };
      }
    },
    async restartDev() {
      try {
        await restartDev();
        return {
          stdout: `dev restarted ${state.previewUrl || ""}\n`,
          stderr: "",
          exitCode: 0
        };
      } catch (error) {
        return {
          stdout: "",
          stderr: `${error instanceof Error ? error.message : String(error)}\n`,
          exitCode: 1
        };
      }
    }
  });

  async function runShellCommand(command: string): Promise<TerminalRunResult> {
    const trimmed = command.trim();
    if (!trimmed) {
      return {
        stdout: "",
        stderr: "",
        exitCode: 0,
        files: {},
        entry: {
          id: 0,
          command: "",
          cwd: state.workflow?.projectRoot || state.project?.root || "/workspace/app",
          exitCode: 0,
          finishedAt: Date.now(),
          startedAt: Date.now(),
          status: "completed",
          stderr: "",
          stdout: ""
        }
      };
    }
    log(`$ ${trimmed}`);
    try {
      const result = await shell.run(trimmed);
      emit("log", { line: "shell", command: trimmed, exitCode: result.exitCode });
      return result;
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      log(`shell error: ${message}`);
      throw error;
    }
  }

  function cancelShellCommand(): boolean {
    return shell.cancel();
  }

  function getSnapshot(): PreviewWorkflowSnapshot {
    return {
      phase: state.phase,
      projectId: state.workflow?.projectId || state.project?.projectId || null,
      manager: state.workflow?.manager || state.health?.detection.packageManager || null,
      template: state.workflow?.template || null,
      source: state.source,
      health: state.health,
      packageManagerOverride: state.packageManagerOverride,
      previewUrl: state.previewUrl,
      hmrState: state.hmrState,
      install: state.install,
      build: state.build,
      lastError: state.lastError,
      diagnostics: state.diagnostics.map((entry) => ({ ...entry })),
      logs: [...state.logs],
      editor: state.editor,
      project: state.project,
      workflow: state.workflow,
      session: state.session
    };
  }

  return {
    on(listener) {
      listeners.add(listener);
      return () => listeners.delete(listener);
    },
    getSnapshot,
    loadViteReactTemplate,
    loadTemplate,
    importZipFile,
    importGitHub,
    exportZip,
    exportTreeJson,
    exportPathZip,
    setPackageManagerOverride,
    setPreviewErrorBridge,
    getChangeStatus,
    runPreview,
    restartDev,
    reconnectHmr,
    runBuild,
    ensureServiceWorker,
    clearPackageCache,
    resolveWriterConflict,
    runRecoveryAction,
    simulateQuotaPressure,
    runShellCommand,
    cancelShellCommand,
    log
  };
}

function normalizeExportPrefix(path?: string): string {
  if (!path) return "";
  return path.replace(/^\/+|\/+$/g, "").replace(/^\.\//, "");
}

function relativeProjectPath(path: string, root: string): string {
  const normalizedRoot = root.replace(/\/+$/, "");
  if (!normalizedRoot) return path.replace(/^\/+/, "");
  if (path === normalizedRoot) return "";
  if (path.startsWith(`${normalizedRoot}/`)) return path.slice(normalizedRoot.length + 1);
  return path.replace(/^\/+/, "");
}

function pathBasename(path: string): string {
  const parts = path.split("/").filter(Boolean);
  return parts.at(-1) || path;
}

function insertFileSystemTreeEntry(tree: FileSystemTree, relativePath: string, contents: string): void {
  const segments = relativePath.split("/").filter(Boolean);
  if (segments.length === 0) return;
  let cursor = tree;
  for (let index = 0; index < segments.length; index += 1) {
    const name = segments[index]!;
    const isFile = index === segments.length - 1;
    if (isFile) {
      cursor[name] = { file: { contents } };
      return;
    }
    const existing = cursor[name];
    if (!existing || !("directory" in existing)) {
      cursor[name] = { directory: {} };
    }
    const node = cursor[name];
    if (!node || !("directory" in node)) return;
    cursor = node.directory;
  }
}

function projectHasGitMarker(project: ProjectWorkspaceStore | null): boolean {
  if (!project) return false;
  for (const file of project.listFiles()) {
    const relative = relativeProjectPath(file.path, project.root);
    if (relative === ".git" || relative.startsWith(".git/")) return true;
  }
  return false;
}
