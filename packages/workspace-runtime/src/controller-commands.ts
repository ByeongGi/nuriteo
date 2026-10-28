


import type { PreviewWorkflowSnapshot } from "./controller-contracts.ts";


import type { PreviewControllerScope } from "./controller-scope.ts";

export function bindPreviewControllerCommands(scope: PreviewControllerScope): void {
  scope.runShellCommand = async function runShellCommand(
    command: string,
    terminalId?: string,
    onOutput?: (chunk: { stream: "stdout" | "stderr"; data: string }) => void
  ) {
    try {
      return await scope.runShellCommandInSession(command, terminalId, onOutput);
    } finally {
      scope.syncProjectFilesToWorkflow();
    }
  };

  scope.dispose = function dispose(): void {
    if (scope.disposeComplete) return;
    if (!scope.disposed) {
      scope.disposed = true;
      scope.operationGeneration += 1;
      for (const controller of scope.operationControllers) controller.abort();
      scope.operationControllers.clear();
    }
    const failures: unknown[] = [];
    try {
      if (scope.state.fetchBridgeBound && typeof navigator !== "undefined") {
        navigator.serviceWorker?.removeEventListener("message", scope.onServiceWorkerMessage);
        scope.state.fetchBridgeBound = false;
      }
    } catch (error) { failures.push(error); }
    try { scope.disposeShellLifecycle(); } catch (error) { failures.push(error); }
    try { scope.clearRuntime(); } catch (error) { failures.push(error); }
    try { scope.state.reliability.releaseWriter(); } catch (error) { failures.push(error); }
    scope.listeners.clear();
    if (failures.length > 0) throw new AggregateError(failures, "Preview controller cleanup failed");
    scope.disposeComplete = true;
  };

  scope.getSnapshot = function getSnapshot(): PreviewWorkflowSnapshot {
    return {
      phase: scope.state.phase,
      projectId: scope.state.workflow?.projectId || scope.state.project?.projectId || null,
      manager: scope.state.workflow?.manager || scope.state.health?.detection.packageManager || null,
      template: scope.state.workflow?.template || null,
      source: scope.state.source,
      health: scope.state.health,
      packageManagerOverride: scope.state.packageManagerOverride,
      previewUrl: scope.state.previewUrl,
      hmrState: scope.state.hmrState,
      install: scope.state.install,
      build: scope.state.build,
      lastError: scope.state.lastError,
      diagnostics: scope.state.diagnostics.map((entry) => ({ ...entry })),
      logs: [...scope.state.logs],
      editor: scope.state.editor,
      project: scope.state.project,
      workflow: scope.state.workflow,
      session: scope.state.session
    };
  };
}
