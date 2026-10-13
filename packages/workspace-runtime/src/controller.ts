import {
  createProjectWorkspaceDevServerChangeBridge,
  createProjectWorkspaceEditorBridge,
  decodeProjectWorkspaceArchive,
  ProjectWorkspaceEditorBridge,
  ProjectWorkspaceStore,
  type ProjectWorkspaceEditorChangeEvent,
  type ProjectWorkspaceEditorSaveEvent
} from "../../browser-host/src/storage/index.ts";
import {
  exportMaterializedProjectZip,
  exportProjectZip,
  createProjectHealthCheck,
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
  NextProductWorkflow
} from "../../node-runtime/src/frameworks/next-workflow.ts";
import {
  ViteProductWorkflow,
  type ViteProductPackageManager
} from "../../node-runtime/src/frameworks/vite-workflow.ts";

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
import {
  injectPreviewErrorBridge,
  shouldInjectPreviewErrorBridge
} from "./preview-inject.ts";
import type { RuntimeRecoveryActionKind } from "../../browser-host/src/observability/recovery-actions.ts";
import { PHASES } from "./controller-contracts.ts";
import type {
  FileSystemTree,
  PreviewChangeStatus,
  PreviewWorkflowController,
  PreviewWorkflowControllerOptions,
  PreviewWorkflowEventType,
  PreviewWorkflowLastError,
  PreviewWorkflowListener,
  PreviewWorkflowPhase,
  PreviewProjectFile,
  PreviewProjectFileInput,
  PreviewWorkflowSnapshot,
  PreviewWorkflowUiDiagnostic,
  ProductBuildResult,
  ProductInstallResult,
  ProductWorkflow
} from "./controller-contracts.ts";
import { createPreviewShellLifecycle } from "./shell-lifecycle.ts";
export { PHASES } from "./controller-contracts.ts";
export type {
  FileSystemTree,
  PreviewChangeStatus,
  PreviewWorkflowController,
  PreviewWorkflowControllerOptions,
  PreviewWorkflowEvent,
  PreviewWorkflowEventType,
  PreviewWorkflowLastError,
  PreviewWorkflowListener,
  PreviewWorkflowPhase,
  PreviewProjectFile,
  PreviewProjectFileInput,
  PreviewWorkflowSnapshot,
  PreviewWorkflowUiDiagnostic
} from "./controller-contracts.ts";

interface PreviewWorkflowState {
  phase: PreviewWorkflowPhase;
  project: ProjectWorkspaceStore | null;
  projectFiles: PreviewProjectFile[];
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

const MAX_IMPORTED_PROJECT_FILES = 256;
const MAX_IMPORTED_PROJECT_FILE_BYTES = 1024 * 1024;
const MAX_IMPORTED_PROJECT_TOTAL_BYTES = 8 * 1024 * 1024;
const MAX_IMPORTED_PROJECT_PATH_BYTES = 512;
const MAX_IMPORTED_PROJECT_PATH_SEGMENTS = 32;
const MAX_IMPORTED_PROJECT_PATH_SEGMENT_BYTES = 255;

export function createPreviewWorkflowController(
  options: PreviewWorkflowControllerOptions = {}
): PreviewWorkflowController {
  const listeners = new Set<PreviewWorkflowListener>();
  let disposed = false;
  let disposeComplete = false;
  let operationGeneration = 0;
  const operationControllers = new Set<AbortController>();
  // Product sessions stay warm while the IDE tab is open. Short TTLs caused
  // intermittent "stale preview session" once the iframe went quiet.
  const sessions = createPreviewSessionRegistry({ ttlMs: options.ttlMs ?? 24 * 60 * 60 * 1000 });
  const relay = createPreviewRelay({ sessions, timeoutMs: options.relayTimeoutMs ?? 1500 });
  let sessionHeartbeat: ReturnType<typeof setInterval> | null = null;
  const state: PreviewWorkflowState = {
    phase: PHASES.idle,
    project: null,
    projectFiles: [],
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
    state.projectFiles = [];
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
    const label = loadOptions.label ?? "nuriteo";
    clearRuntime();
    state.projectFiles = materialized.files.map((file) => ({
      path: file.path,
      kind: "text",
      bytes: new TextEncoder().encode(file.data)
    }));
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
        initialTitle: label === "nuriteo" ? "Next.js" : label,
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
      projectId: options.workspaceProjectId ?? "preview-service",
      root: options.workspaceRoot ?? "/workspace/app",
      ...(overrides ? { overrides } : {})
    });
    return applyMaterializedProject(materialized, {
      ...loadOptions,
      templateId,
      workflowTemplate: workflowTemplateForProjectTemplate(templateId)
    });
  }

  async function importZipFile(file: Blob): Promise<PreviewWorkflowSnapshot> {
    const operation = beginOperation();
    try {
      const bytes = new Uint8Array(await file.arrayBuffer());
      assertOperationActive(operation);
      const overrides = packageOverrides();
      const materialized = materializeZip(bytes, {
        projectId: options.workspaceProjectId ?? "preview-service-zip",
        root: options.workspaceRoot ?? "/workspace/app",
        ...(overrides ? { overrides } : {})
      });
      return applyMaterializedProject(materialized);
    } finally { operationControllers.delete(operation); }
  }

  async function importGitHub(url: string): Promise<PreviewWorkflowSnapshot> {
    const operation = beginOperation();
    try {
      const overrides = packageOverrides();
      const materialized = await materializeGitHubUrl(url, {
        projectId: options.workspaceProjectId ?? "preview-service-github",
        root: options.workspaceRoot ?? "/workspace/app",
        ...(overrides ? { overrides } : {})
      });
      assertOperationActive(operation);
      return applyMaterializedProject(materialized);
    } finally { operationControllers.delete(operation); }
  }

  async function bootSnapshot(
    input: Blob | Uint8Array | ArrayBuffer | string
  ): Promise<PreviewWorkflowSnapshot> {
    const operation = beginOperation();
    try {
    const bytes = input instanceof Blob ? new Uint8Array(await input.arrayBuffer()) : input;
    assertOperationActive(operation);
    const archive = decodeProjectWorkspaceArchive(bytes);
    const restored = new ProjectWorkspaceStore({
      projectId: archive.snapshot.projectId,
      root: archive.snapshot.root,
      metadata: archive.snapshot.metadata
    });
    restored.importArchive(archive);
    const files = restored.listFiles().map((file) => ({
      path: relativeProjectPath(file.path, restored.root),
      data: file.data
    }));
    const configuredManager = restored.metadata.packageManager;
    const defaultPackageManager = configuredManager === "npm" || configuredManager === "pnpm"
      ? configuredManager
      : undefined;
    const overrides = packageOverrides();
    const health = createProjectHealthCheck({
      files,
      ...(overrides ? { overrides } : {}),
      ...(defaultPackageManager ? { defaultPackageManager } : {})
    });
    return applyMaterializedProject({
      store: restored,
      files,
      health,
      source: "snapshot"
    }, {
      label: typeof restored.metadata.name === "string" ? restored.metadata.name : "snapshot"
    });
    } finally { operationControllers.delete(operation); }
  }

  const importSnapshot = bootSnapshot;

  function importProjectFiles(
    files: readonly PreviewProjectFileInput[],
    name = "cloud project"
  ): PreviewWorkflowSnapshot {
    const root = options.workspaceRoot ?? "/workspace/app";
    const store = new ProjectWorkspaceStore({
      projectId: options.workspaceProjectId ?? "preview-service-cloud",
      root,
      metadata: { name }
    });
    const decoder = new TextDecoder("utf-8", { fatal: true });
    const projectFiles = validateImportedProjectFiles(files);
    const materializedFiles = projectFiles
      .filter((file) => file.kind === "text")
      .map((file) => ({ path: file.path, data: decoder.decode(file.bytes) }));
    for (const file of materializedFiles) store.writeText(`${root}/${file.path}`, file.data);
    const overrides = packageOverrides();
    const health = createProjectHealthCheck({
      files: materializedFiles,
      ...(overrides ? { overrides } : {})
    });
    const snapshot = applyMaterializedProject({ store, files: materializedFiles, health, source: "snapshot" }, { label: name });
    state.projectFiles = projectFiles;
    if (state.workflow) {
      for (const file of projectFiles) {
        if (file.kind === "binary") {
          state.workflow.workspace.writeBytes(`${state.workflow.projectRoot}/${file.path}`, file.bytes);
        }
      }
    }
    return snapshot;
  }

  function exportProjectFiles(): readonly PreviewProjectFile[] {
    if (!state.project) throw new Error("No project to export");
    if (!state.workflow) {
      return state.projectFiles.map((file) => ({ ...file, bytes: Uint8Array.from(file.bytes) }));
    }
    const prefix = `${state.workflow.projectRoot.replace(/\/+$/u, "")}/`;
    const admittedKind = new Map(state.projectFiles.map((file) => [file.path, file.kind]));
    return [...state.workflow.workspace.files.entries()]
      .filter(([path]) => path.startsWith(prefix))
      .map(([path, value]): PreviewProjectFile => {
        const relative = path.slice(prefix.length);
        const previousKind = admittedKind.get(relative);
        return {
          path: relative,
          kind: previousKind === "binary" ? "binary" : classifyProjectBytes(value),
          bytes: Uint8Array.from(value)
        };
      })
      .sort((left, right) => compareUtf8Path(left.path, right.path));
  }

  function exportZip(): Uint8Array {
    if (!state.project) throw new Error("No project to export");
    return exportMaterializedProjectZip(state.project, state.project.projectId || "project");
  }

  function exportSnapshot(): Uint8Array {
    if (!state.project) throw new Error("No project to export");
    return state.project.exportSnapshot();
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
    const operation = beginOperation();
    try {
      const registration = await navigator.serviceWorker.register(
        options.previewServiceWorkerUrl ?? "/preview-sw.js",
        { scope: "/" }
      );
      assertOperationActive(operation);
      await navigator.serviceWorker.ready;
      assertOperationActive(operation);
      return registration;
    } finally { operationControllers.delete(operation); }
  }

  function bindPreviewFetchBridge(): void {
    if (state.fetchBridgeBound) return;
    navigator.serviceWorker?.addEventListener("message", onServiceWorkerMessage);
    state.fetchBridgeBound = true;
  }

  async function onServiceWorkerMessage(event: MessageEvent): Promise<void> {
    if (disposed) return;
    const data = event.data as { type?: string; path?: string; method?: string } | null;
    if (data?.type !== "preview-sw:fetch") return;
    const port = event.ports[0];
    if (!port) return;
    const operation = beginOperation();
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
        assertOperationActive(operation);
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
        assertOperationActive(operation);
      }
      const normalized = await normalizeRelayResponse(response);
      assertOperationActive(operation);
      port.postMessage(normalized);
    } catch (error) {
      if (operation.signal.aborted || disposed) return;
      const diagnostic = setError(error, "preview");
      port.postMessage({
        status: 502,
        headers: { "content-type": "text/plain; charset=utf-8" },
        body: diagnostic.message
      });
    } finally { operationControllers.delete(operation); }
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
        const body = preview.body instanceof Uint8Array
          ? Uint8Array.from(preview.body).buffer
          : maybeInjectPreviewErrorBridge(preview.body || "", contentType);
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
    const operation = beginOperation();
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
      assertOperationActive(operation);
      bindPreviewFetchBridge();

      bindPreviewSession(dev.port);
      setPhase(PHASES.previewReady);
      await connectHmr();
      assertOperationActive(operation);
      emit("preview-ready", { previewUrl: state.previewUrl, sessionId: state.session?.sessionId });
      return getSnapshot();
    } catch (error) {
      if (operation.signal.aborted || disposed) throw new Error("Preview controller operation cancelled");
      setError(error, "preview");
      throw error;
    } finally {
      operationControllers.delete(operation);
    }
  }

  function saveTextFile(path: string, data: string): PreviewWorkflowSnapshot {
    if (disposed || !state.editor) throw new Error("Preview editor is unavailable");
    state.editor.editText(path, data);
    state.editor.saveFile(path);
    const relative = relativeProjectPath(path, state.project?.root || "");
    const index = state.projectFiles.findIndex((file) => file.path === relative);
    const next = { path: relative, kind: "text" as const, bytes: new TextEncoder().encode(data) };
    if (index === -1) state.projectFiles.push(next);
    else state.projectFiles[index] = next;
    return getSnapshot();
  }

  function beginOperation(): AbortController {
    if (disposed) throw new Error("Preview controller is disposed");
    const controller = new AbortController();
    operationControllers.add(controller);
    return controller;
  }

  function assertOperationActive(operation: AbortController): void {
    if (disposed || operation.signal.aborted || operationGeneration !== 0) {
      throw new Error("Preview controller operation cancelled");
    }
  }

  async function restartDev(): Promise<PreviewWorkflowSnapshot> {
    if (!state.workflow) throw new Error("No running workflow to restart");
    const operation = beginOperation();
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
      assertOperationActive(operation);
      emit("preview-ready", { previewUrl: state.previewUrl, restarted: true });
      return getSnapshot();
    } catch (error) {
      if (operation.signal.aborted || disposed) throw new Error("Preview controller operation cancelled");
      setError(error, "preview");
      throw error;
    } finally { operationControllers.delete(operation); }
  }

  async function reconnectHmr(): Promise<HmrClientSnapshot> {
    const operation = beginOperation();
    try {
      const snapshot = await connectHmr();
      assertOperationActive(operation);
      log(`hmr reconnect -> ${snapshot.state}`);
      return snapshot;
    } finally { operationControllers.delete(operation); }
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

  function stopPreviewPort(port = state.session?.port): boolean {
    if (!state.session || port === undefined || state.session.port !== port) return false;
    try { state.workflow?.stopDevServer(); } catch { /* best-effort process cleanup */ }
    state.sessions.delete(state.session.sessionId);
    stopSessionHeartbeat();
    state.session = null;
    state.previewUrl = null;
    state.hmrState = "idle";
    try { state.hmr?.close(); } catch { /* best-effort socket cleanup */ }
    state.hmr = null;
    emit("phase", { phase: state.phase, port, stopped: true });
    return true;
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
    state.reliability.releaseWriter();
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

  const shellLifecycle = createPreviewShellLifecycle({
    getCwd: () => state.workflow?.projectRoot || state.project?.root || "/workspace/app",
    getProject: () => state.project,
    terminalProcessTable: options.terminalProcessTable || null,
    log,
    onProcessFinish(command, exitCode) {
      emit("log", { line: "shell", command, exitCode });
    },
    onProcessStart(terminalId, command) {
      emit("log", { line: "shell-process-start", terminalId, command });
    },
    install: async () => {
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
    runDev: async () => {
      try {
        await runPreview();
        return { stdout: `dev server ready ${state.previewUrl || ""}\n`, stderr: "", exitCode: 0 };
      } catch (error) {
        return { stdout: "", stderr: `${error instanceof Error ? error.message : String(error)}\n`, exitCode: 1 };
      }
    },
    runBuild: async () => {
      try {
        await runBuild();
        return {
          stdout: `build ok files=${(state.build?.files || []).join(",")}\n`,
          stderr: "",
          exitCode: 0
        };
      } catch (error) {
        return { stdout: "", stderr: `${error instanceof Error ? error.message : String(error)}\n`, exitCode: 1 };
      }
    },
    restartDev: async () => {
      try {
        await restartDev();
        return { stdout: `dev restarted ${state.previewUrl || ""}\n`, stderr: "", exitCode: 0 };
      } catch (error) {
        return { stdout: "", stderr: `${error instanceof Error ? error.message : String(error)}\n`, exitCode: 1 };
      }
    }
  });
  const {
    cancelShellCommand,
    closeShell,
    dispose: disposeShellLifecycle,
    listShellProcesses,
    resizeShell,
    runShellCommand,
    signalShell,
    writeShellInput
  } = shellLifecycle;

  function dispose(): void {
    if (disposeComplete) return;
    if (!disposed) {
      disposed = true;
      operationGeneration += 1;
      for (const controller of operationControllers) controller.abort();
      operationControllers.clear();
    }
    const failures: unknown[] = [];
    try {
      if (state.fetchBridgeBound && typeof navigator !== "undefined") {
        navigator.serviceWorker?.removeEventListener("message", onServiceWorkerMessage);
        state.fetchBridgeBound = false;
      }
    } catch (error) { failures.push(error); }
    try { disposeShellLifecycle(); } catch (error) { failures.push(error); }
    try { clearRuntime(); } catch (error) { failures.push(error); }
    try { state.reliability.releaseWriter(); } catch (error) { failures.push(error); }
    listeners.clear();
    if (failures.length > 0) throw new AggregateError(failures, "Preview controller cleanup failed");
    disposeComplete = true;
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
      if (disposed) return () => false;
      listeners.add(listener);
      return () => listeners.delete(listener);
    },
    getSnapshot,
    loadViteReactTemplate,
    loadTemplate,
    importZipFile,
    importGitHub,
    importSnapshot,
    importProjectFiles,
    exportProjectFiles,
    bootSnapshot,
    exportZip,
    exportSnapshot,
    exportTreeJson,
    exportPathZip,
    setPackageManagerOverride,
    setPreviewErrorBridge,
    getChangeStatus,
    saveTextFile,
    runPreview,
    restartDev,
    reconnectHmr,
    runBuild,
    stopPreviewPort,
    ensureServiceWorker,
    clearPackageCache,
    resolveWriterConflict,
    runRecoveryAction,
    simulateQuotaPressure,
    runShellCommand,
    writeShellInput,
    resizeShell,
    signalShell,
    closeShell,
    listShellProcesses,
    cancelShellCommand,
    dispose,
    log
  };
}

function normalizeExportPrefix(path?: string): string {
  if (!path) return "";
  return path.replace(/^\/+|\/+$/g, "").replace(/^\.\//, "");
}

function validateImportedProjectFiles(
  files: readonly PreviewProjectFileInput[]
): PreviewProjectFile[] {
  if (files.length > MAX_IMPORTED_PROJECT_FILES) {
    throw new Error("Imported Project exceeds the Runtime file limit");
  }
  const encoder = new TextEncoder();
  const paths = new Set<string>();
  const validated: PreviewProjectFile[] = [];
  let totalBytes = 0;
  for (const input of files) {
    if (!isSafeImportedProjectPath(input.path) || paths.has(input.path)) {
      throw new Error("Imported Project contains an unsafe or duplicate path");
    }
    paths.add(input.path);
    let file: PreviewProjectFile;
    if ("content" in input) {
      if (typeof input.content !== "string") {
        throw new Error("Imported Project contains invalid text content");
      }
      file = { path: input.path, kind: "text", bytes: encoder.encode(input.content) };
    } else {
      if ((input.kind !== "text" && input.kind !== "binary") || !(input.bytes instanceof Uint8Array)) {
        throw new Error("Imported Project contains an invalid file");
      }
      file = { path: input.path, kind: input.kind, bytes: Uint8Array.from(input.bytes) };
    }
    if (file.bytes.byteLength > MAX_IMPORTED_PROJECT_FILE_BYTES) {
      throw new Error("Imported Project exceeds the Runtime per-file limit");
    }
    totalBytes += file.bytes.byteLength;
    if (!Number.isSafeInteger(totalBytes) || totalBytes > MAX_IMPORTED_PROJECT_TOTAL_BYTES) {
      throw new Error("Imported Project exceeds the Runtime byte limit");
    }
    validated.push(file);
  }
  return validated;
}

function isSafeImportedProjectPath(path: unknown): path is string {
  if (
    typeof path !== "string"
    || path.length === 0
    || path !== path.normalize("NFC")
    || path.startsWith("/")
    || /^[A-Za-z]:\//u.test(path)
    || path.includes("\\")
    || /[\u0000-\u001f\u007f]/u.test(path)
    || hasUnpairedSurrogate(path)
  ) return false;
  const encoder = new TextEncoder();
  if (encoder.encode(path).byteLength > MAX_IMPORTED_PROJECT_PATH_BYTES) return false;
  const segments = path.split("/");
  return segments.length <= MAX_IMPORTED_PROJECT_PATH_SEGMENTS && segments.every((segment) =>
    segment.length > 0
    && segment !== "."
    && segment !== ".."
    && encoder.encode(segment).byteLength <= MAX_IMPORTED_PROJECT_PATH_SEGMENT_BYTES
  );
}

function hasUnpairedSurrogate(value: string): boolean {
  for (let index = 0; index < value.length; index += 1) {
    const unit = value.charCodeAt(index);
    if (unit >= 0xd800 && unit <= 0xdbff) {
      const trailing = value.charCodeAt(index + 1);
      if (!(trailing >= 0xdc00 && trailing <= 0xdfff)) return true;
      index += 1;
    } else if (unit >= 0xdc00 && unit <= 0xdfff) {
      return true;
    }
  }
  return false;
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

function classifyProjectBytes(bytes: Uint8Array): "text" | "binary" {
  try {
    new TextDecoder("utf-8", { fatal: true }).decode(bytes);
    return "text";
  } catch {
    return "binary";
  }
}

function compareUtf8Path(left: string, right: string): number {
  const encoder = new TextEncoder();
  const leftBytes = encoder.encode(left);
  const rightBytes = encoder.encode(right);
  const length = Math.min(leftBytes.byteLength, rightBytes.byteLength);
  for (let index = 0; index < length; index += 1) {
    const difference = (leftBytes[index] ?? 0) - (rightBytes[index] ?? 0);
    if (difference !== 0) return difference;
  }
  return leftBytes.byteLength - rightBytes.byteLength;
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
