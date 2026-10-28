


import { createRegistryPackageInstaller, type RegistryInstallResult } from "../../node-runtime/src/package-managers/registry-installer.ts";

import { createHmrClient, createPreviewUrl, type HmrClientError, type HmrClientSnapshot, type PreviewContainer, type PreviewSession } from "../../preview/src/index.ts";
import { createPreviewReliabilitySession } from "./reliability.ts";
import { injectPreviewErrorBridge, shouldInjectPreviewErrorBridge } from "./preview-inject.ts";
import { executeWorkspacePackageLifecycles } from "./package-script.ts";
import type { RuntimeRecoveryActionKind } from "../../browser-host/src/observability/recovery-actions.ts";
import { PHASES } from "./controller-contracts.ts";
import type { PreviewWorkflowSnapshot, ProductWorkflow } from "./controller-contracts.ts";

import type { PreviewPackageInstallRequest } from "./shell.ts";

import type { PreviewControllerScope } from "./controller-scope.ts";
import { isAdapterFrameworkFixture, isBrowserToolchainPackage, normalizeRelativeProjectPath, readLockedDependencyVersions, relativeProjectPath } from "./controller-paths.ts";

interface NormalizedRelayResponse {
  status: number;
  headers: Record<string, string>;
  body: string;
}

export function bindPreviewControllerFiles(scope: PreviewControllerScope): void {
  scope.stripPreviewPrefix = function stripPreviewPrefix(pathname: string, session: PreviewSession): string {
    const base = new URL(session.baseUrl).pathname;
    if (pathname.startsWith(base)) {
      const rest = pathname.slice(base.length);
      return rest ? `/${rest}` : "/";
    }
    return "/";
  };

  scope.createWorkflowPreviewContainer = function createWorkflowPreviewContainer(getWorkflow: () => ProductWorkflow | null): PreviewContainer {
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
          : scope.maybeInjectPreviewErrorBridge(preview.body || "", contentType);
        return new Response(body, {
          status: preview.statusCode,
          headers
        });
      }
    };
  };

  scope.normalizeRelayResponse = async function normalizeRelayResponse(response: unknown): Promise<NormalizedRelayResponse> {
    const corpHeaders = {
      "Cross-Origin-Resource-Policy": "same-origin",
      "Cross-Origin-Embedder-Policy": "require-corp"
    };
    if (response && typeof response === "object" && "text" in response && typeof (response as Response).text === "function") {
      const webResponse = response as Response;
      const headers: Record<string, string> = {
        "content-type": "text/html; charset=utf-8",
        ...corpHeaders,
        ...(scope.headersToObject(webResponse.headers) || {})
      };
      return {
        status: webResponse.status || 500,
        headers,
        body: scope.maybeInjectPreviewErrorBridge(await webResponse.text(), headers["content-type"] || headers["Content-Type"])
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
      body: scope.maybeInjectPreviewErrorBridge(legacy.body || "", headers["content-type"] || headers["Content-Type"])
    };
  };

  scope.maybeInjectPreviewErrorBridge = function maybeInjectPreviewErrorBridge(body: string, contentType: string | undefined): string {
    if (!scope.state.previewErrorBridge) return body;
    if (!shouldInjectPreviewErrorBridge(contentType)) return body;
    return injectPreviewErrorBridge(body);
  };

  scope.headersToObject = function headersToObject(headers: Headers | Record<string, string> | null | undefined): Record<string, string> | null {
    if (!headers) return null;
    const out: Record<string, string> = {};
    if (typeof (headers as Headers).forEach === "function") {
      (headers as Headers).forEach((value, key) => {
        out[key] = value;
      });
      return out;
    }
    return { ...(headers as Record<string, string>) };
  };

  scope.connectHmr = async function connectHmr(): Promise<HmrClientSnapshot> {
    if (!scope.state.workflow) throw new Error("Load a template before connecting HMR");
    try { scope.state.hmr?.close(); } catch { /* ignore */ }
    const workflow = scope.state.workflow;
    const hmr = createHmrClient({
      maxRetries: 3,
      connect: () => workflow.connectHmr()
    });
    hmr.on("open", () => {
      scope.state.hmrState = "connected";
      if (scope.state.phase === PHASES.previewReady || scope.state.phase === PHASES.hmrConnected) {
        scope.setPhase(PHASES.hmrConnected);
      }
      scope.emit("hmr", { state: scope.state.hmrState });
    });
    hmr.on("reconnect", () => {
      scope.state.hmrState = "reconnecting";
      scope.emit("hmr", { state: scope.state.hmrState });
    });
    hmr.on("close", () => {
      scope.state.hmrState = "closed";
      scope.emit("hmr", { state: scope.state.hmrState });
    });
    hmr.on("error", (payload) => {
      const event = payload as HmrClientError;
      scope.state.hmrState = "error";
      scope.setError(new Error(event?.message || "HMR connection failed"), "hmr");
    });
    scope.state.hmr = hmr;
    hmr.start();
    return hmr.snapshot();
  };

  scope.runPreview = async function runPreview(scriptName = "dev"): Promise<PreviewWorkflowSnapshot> {
    if (!scope.state.workflow) scope.loadTemplate("vite-react");
    if (!scope.state.workflow) throw new Error("Failed to load preview workflow");
    if (scope.state.health && !scope.state.health.ok) {
      throw new Error(
        scope.state.health.diagnostics.find((entry) => entry.level === "error")?.message
          || "Project health check failed"
      );
    }
    const operation = scope.beginOperation();
    try {
      scope.setPhase(PHASES.installing);
      scope.log("의존성 설치 중");
      await scope.installProjectPackages({
        ignoreScripts: false,
        manager: "npm",
        packages: [],
        save: false,
        signal: operation.signal
      });
      scope.log(`설치됨 packages=${scope.state.install?.packages.join(",") ?? ""}`);
      scope.setPhase(PHASES.installed);

      scope.setPhase(PHASES.startingDev);
      const dev = await scope.startPreviewDevServer(scriptName);
      scope.log(`dev server ready :${dev.port} mode=${dev.moduleTransform}`);

      await scope.ensureServiceWorker();
      scope.assertOperationActive(operation);
      scope.bindPreviewFetchBridge();

      scope.bindPreviewSession(dev.port);
      scope.setPhase(PHASES.previewReady);
      await scope.connectHmr();
      scope.assertOperationActive(operation);
      scope.emit("preview-ready", { previewUrl: scope.state.previewUrl, sessionId: scope.state.session?.sessionId });
      return scope.getSnapshot();
    } catch (error) {
      if (operation.signal.aborted || scope.disposed) throw new Error("Preview controller operation cancelled");
      scope.setError(error, "preview");
      throw error;
    } finally {
      scope.operationControllers.delete(operation);
    }
  };

  scope.saveTextFile = function saveTextFile(path: string, data: string): PreviewWorkflowSnapshot {
    if (scope.disposed || !scope.state.editor) throw new Error("Preview editor is unavailable");
    scope.state.editor.editText(path, data);
    scope.state.editor.saveFile(path);
    const relative = relativeProjectPath(path, scope.state.project?.root || "");
    const index = scope.state.projectFiles.findIndex((file) => file.path === relative);
    const next = { path: relative, kind: "text" as const, bytes: new TextEncoder().encode(data) };
    if (index === -1) scope.state.projectFiles.push(next);
    else scope.state.projectFiles[index] = next;
    return scope.getSnapshot();
  };

  scope.createTextFile = function createTextFile(path: string, data = ""): PreviewWorkflowSnapshot {
    if (scope.disposed || !scope.state.editor) throw new Error("Preview editor is unavailable");
    scope.state.editor.createFile(path, data);
    const relative = relativeProjectPath(path, scope.state.project?.root || "");
    scope.state.projectFiles.push({ path: relative, kind: "text", bytes: new TextEncoder().encode(data) });
    scope.state.projectFiles.sort((left, right) => left.path.localeCompare(right.path));
    return scope.getSnapshot();
  };

  scope.createDirectory = function createDirectory(path: string): PreviewWorkflowSnapshot {
    if (scope.disposed || !scope.state.workflow) throw new Error("Preview editor is unavailable");
    const relative = normalizeRelativeProjectPath(path);
    if (scope.state.projectFiles.some((file) => file.path === relative)) throw new Error(`A file already exists: ${relative}`);
    if (!scope.state.directories.includes(relative)) scope.state.directories = [...scope.state.directories, relative].sort();
    scope.state.workflow.workspace.mkdir(`${scope.state.workflow.projectRoot}/${relative}`);
    return scope.getSnapshot();
  };

  scope.movePath = function movePath(from: string, to: string): PreviewWorkflowSnapshot {
    if (scope.disposed || !scope.state.editor) throw new Error("Preview editor is unavailable");
    const source = normalizeRelativeProjectPath(from);
    const target = normalizeRelativeProjectPath(to);
    if (source === target) return scope.getSnapshot();
    if (target === source || target.startsWith(`${source}/`)) throw new Error("Cannot move a directory into itself");
    const movingFiles = scope.state.projectFiles
      .filter((file) => file.path === source || file.path.startsWith(`${source}/`))
      .sort((left, right) => right.path.length - left.path.length);
    const movingDirectory = scope.state.directories.some((directory) => directory === source || directory.startsWith(`${source}/`));
    if (movingFiles.length === 0 && !movingDirectory) throw new Error(`No such project path: ${source}`);
    for (const file of movingFiles) {
      scope.renameFile(file.path, `${target}${file.path.slice(source.length)}`);
    }
    scope.state.directories = scope.state.directories.map((directory) => (
      directory === source || directory.startsWith(`${source}/`)
        ? `${target}${directory.slice(source.length)}`
        : directory
    ));
    if (movingFiles.length === 0 && !scope.state.directories.includes(target)) scope.state.directories.push(target);
    scope.state.directories.sort();
    const workflow = scope.state.workflow;
    if (workflow) {
      const sourceAbsolute = `${workflow.projectRoot}/${source}`;
      const sourceRemains = scope.state.projectFiles.some((file) => file.path === source || file.path.startsWith(`${source}/`));
      if (!sourceRemains) workflow.workspace.remove(sourceAbsolute);
      const movedDirectory = movingDirectory || movingFiles.some((file) => file.path.startsWith(`${source}/`));
      if (movedDirectory) workflow.workspace.mkdir(`${workflow.projectRoot}/${target}`);
    }
    return scope.getSnapshot();
  };

  scope.deletePath = function deletePath(path: string): PreviewWorkflowSnapshot {
    if (scope.disposed || !scope.state.editor) throw new Error("Preview editor is unavailable");
    const relative = normalizeRelativeProjectPath(path);
    const files = scope.state.projectFiles
      .filter((file) => file.path === relative || file.path.startsWith(`${relative}/`))
      .sort((left, right) => right.path.length - left.path.length);
    const hadDirectory = scope.state.directories.some((directory) => directory === relative || directory.startsWith(`${relative}/`));
    if (files.length === 0 && !hadDirectory) throw new Error(`No such project path: ${relative}`);
    for (const file of files) scope.deleteFile(file.path);
    scope.state.directories = scope.state.directories.filter((directory) => directory !== relative && !directory.startsWith(`${relative}/`));
    scope.state.workflow?.workspace.remove(`${scope.state.workflow.projectRoot}/${relative}`);
    return scope.getSnapshot();
  };

  scope.cancelPreview = function cancelPreview(): PreviewWorkflowSnapshot {
    for (const operation of scope.operationControllers) operation.abort();
    try { scope.state.workflow?.stopDevServer(); } catch { /* the preview start owns the failure */ }
    scope.log("미리보기 시작을 취소했습니다.");
    return scope.getSnapshot();
  };

  scope.renameFile = function renameFile(from: string, to: string): PreviewWorkflowSnapshot {
    if (scope.disposed || !scope.state.editor) throw new Error("Preview editor is unavailable");
    const fromRelative = relativeProjectPath(from, scope.state.project?.root || "");
    const index = scope.state.projectFiles.findIndex((file) => file.path === fromRelative);
    if (index < 0) throw new Error(`No such project file: ${fromRelative}`);
    const renamed = scope.state.editor.renameFile(from, to);
    const toRelative = relativeProjectPath(renamed.path, scope.state.project?.root || "");
    scope.state.projectFiles[index] = { path: toRelative, kind: "text", bytes: new TextEncoder().encode(renamed.data) };
    scope.state.projectFiles.sort((left, right) => left.path.localeCompare(right.path));
    return scope.getSnapshot();
  };

  scope.deleteFile = function deleteFile(path: string): PreviewWorkflowSnapshot {
    if (scope.disposed || !scope.state.editor) throw new Error("Preview editor is unavailable");
    scope.state.editor.deleteFile(path);
    const relative = relativeProjectPath(path, scope.state.project?.root || "");
    scope.state.projectFiles = scope.state.projectFiles.filter((file) => file.path !== relative);
    return scope.getSnapshot();
  };

  scope.isInstalledDependencyPath = function isInstalledDependencyPath(relativePath: string): boolean {
    return relativePath.split("/").some((segment) => segment === "node_modules" || segment === ".pnpm-store");
  };

  scope.syncWorkflowFilesToProject = function syncWorkflowFilesToProject(): void {
    const workflow = scope.state.workflow;
    const project = scope.state.project;
    if (!workflow || !project) return;
    const rootPrefix = `${workflow.projectRoot}/`;
    const runtimeFiles = new Map(
      [...workflow.workspace.files.entries()]
        .filter(([path]) => path.startsWith(rootPrefix) && !scope.isInstalledDependencyPath(path.slice(rootPrefix.length)))
    );

    for (const file of project.listFiles()) {
      if (!runtimeFiles.has(file.path)) project.files.delete(file.path);
    }
    for (const [path, bytes] of runtimeFiles) {
      try {
        project.writeText(path, new TextDecoder("utf-8", { fatal: true }).decode(bytes));
      } catch {
        // ProjectWorkspaceStore currently represents editor-visible text files only.
      }
    }
    scope.state.projectFiles = project.listFiles().map((file) => ({
      path: relativeProjectPath(file.path, project.root),
      kind: "text",
      bytes: new TextEncoder().encode(file.data)
    }));
  };

  scope.syncProjectFilesToWorkflow = function syncProjectFilesToWorkflow(): void {
    const workflow = scope.state.workflow;
    const project = scope.state.project;
    if (!workflow || !project) return;
    const currentTextFiles = new Map(project.listFiles().map((file) => [file.path, file.data]));
    for (const file of scope.state.projectFiles) {
      if (file.kind !== "text") continue;
      const absolutePath = `${workflow.projectRoot}/${file.path}`;
      if (!currentTextFiles.has(absolutePath)) workflow.workspace.remove(absolutePath);
    }
    for (const [path, data] of currentTextFiles) workflow.workspace.writeText(path, data);
    const binaryFiles = scope.state.projectFiles.filter((file) => file.kind === "binary");
    scope.state.projectFiles = [
      ...binaryFiles,
      ...project.listFiles().map((file) => ({
        path: relativeProjectPath(file.path, project.root),
        kind: "text" as const,
        bytes: new TextEncoder().encode(file.data)
      }))
    ].sort((left, right) => left.path.localeCompare(right.path));
  };

  scope.beginOperation = function beginOperation(): AbortController {
    if (scope.disposed) throw new Error("Preview controller is disposed");
    const controller = new AbortController();
    scope.operationControllers.add(controller);
    return controller;
  };

  scope.assertOperationActive = function assertOperationActive(operation: AbortController): void {
    if (scope.disposed || operation.signal.aborted || scope.operationGeneration !== 0) {
      throw new Error("Preview controller operation cancelled");
    }
  };

  scope.restartDev = async function restartDev(): Promise<PreviewWorkflowSnapshot> {
    if (!scope.state.workflow) throw new Error("No running workflow to restart");
    const operation = scope.beginOperation();
    try {
      scope.setPhase(PHASES.startingDev);
      const recovery = scope.state.workflow.restart();
      scope.log(`dev restarted preview=${String(recovery.previewAfterRestart || "").slice(0, 48)}`);
      const port = scope.state.session?.port || scope.state.lastPreviewPort || 5173;
      if (scope.state.session) {
        const replaced = scope.state.sessions.replace(scope.state.session.sessionId, {
          port,
          serverState: "running",
          lastErrorCode: null,
          container: scope.createWorkflowPreviewContainer(() => scope.state.workflow)
        });
        if (replaced) {
          scope.state.session = replaced;
          scope.state.previewUrl = createPreviewUrl(replaced, "/");
          scope.startSessionHeartbeat();
        } else {
          scope.bindPreviewSession(port);
        }
      } else {
        scope.bindPreviewSession(port);
      }
      scope.setPhase(PHASES.previewReady);
      await scope.connectHmr();
      scope.assertOperationActive(operation);
      scope.emit("preview-ready", { previewUrl: scope.state.previewUrl, restarted: true });
      return scope.getSnapshot();
    } catch (error) {
      if (operation.signal.aborted || scope.disposed) throw new Error("Preview controller operation cancelled");
      scope.setError(error, "preview");
      throw error;
    } finally { scope.operationControllers.delete(operation); }
  };

  scope.reconnectHmr = async function reconnectHmr(): Promise<HmrClientSnapshot> {
    const operation = scope.beginOperation();
    try {
      const snapshot = await scope.connectHmr();
      scope.assertOperationActive(operation);
      scope.log(`hmr reconnect -> ${snapshot.state}`);
      return snapshot;
    } finally { scope.operationControllers.delete(operation); }
  };

  scope.runBuild = async function runBuild(scriptName = "build"): Promise<PreviewWorkflowSnapshot> {
    if (!scope.state.workflow) throw new Error("Load a template before building");
    try {
      scope.setPhase(PHASES.building);
      scope.state.build = scope.state.workflow.buildFromPackageScript(scriptName);
      scope.log(`build ok files=${scope.state.build.files.join(",")}`);
      scope.setPhase(PHASES.built);
      scope.emit("build", { build: scope.state.build });
      return scope.getSnapshot();
    } catch (error) {
      scope.setError(error, "build");
      throw error;
    }
  };

  scope.clearPackageCache = function clearPackageCache(): { freedBytes: number; evicted: number } {
    const result = scope.state.reliability.clearPackageCache();
    scope.log(`cleared package cache freedBytes=${result.freedBytes} evicted=${result.evicted}`);
    if (scope.state.phase === PHASES.failed && scope.state.diagnostics.some((entry) => entry.code === "EOPFSQUOTA")) {
      scope.setPhase(scope.state.workflow ? PHASES.templateLoaded : PHASES.idle);
      scope.state.diagnostics = [];
      scope.state.lastError = null;
    }
    scope.emit("log", { line: "cache-cleared", result });
    return result;
  };

  scope.stopPreviewPort = function stopPreviewPort(port = scope.state.session?.port): boolean {
    if (!scope.state.session || port === undefined || scope.state.session.port !== port) return false;
    try { scope.state.workflow?.stopDevServer(); } catch { /* best-effort process cleanup */ }
    scope.state.sessions.delete(scope.state.session.sessionId);
    scope.stopSessionHeartbeat();
    scope.state.session = null;
    scope.state.previewUrl = null;
    scope.state.hmrState = "idle";
    try { scope.state.hmr?.close(); } catch { /* best-effort socket cleanup */ }
    scope.state.hmr = null;
    scope.emit("phase", { phase: scope.state.phase, port, stopped: true });
    return true;
  };

  scope.resolveWriterConflict = function resolveWriterConflict(): void {
    scope.state.reliability.forceTakeWriter();
    scope.log(`writer lease acquired owner=${scope.state.reliability.owner}`);
    if (scope.state.diagnostics.some((entry) => entry.code === "ELEASEHELD")) {
      scope.setPhase(scope.state.workflow ? PHASES.templateLoaded : PHASES.idle);
      scope.state.diagnostics = [];
      scope.state.lastError = null;
    }
    scope.emit("log", { line: "writer-lease-resolved" });
  };

  scope.simulateQuotaPressure = function simulateQuotaPressure(bytes = 4096): void {
    scope.state.reliability.releaseWriter();
    scope.state.reliability = createPreviewReliabilitySession({
      policy: {
        storage: {
          quotaBytesDefault: 2048,
          evictionPrefixes: ["cache/", "packages/"],
          protectedPrefixes: ["projects/"],
          writerLeaseTtlMs: 30_000
        }
      }
    });
    scope.state.reliability.acquireWriter();
    scope.state.reliability.writeCacheFile("projects/keep.json", "protected");
    try {
      scope.state.reliability.writeCacheFile("cache/pressure.json", "x".repeat(bytes));
    } catch (error) {
      scope.applyStorageDiagnostic(error);
      throw error;
    }
  };

  scope.runRecoveryAction = async function runRecoveryAction(kind: RuntimeRecoveryActionKind | string): Promise<unknown> {
    if (kind === "clear-cache") return scope.clearPackageCache();
    if (kind === "resolve-writer-conflict") {
      scope.resolveWriterConflict();
      return { owner: scope.state.reliability.owner };
    }
    if (kind === "reset-runtime") return scope.restartDev();
    if (kind === "retry") return scope.runPreview();
    if (kind === "restart-dev-server") return scope.restartDev();
    if (kind === "rerun-build") return scope.runBuild();
    throw new Error(`Unsupported recovery action: ${kind}`);
  };

  scope.installDeclaredPackages = async function installDeclaredPackages(request?: PreviewPackageInstallRequest) {
    if (!scope.state.workflow || !scope.state.install) throw new Error("no workflow");
    const fixtureRuntime = new Set<string>();
    let manifest: {
      dependencies?: Record<string, string>;
      devDependencies?: Record<string, string>;
      optionalDependencies?: Record<string, string>;
    } = {};
    try {
      manifest = JSON.parse(scope.state.workflow.workspace.readText(`${scope.state.workflow.projectRoot}/package.json`)) as typeof manifest;
    } catch {
      manifest = {};
    }
    const dependencyNames = new Set(Object.keys(manifest.dependencies ?? {}));
    const declaredNames = new Set([
      ...dependencyNames,
      ...Object.keys(manifest.devDependencies ?? {}),
      ...Object.keys(manifest.optionalDependencies ?? {})
    ]);
    const exclude = new Set(scope.state.install.packages);
    for (const name of declaredNames) {
      // Vite, TypeScript, and @types stay as browser shims when they are not
      // application dependencies. App libraries such as date-fns are often
      // declared in devDependencies and still have to be fetched, or the
      // preview keeps a product-fixture stub and a bare import.
      if (!dependencyNames.has(name) && isBrowserToolchainPackage(name)) {
        exclude.add(name);
        continue;
      }
      try {
        const installed = JSON.parse(scope.state.workflow.workspace.readText(`${scope.state.workflow.projectRoot}/node_modules/${name}/package.json`)) as { version?: string };
        if (installed.version === "product-fixture") fixtureRuntime.add(name);
      } catch {
        fixtureRuntime.add(name);
      }
    }
    for (const name of fixtureRuntime) exclude.delete(name);
    const locked = request?.packages.length ? new Map<string, string>() : readLockedDependencyVersions(scope.state.workflow);
    const declaredRanges = new Map<string, string>([
      ...Object.entries(manifest.dependencies ?? {}),
      ...Object.entries(manifest.devDependencies ?? {}),
      ...Object.entries(manifest.optionalDependencies ?? {})
    ]);
    const lockedSpecs = locked.size === 0
      ? []
      : [...declaredNames]
        .filter((name) => !exclude.has(name))
        .map((name) => `${name}@${locked.get(name) ?? declaredRanges.get(name) ?? "latest"}`);
    return createRegistryPackageInstaller({
      workspace: scope.state.workflow.workspace,
      ...(scope.options.packageFetch ? { fetch: scope.options.packageFetch } : {}),
      ...(scope.options.packageRegistryUrl ? { registryUrl: scope.options.packageRegistryUrl } : {})
    }).install({
      cwd: scope.state.workflow.projectRoot,
      ...(request?.packages.length ? { packages: request.packages, save: request.save } : {}),
      ...(!request?.packages.length && lockedSpecs.length > 0 ? { packages: lockedSpecs, save: false } : {}),
      ...(!request?.packages.length && lockedSpecs.length === 0 ? { exclude: [...exclude] } : {}),
      ...(request?.signal ? { signal: request.signal } : {})
    });
  };

  scope.runInstalledPackageLifecycles = async function runInstalledPackageLifecycles(
    ignoreScripts: boolean,
    registryInstall: RegistryInstallResult
  ): Promise<string[]> {
    const lifecycleOutput: string[] = [];
    if (!scope.state.workflow || ignoreScripts || registryInstall.installed.length === 0) return lifecycleOutput;
    const installedByPath = new Map(registryInstall.installed.map((entry) => [entry.path, entry]));
    const lifecycleResults = await executeWorkspacePackageLifecycles(
      scope.state.workflow,
      registryInstall.installed.map((entry) => entry.path).reverse()
    );
    for (const result of lifecycleResults) {
      if (result.stdout) lifecycleOutput.push(result.stdout.trimEnd());
      if (result.exitCode === 0) continue;
      const installedPackage = installedByPath.get(result.packagePath);
      if (installedPackage?.optional) {
        scope.log(`optional lifecycle skipped ${installedPackage.name}: ${result.stderr.trim()}`);
        continue;
      }
      throw new Error(`${installedPackage?.name ?? result.packagePath} ${result.event}: ${result.stderr.trim()}`);
    }
    return lifecycleOutput;
  };

  scope.syncDeclaredPackages = async function syncDeclaredPackages(): Promise<{ added: string[] }> {
    if (scope.disposed || !scope.state.workflow) return { added: [] };
    const projectInstall = await scope.installProjectPackages({
      ignoreScripts: false,
      manager: "npm",
      packages: [],
      save: false
    }) as { registryInstall: RegistryInstallResult };
    return { added: projectInstall.registryInstall.installed.map((entry) => `${entry.name}@${entry.version}`) };
  };

  scope.startPreviewDevServer = async function startPreviewDevServer(scriptName: string) {
    const workflow = scope.state.workflow;
    if (!workflow) throw new Error("Failed to load preview workflow");
    if (isAdapterFrameworkFixture(workflow)) return workflow.startDevServerFromPackageScript(scriptName);
    if (workflow.template === "next-app") {
      const readiness = workflow.inspectRealCliReadiness();
      if (readiness.status !== "ready") {
        const reason = readiness.cliEntryReadiness.reasons.find((entry) => entry.message)?.message
          || "개발 서버 준비를 마치지 못했습니다.";
        throw new Error(reason);
      }
    }
    const dev = await workflow.startDevServerFromCliExecution(scriptName);
    if (dev.moduleTransform === "adapter") {
      throw new Error("개발 서버가 프로젝트 개발 명령을 실행하지 못했습니다.");
    }
    return dev;
  };

  scope.installProjectPackages = async function installProjectPackages(request?: PreviewPackageInstallRequest) {
    if (!scope.state.workflow) throw new Error("no workflow");
    if (!scope.state.install) scope.state.install = scope.state.workflow.install();
    const registryInstall = await scope.installDeclaredPackages(request);
    const lifecycleOutput = await scope.runInstalledPackageLifecycles(request?.ignoreScripts ?? false, registryInstall);
    if (lifecycleOutput.length > 0) scope.log(lifecycleOutput.join("\n"));
    const names = new Set(scope.state.install.packages);
    for (const entry of [...registryInstall.installed, ...registryInstall.reused]) names.add(entry.name);
    scope.state.install = { ...scope.state.install, packages: [...names] };
    return { lifecycleOutput, registryInstall };
  };
}
