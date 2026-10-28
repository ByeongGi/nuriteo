import { createProjectWorkspaceDevServerChangeBridge, createProjectWorkspaceEditorBridge, decodeProjectWorkspaceArchive, ProjectWorkspaceStore, type ProjectWorkspaceEditorChangeEvent, type ProjectWorkspaceEditorSaveEvent } from "../../browser-host/src/storage/index.ts";
import { exportMaterializedProjectZip, exportProjectZip, createProjectHealthCheck, materializeGitHubUrl, materializeTemplate, materializeZip, workflowTemplateForProjectTemplate, type MaterializedProject, type SupportedPackageManager, type TemplateId } from "../../browser-host/src/onboarding/index.ts";
import { NextProductWorkflow } from "../../node-runtime/src/frameworks/next-workflow.ts";
import { ViteProductWorkflow, type ViteProductPackageManager } from "../../node-runtime/src/frameworks/vite-workflow.ts";


import { createPreviewUrl, createVitePreviewErrorDiagnostic, PreviewRelayError, type PreviewDiagnostic, type PreviewErrorStage, type PreviewRecoveryAction, type PreviewSession } from "../../preview/src/index.ts";


import { PHASES } from "./controller-contracts.ts";
import type { FileSystemTree, PreviewChangeStatus, PreviewWorkflowEventType, PreviewWorkflowLastError, PreviewWorkflowPhase, PreviewProjectFile, PreviewProjectFileInput, PreviewWorkflowSnapshot, PreviewWorkflowUiDiagnostic, ProductWorkflow } from "./controller-contracts.ts";


import type { PreviewControllerScope } from "./controller-scope.ts";
import { classifyProjectBytes, compareUtf8Path, insertFileSystemTreeEntry, normalizeExportPrefix, pathBasename, projectHasGitMarker, relativeProjectPath, validateImportedProjectFiles } from "./controller-paths.ts";

export function bindPreviewControllerSession(scope: PreviewControllerScope): void {
  scope.stopSessionHeartbeat = function stopSessionHeartbeat(): void {
    if (scope.sessionHeartbeat !== null) {
      clearInterval(scope.sessionHeartbeat);
      scope.sessionHeartbeat = null;
    }
  };

  scope.startSessionHeartbeat = function startSessionHeartbeat(): void {
    scope.stopSessionHeartbeat();
    if (typeof setInterval !== "function") return;
    scope.sessionHeartbeat = setInterval(() => {
      try {
        scope.ensureLiveSession({ quiet: true });
      } catch {
        /* ignore idle heartbeat failures */
      }
    }, 20_000);
  };

  scope.bindPreviewSession = function bindPreviewSession(port: number): PreviewSession {
    if (scope.state.session) scope.state.sessions.delete(scope.state.session.sessionId);
    scope.state.lastPreviewPort = port;
    scope.state.session = scope.state.sessions.create({
      origin: location.origin,
      projectId: scope.state.workflow?.projectId || scope.state.project?.projectId || "preview-service",
      port,
      container: scope.createWorkflowPreviewContainer(() => scope.state.workflow)
    });
    scope.state.previewUrl = createPreviewUrl(scope.state.session, "/");
    scope.startSessionHeartbeat();
    return scope.state.session;
  };

  scope.ensureLiveSession = function ensureLiveSession(opts: { quiet?: boolean } = {}): PreviewSession {
    if (!scope.state.workflow) throw new Error("Load a template before serving preview");
    const port = scope.state.session?.port || scope.state.lastPreviewPort || 5173;
    if (scope.state.session) {
      const live = scope.state.sessions.get(scope.state.session.sessionId, {
        origin: location.origin,
        projectId: scope.state.workflow.projectId
      });
      if (live) {
        scope.state.session = live;
        scope.state.previewUrl = createPreviewUrl(live, "/");
        return live;
      }
      if (!opts.quiet) scope.log("preview session expired; rebinding");
    }
    return scope.bindPreviewSession(port);
  };

  scope.emit = function emit(type: PreviewWorkflowEventType, detail: Record<string, unknown> = {}): void {
    const snapshot = scope.getSnapshot();
    for (const listener of scope.listeners) listener({ type, detail, snapshot });
  };

  scope.log = function log(line: unknown): void {
    const text = typeof line === "string" ? line : JSON.stringify(line);
    scope.state.logs.push(text);
    if (scope.state.logs.length > 400) scope.state.logs.splice(0, scope.state.logs.length - 400);
    scope.emit("log", { line: text });
  };

  scope.setPhase = function setPhase(phase: PreviewWorkflowPhase): void {
    scope.state.phase = phase;
    scope.emit("phase", { phase });
  };

  scope.applyStorageDiagnostic = function applyStorageDiagnostic(error: unknown): void {
    const diagnostic = scope.state.reliability.handleStorageError(error);
    if (!diagnostic) return;
    const plan = scope.state.reliability.createRecoveryPlan([diagnostic]);
    scope.state.diagnostics = [{
      code: diagnostic.code,
      message: diagnostic.remediation ? `${diagnostic.message} ${diagnostic.remediation}` : diagnostic.message,
      level: diagnostic.severity,
      recoveryActions: plan.actions.map((action) => ({
        kind: action.kind,
        label: action.label
      }))
    }];
    scope.setPhase(PHASES.failed);
    scope.emit("diagnostic", { diagnostic });
  };

  scope.mapErrorStage = function mapErrorStage(source: string): PreviewErrorStage {
    if (source === "build" || source === "hmr") return source;
    return "runtime";
  };

  scope.setError = function setError(error: unknown, source = "workflow"): PreviewDiagnostic {
    const message = error instanceof Error ? error.message : String(error);
    const lastError: PreviewWorkflowLastError = {
      source,
      message,
      ...(error instanceof Error && error.stack ? { stack: error.stack } : {})
    };
    scope.state.lastError = lastError;
    const diagnostic = createVitePreviewErrorDiagnostic({
      source: scope.mapErrorStage(source),
      error: error instanceof Error ? error : new Error(message),
      command: source === "build" ? "pnpm run build" : "pnpm run dev"
    });
    scope.state.diagnostics = [diagnostic];
    scope.setPhase(PHASES.failed);
    scope.emit("error", { error: scope.state.lastError, diagnostic });
    return diagnostic;
  };

  scope.clearRuntime = function clearRuntime(): void {
    scope.stopSessionHeartbeat();
    try { scope.state.hmr?.close(); } catch { /* ignore */ }
    try { scope.state.workflow?.stopDevServer(); } catch { /* ignore */ }
    if (scope.state.session) scope.state.sessions.delete(scope.state.session.sessionId);
    scope.state.hmr = null;
    scope.state.hmrState = "idle";
    scope.state.session = null;
    scope.state.previewUrl = null;
    scope.state.install = null;
    scope.state.build = null;
    scope.state.lastError = null;
    scope.state.diagnostics = [];
    scope.state.health = null;
    scope.state.source = null;
    scope.state.project = null;
    scope.state.projectFiles = [];
    scope.state.directories = [];
    scope.state.editor = null;
    scope.state.workflow = null;
  };

  scope.attachEditor = function attachEditor(project: ProjectWorkspaceStore, workflow: ProductWorkflow): void {
    const applyDevServerChange = createProjectWorkspaceDevServerChangeBridge(workflow, {
      root: workflow.projectRoot,
      onDiagnostic(diagnostic) {
        const action: PreviewRecoveryAction = {
          kind: "restart-dev-server",
          label: "Restart dev server"
        };
        scope.state.diagnostics = [{
          code: diagnostic.code,
          message: diagnostic.message,
          file: diagnostic.file,
          level: "warning",
          recoveryActions: [action]
        }];
        scope.emit("diagnostic", { diagnostic });
      }
    });
    const editor = createProjectWorkspaceEditorBridge(project, {
      onChange(event: ProjectWorkspaceEditorChangeEvent) {
        scope.emit("editor-change", { event });
        if (event.kind === "create" && event.data !== undefined) {
          workflow.workspace.writeText(event.path, event.data);
        }
        if (event.kind === "rename" && event.previousPath && event.data !== undefined) {
          if (workflow.workspace.rename) {
            workflow.workspace.rename(event.previousPath, event.path);
          } else {
            workflow.workspace.writeText(event.path, event.data);
            workflow.workspace.remove(event.previousPath);
          }
        }
        if (event.kind === "delete") {
          workflow.workspace.remove(event.path);
        }
        const result = applyDevServerChange(event);
        if (result.hmrResult !== undefined) {
          scope.log(`hmr update ${result.relativePath}`);
          scope.emit("hmr-update", { result: result.hmrResult });
        }
      },
      onSave(event: ProjectWorkspaceEditorSaveEvent) {
        workflow.workspace.writeText(event.path, event.data);
      }
    });

    scope.state.project = project;
    scope.state.editor = editor;
  };

  scope.applyMaterializedProject = function applyMaterializedProject(
    materialized: MaterializedProject,
    loadOptions: { label?: string; templateId?: TemplateId; workflowTemplate?: "react" | "vanilla" | "next" } = {}
  ): PreviewWorkflowSnapshot {
    const label = loadOptions.label ?? "nuriteo";
    scope.clearRuntime();
    scope.state.projectFiles = materialized.files.map((file) => ({
      path: file.path,
      kind: "text",
      bytes: new TextEncoder().encode(file.data)
    }));
    scope.state.health = materialized.health;
    scope.state.source = materialized.source;
    scope.state.diagnostics = materialized.health.diagnostics.map((entry) => {
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
      scope.state.project = materialized.store;
      scope.state.editor = createProjectWorkspaceEditorBridge(materialized.store);
      scope.setPhase(PHASES.failed);
      scope.log(`import failed source=${materialized.source}`);
      scope.emit("import-failed", { health: materialized.health });
      return scope.getSnapshot();
    }

    const manager: ViteProductPackageManager = scope.state.packageManagerOverride
      || materialized.health.detection.packageManager
      || "pnpm";
    const kind = loadOptions.workflowTemplate
      || (loadOptions.templateId ? workflowTemplateForProjectTemplate(loadOptions.templateId) : null)
      || scope.detectWorkflowKind(materialized)
      || "vanilla";

    const workflow: ProductWorkflow = kind === "next"
      ? new NextProductWorkflow({
        manager,
        projectId: materialized.store.projectId || "preview-service",
        projectRoot: materialized.store.root || "/workspace/app",
        initialTitle: label === "nuriteo" ? "Next.js" : label,
        port: scope.options.previewPort ?? 3000
      })
      : new ViteProductWorkflow({
        manager,
        template: kind === "react" ? "react" : "vanilla",
        projectId: materialized.store.projectId || "preview-service",
        projectRoot: materialized.store.root || "/workspace/app",
        initialLabel: label,
        port: scope.options.previewPort ?? 5173
      });

    // Drop scaffold leftovers so the selected template owns the workspace.
    scope.removeConflictingScaffoldFiles(workflow, materialized.files.map((file) => file.path));

    for (const file of materialized.files) {
      try {
        workflow.workspace.writeText(`${workflow.projectRoot}/${file.path}`, file.data);
      } catch {
        /* ignore unwritable seed paths */
      }
    }

    scope.state.workflow = workflow;
    scope.attachEditor(materialized.store, workflow);
    scope.setPhase(PHASES.templateLoaded);
    scope.log(`loaded ${materialized.source} project (${manager}, ${kind})`);
    scope.emit("template-loaded", {
      projectId: workflow.projectId,
      source: materialized.source,
      health: materialized.health,
      workflowTemplate: kind
    });
    return scope.getSnapshot();
  };

  scope.detectWorkflowKind = function detectWorkflowKind(materialized: MaterializedProject): "react" | "vanilla" | "next" {
    const paths = new Set(materialized.files.map((file) => file.path));
    const packageJson = materialized.files.find((file) => file.path === "package.json")?.data || "";
    if (packageJson.includes("\"next\"") || [...paths].some((path) => path.startsWith("app/") || path.startsWith("pages/"))) {
      return "next";
    }
    if ([...paths].some((path) => /\.(?:jsx|tsx)$/.test(path))) return "react";
    return "vanilla";
  };

  scope.removeConflictingScaffoldFiles = function removeConflictingScaffoldFiles(
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
  };

  scope.packageOverrides = function packageOverrides(): { packageManager: SupportedPackageManager } | undefined {
    return scope.state.packageManagerOverride
      ? { packageManager: scope.state.packageManagerOverride }
      : undefined;
  };

  scope.setPackageManagerOverride = function setPackageManagerOverride(value: SupportedPackageManager | null | ""): void {
    scope.state.packageManagerOverride = value || null;
    scope.emit("override", { packageManagerOverride: scope.state.packageManagerOverride });
  };

  scope.loadViteReactTemplate = function loadViteReactTemplate(loadOptions: { label?: string } = {}): PreviewWorkflowSnapshot {
    return scope.loadTemplate("vite-react", loadOptions);
  };

  scope.loadTemplate = function loadTemplate(
    templateId: TemplateId = "vite-react",
    loadOptions: { label?: string } = {}
  ): PreviewWorkflowSnapshot {
    const overrides = scope.packageOverrides();
    const materialized = materializeTemplate(templateId, {
      projectId: scope.options.workspaceProjectId ?? "preview-service",
      root: scope.options.workspaceRoot ?? "/workspace/app",
      ...(overrides ? { overrides } : {})
    });
    return scope.applyMaterializedProject(materialized, {
      ...loadOptions,
      templateId,
      workflowTemplate: workflowTemplateForProjectTemplate(templateId)
    });
  };

  scope.importZipFile = async function importZipFile(file: Blob): Promise<PreviewWorkflowSnapshot> {
    const operation = scope.beginOperation();
    try {
      const bytes = new Uint8Array(await file.arrayBuffer());
      scope.assertOperationActive(operation);
      const overrides = scope.packageOverrides();
      const materialized = materializeZip(bytes, {
        projectId: scope.options.workspaceProjectId ?? "preview-service-zip",
        root: scope.options.workspaceRoot ?? "/workspace/app",
        ...(overrides ? { overrides } : {})
      });
      return scope.applyMaterializedProject(materialized);
    } finally { scope.operationControllers.delete(operation); }
  };

  scope.importGitHub = async function importGitHub(url: string): Promise<PreviewWorkflowSnapshot> {
    const operation = scope.beginOperation();
    try {
      const overrides = scope.packageOverrides();
      const materialized = await materializeGitHubUrl(url, {
        projectId: scope.options.workspaceProjectId ?? "preview-service-github",
        root: scope.options.workspaceRoot ?? "/workspace/app",
        ...(overrides ? { overrides } : {})
      });
      scope.assertOperationActive(operation);
      return scope.applyMaterializedProject(materialized);
    } finally { scope.operationControllers.delete(operation); }
  };

  scope.bootSnapshot = async function bootSnapshot(
    input: Blob | Uint8Array | ArrayBuffer | string
  ): Promise<PreviewWorkflowSnapshot> {
    const operation = scope.beginOperation();
    try {
    const bytes = input instanceof Blob ? new Uint8Array(await input.arrayBuffer()) : input;
    scope.assertOperationActive(operation);
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
    const overrides = scope.packageOverrides();
    const health = createProjectHealthCheck({
      files,
      ...(overrides ? { overrides } : {}),
      ...(defaultPackageManager ? { defaultPackageManager } : {})
    });
    return scope.applyMaterializedProject({
      store: restored,
      files,
      health,
      source: "snapshot"
    }, {
      label: typeof restored.metadata.name === "string" ? restored.metadata.name : "snapshot"
    });
    } finally { scope.operationControllers.delete(operation); }
  };

  scope.importProjectFiles = function importProjectFiles(
    files: readonly PreviewProjectFileInput[],
    name = "cloud project"
  ): PreviewWorkflowSnapshot {
    const root = scope.options.workspaceRoot ?? "/workspace/app";
    const store = new ProjectWorkspaceStore({
      projectId: scope.options.workspaceProjectId ?? "preview-service-cloud",
      root,
      metadata: { name }
    });
    const decoder = new TextDecoder("utf-8", { fatal: true });
    const projectFiles = validateImportedProjectFiles(files);
    const materializedFiles = projectFiles
      .filter((file) => file.kind === "text")
      .map((file) => ({ path: file.path, data: decoder.decode(file.bytes) }));
    for (const file of materializedFiles) store.writeText(`${root}/${file.path}`, file.data);
    const overrides = scope.packageOverrides();
    const health = createProjectHealthCheck({
      files: materializedFiles,
      ...(overrides ? { overrides } : {})
    });
    const snapshot = scope.applyMaterializedProject({ store, files: materializedFiles, health, source: "snapshot" }, { label: name });
    scope.state.projectFiles = projectFiles;
    if (scope.state.workflow) {
      for (const file of projectFiles) {
        if (file.kind === "binary") {
          scope.state.workflow.workspace.writeBytes(`${scope.state.workflow.projectRoot}/${file.path}`, file.bytes);
        }
      }
    }
    return snapshot;
  };

  scope.exportProjectFiles = function exportProjectFiles(): readonly PreviewProjectFile[] {
    if (!scope.state.project) throw new Error("No project to export");
    if (!scope.state.workflow) {
      return scope.state.projectFiles.map((file) => ({ ...file, bytes: Uint8Array.from(file.bytes) }));
    }
    const prefix = `${scope.state.workflow.projectRoot.replace(/\/+$/u, "")}/`;
    const admittedKind = new Map(scope.state.projectFiles.map((file) => [file.path, file.kind]));
    return [...scope.state.workflow.workspace.files.entries()]
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
  };

  scope.exportZip = function exportZip(): Uint8Array {
    if (!scope.state.project) throw new Error("No project to export");
    return exportMaterializedProjectZip(scope.state.project, scope.state.project.projectId || "project");
  };

  scope.exportSnapshot = function exportSnapshot(): Uint8Array {
    if (!scope.state.project) throw new Error("No project to export");
    return scope.state.project.exportSnapshot();
  };

  scope.exportTreeJson = function exportTreeJson(path?: string): FileSystemTree {
    if (!scope.state.project) throw new Error("No project to export");
    const root = scope.state.project.root;
    const prefix = normalizeExportPrefix(path);
    const tree: FileSystemTree = {};
    for (const file of scope.state.project.listFiles()) {
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
  };

  scope.exportPathZip = function exportPathZip(relativePath: string): Uint8Array {
    if (!scope.state.project) throw new Error("No project to export");
    const prefix = normalizeExportPrefix(relativePath);
    if (!prefix) throw new Error("exportPathZip requires a relative path");
    const files = scope.state.project.listFiles()
      .map((file) => ({
        path: relativeProjectPath(file.path, scope.state.project!.root),
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
      rootDirectory: scope.state.project.projectId || "project",
      files
    });
  };

  scope.setPreviewErrorBridge = function setPreviewErrorBridge(enabled: boolean): void {
    scope.state.previewErrorBridge = Boolean(enabled);
  };

  scope.getChangeStatus = function getChangeStatus(): PreviewChangeStatus {
    const dirty = (scope.state.editor?.dirtyFiles() || [])
      .map((file) => relativeProjectPath(file.path, scope.state.project?.root || ""))
      .filter(Boolean)
      .sort((left, right) => left.localeCompare(right));
    const hasGitMarker = projectHasGitMarker(scope.state.project);
    return {
      dirty,
      untrackedHint: hasGitMarker
        ? "Editor dirty buffers only (not git status); .git marker present in project store."
        : "Editor dirty buffers only — not a real git working tree.",
      hasGitMarker
    };
  };

  scope.ensureServiceWorker = async function ensureServiceWorker(): Promise<ServiceWorkerRegistration> {
    if (!("serviceWorker" in navigator)) {
      throw new Error("Service workers are unavailable in this browser session");
    }
    const operation = scope.beginOperation();
    try {
      const registration = await navigator.serviceWorker.register(
        scope.options.previewServiceWorkerUrl ?? "/preview-sw.js",
        { scope: "/" }
      );
      scope.assertOperationActive(operation);
      await navigator.serviceWorker.ready;
      scope.assertOperationActive(operation);
      return registration;
    } finally { scope.operationControllers.delete(operation); }
  };

  scope.bindPreviewFetchBridge = function bindPreviewFetchBridge(): void {
    if (scope.state.fetchBridgeBound) return;
    navigator.serviceWorker?.addEventListener("message", scope.onServiceWorkerMessage);
    scope.state.fetchBridgeBound = true;
  };

  scope.onServiceWorkerMessage = async function onServiceWorkerMessage(event: MessageEvent): Promise<void> {
    if (scope.disposed) return;
    const data = event.data as { type?: string; path?: string; method?: string } | null;
    if (data?.type !== "preview-sw:fetch") return;
    const port = event.ports[0];
    if (!port) return;
    const operation = scope.beginOperation();
    try {
      if (!scope.state.workflow) {
        port.postMessage({
          status: 503,
          headers: { "content-type": "text/plain; charset=utf-8" },
          body: "Preview workflow is not running."
        });
        return;
      }
      const session = scope.ensureLiveSession({ quiet: true });
      const previewPath = scope.stripPreviewPrefix(data.path || "/", session);
      let response: Response;
      try {
        response = await scope.state.relay.request({
          sessionId: session.sessionId,
          origin: location.origin,
          projectId: scope.state.workflow.projectId,
          path: previewPath,
          method: data.method || "GET"
        });
        scope.assertOperationActive(operation);
      } catch (error) {
        if (!(error instanceof PreviewRelayError) || error.code !== "ESTALESESSION") throw error;
        const rebound = scope.ensureLiveSession();
        response = await scope.state.relay.request({
          sessionId: rebound.sessionId,
          origin: location.origin,
          projectId: scope.state.workflow.projectId,
          path: scope.stripPreviewPrefix(data.path || "/", rebound),
          method: data.method || "GET"
        });
        scope.assertOperationActive(operation);
      }
      const normalized = await scope.normalizeRelayResponse(response);
      scope.assertOperationActive(operation);
      port.postMessage(normalized);
    } catch (error) {
      if (operation.signal.aborted || scope.disposed) return;
      const diagnostic = scope.setError(error, "preview");
      port.postMessage({
        status: 502,
        headers: { "content-type": "text/plain; charset=utf-8" },
        body: diagnostic.message
      });
    } finally { scope.operationControllers.delete(operation); }
  };
}
