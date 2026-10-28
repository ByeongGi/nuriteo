


import type { RegistryInstallResult } from "../../node-runtime/src/package-managers/registry-installer.ts";
import { createPreviewRelay, createPreviewServiceWorker, createPreviewSessionRegistry } from "../../preview/src/index.ts";
import { createPreviewReliabilitySession } from "./reliability.ts";

import { executeWorkspaceNode, executeWorkspacePackageScript, readWorkspacePackageScript } from "./package-script.ts";

import { PHASES } from "./controller-contracts.ts";
import type { PreviewWorkflowController, PreviewWorkflowControllerOptions, PreviewWorkflowListener } from "./controller-contracts.ts";
import { createPreviewShellLifecycle } from "./shell-lifecycle.ts";

import type { PreviewControllerScope } from "./controller-scope.ts";
import { bindPreviewControllerSession } from "./controller-session.ts";
import { bindPreviewControllerFiles } from "./controller-files.ts";
import { bindPreviewControllerCommands } from "./controller-commands.ts";
import type { PreviewWorkflowState } from "./controller-scope.ts";

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
    directories: [],
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


  const scope = {
    options,
    get listeners() { return listeners; },
    get disposed() { return disposed; },
    set disposed(value: boolean) { disposed = value; },
    get disposeComplete() { return disposeComplete; },
    set disposeComplete(value: boolean) { disposeComplete = value; },
    get operationGeneration() { return operationGeneration; },
    set operationGeneration(value: number) { operationGeneration = value; },
    get operationControllers() { return operationControllers; },
    get sessionHeartbeat() { return sessionHeartbeat; },
    set sessionHeartbeat(value: ReturnType<typeof setInterval> | null) { sessionHeartbeat = value; },
    get state() { return state; }
  } as PreviewControllerScope;
  bindPreviewControllerSession(scope);
  bindPreviewControllerFiles(scope);
  bindPreviewControllerCommands(scope);
  try {
    state.reliability.acquireWriter();
  } catch (error) {
    scope.applyStorageDiagnostic(error);
  }

  const importSnapshot = scope.bootSnapshot;

  const shellLifecycle = createPreviewShellLifecycle({
    getCwd: () => state.workflow?.projectRoot || state.project?.root || "/workspace/app",
    getProject: () => state.project,
    terminalProcessTable: options.terminalProcessTable || null,
    log: scope.log,
    onProcessFinish(command, exitCode) {
      scope.emit("log", { line: "shell", command, exitCode });
    },
    onProcessStart(terminalId, command) {
      scope.emit("log", { line: "shell-process-start", terminalId, command });
    },
    install: async (request) => {
      if (!state.workflow) scope.loadTemplate("vite-react");
      if (!state.workflow) return { stdout: "", stderr: "no workflow\n", exitCode: 1 };
      try {
        scope.setPhase(PHASES.installing);
        const projectInstall = await scope.installProjectPackages(request) as { lifecycleOutput: string[]; registryInstall: RegistryInstallResult };
        const registryInstall = projectInstall.registryInstall;
        const lifecycleOutput = projectInstall.lifecycleOutput;
        scope.syncWorkflowFilesToProject();
        scope.setPhase(PHASES.installed);
        const installed = registryInstall.installed.map((entry) => `${entry.name}@${entry.version}`);
        const reused = registryInstall.reused.map((entry) => `${entry.name}@${entry.version}`);
        const stdout = [
          `설치됨 packages=${state.install?.packages.join(",") ?? ""}`,
          ...(installed.length ? [`added ${installed.join(", ")}`] : []),
          ...(reused.length ? [`reused ${reused.join(", ")}`] : []),
          ...lifecycleOutput
        ].join("\n") + "\n";
        scope.log(stdout.trim());
        return { stdout, stderr: "", exitCode: 0 };
      } catch (error) {
        scope.setError(error, "preview");
        return {
          stdout: "",
          stderr: `${error instanceof Error ? error.message : String(error)}\n`,
          exitCode: 1
        };
      }
    },
    runScript: async (name, args = []) => {
      try {
        if (!state.workflow) return { stdout: "", stderr: "no workflow\n", exitCode: 1 };
        const script = readWorkspacePackageScript(state.workflow, name);
        if (script.kind === "dev") {
          await scope.runPreview(name);
          return { stdout: `dev server ready ${state.previewUrl || ""}\n`, stderr: "", exitCode: 0 };
        }
        if (script.kind === "build") {
          await scope.runBuild(name);
          scope.syncWorkflowFilesToProject();
          return {
            stdout: `build ok files=${(state.build?.files || []).join(",")}\n`,
            stderr: "",
            exitCode: 0
          };
        }
        const result = await executeWorkspacePackageScript(state.workflow, script, args);
        scope.syncWorkflowFilesToProject();
        return result;
      } catch (error) {
        return { stdout: "", stderr: `${error instanceof Error ? error.message : String(error)}\n`, exitCode: 1 };
      }
    },
    runNode: async (cwd, args, stdin = "") => {
      try {
        if (!state.workflow) return { stdout: "", stderr: "no workflow\n", exitCode: 1 };
        const result = await executeWorkspaceNode(state.workflow, cwd, args, stdin);
        scope.syncWorkflowFilesToProject();
        return result;
      } catch (error) {
        return { stdout: "", stderr: `${error instanceof Error ? error.message : String(error)}\n`, exitCode: 1 };
      }
    },
    restartDev: async () => {
      try {
        await scope.restartDev();
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
    runShellCommand: runShellCommandInSession,
    signalShell,
    writeShellInput
  } = shellLifecycle;
  scope.disposeShellLifecycle = disposeShellLifecycle;
  scope.runShellCommandInSession = runShellCommandInSession;

  return {
    on(listener) {
      if (disposed) return () => false;
      listeners.add(listener);
      return () => listeners.delete(listener);
    },
    getSnapshot: scope.getSnapshot,
    loadViteReactTemplate: scope.loadViteReactTemplate,
    loadTemplate: scope.loadTemplate,
    importZipFile: scope.importZipFile,
    importGitHub: scope.importGitHub,
    importSnapshot,
    importProjectFiles: scope.importProjectFiles,
    exportProjectFiles: scope.exportProjectFiles,
    bootSnapshot: scope.bootSnapshot,
    exportZip: scope.exportZip,
    exportSnapshot: scope.exportSnapshot,
    exportTreeJson: scope.exportTreeJson,
    exportPathZip: scope.exportPathZip,
    setPackageManagerOverride: scope.setPackageManagerOverride,
    setPreviewErrorBridge: scope.setPreviewErrorBridge,
    getChangeStatus: scope.getChangeStatus,
    createTextFile: scope.createTextFile,
    createDirectory: scope.createDirectory,
    renameFile: scope.renameFile,
    movePath: scope.movePath,
    deleteFile: scope.deleteFile,
    deletePath: scope.deletePath,
    cancelPreview: scope.cancelPreview,
    saveTextFile: scope.saveTextFile,
    syncDeclaredPackages: scope.syncDeclaredPackages,
    runPreview: scope.runPreview,
    restartDev: scope.restartDev,
    reconnectHmr: scope.reconnectHmr,
    runBuild: scope.runBuild,
    stopPreviewPort: scope.stopPreviewPort,
    ensureServiceWorker: scope.ensureServiceWorker,
    clearPackageCache: scope.clearPackageCache,
    resolveWriterConflict: scope.resolveWriterConflict,
    runRecoveryAction: scope.runRecoveryAction,
    simulateQuotaPressure: scope.simulateQuotaPressure,
    runShellCommand: scope.runShellCommand,
    writeShellInput,
    resizeShell,
    signalShell,
    closeShell,
    listShellProcesses,
    cancelShellCommand,
    dispose: scope.dispose,
    log: scope.log
  };
}
