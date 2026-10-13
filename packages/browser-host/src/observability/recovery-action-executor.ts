import type { RuntimeRecoveryAction } from "./recovery-actions.ts";
import type { RuntimeSupportBundle } from "./support-bundle.ts";

export type RuntimeRecoveryActionStatus = "handled" | "unhandled" | "failed";

export interface RuntimeRecoveryActionExecutionResult {
  action: RuntimeRecoveryAction;
  message: string;
  status: RuntimeRecoveryActionStatus;
  value?: unknown;
}

export interface RuntimeRecoveryActionExecutorHandlers {
  clearCache?: (action: RuntimeRecoveryAction) => unknown | Promise<unknown>;
  exportSupportBundle?: (
    bundle: RuntimeSupportBundle,
    action: RuntimeRecoveryAction
  ) => unknown | Promise<unknown>;
  openDocs?: (href: string | undefined, action: RuntimeRecoveryAction) => unknown | Promise<unknown>;
  resetRuntime?: (action: RuntimeRecoveryAction) => unknown | Promise<unknown>;
  resolveWriterConflict?: (action: RuntimeRecoveryAction) => unknown | Promise<unknown>;
  retry?: (action: RuntimeRecoveryAction) => unknown | Promise<unknown>;
}

export interface RuntimeRecoveryActionExecutorOptions {
  handlers?: RuntimeRecoveryActionExecutorHandlers;
  supportBundle?: RuntimeSupportBundle | null;
}

export class RuntimeRecoveryActionExecutor {
  #handlers: RuntimeRecoveryActionExecutorHandlers;
  #supportBundle: RuntimeSupportBundle | null;

  constructor(options: RuntimeRecoveryActionExecutorOptions = {}) {
    this.#handlers = options.handlers || {};
    this.#supportBundle = options.supportBundle || null;
  }

  setSupportBundle(bundle: RuntimeSupportBundle | null): void {
    this.#supportBundle = bundle;
  }

  async execute(action: RuntimeRecoveryAction): Promise<RuntimeRecoveryActionExecutionResult> {
    try {
      const result = await this.#executeKnownAction(action);
      if (result) return result;
      return {
        action,
        message: `No recovery handler registered for ${action.kind}.`,
        status: "unhandled"
      };
    } catch (error) {
      return {
        action,
        message: error instanceof Error ? error.message : String(error),
        status: "failed"
      };
    }
  }

  async #executeKnownAction(action: RuntimeRecoveryAction): Promise<RuntimeRecoveryActionExecutionResult | null> {
    if (action.kind === "retry") return this.#runHandler(action, this.#handlers.retry, "Retried operation.");
    if (action.kind === "reset-runtime") return this.#runHandler(action, this.#handlers.resetRuntime, "Restarted runtime.");
    if (action.kind === "clear-cache") return this.#runHandler(action, this.#handlers.clearCache, "Cleared cache.");
    if (action.kind === "resolve-writer-conflict") {
      return this.#runHandler(action, this.#handlers.resolveWriterConflict, "Resolved writer lease conflict.");
    }
    if (action.kind === "open-docs") {
      return this.#runHandler(action, (registeredAction) => this.#handlers.openDocs?.(registeredAction.href, registeredAction), "Opened documentation.");
    }
    if (action.kind === "export-support-bundle") {
      if (!this.#supportBundle) {
        return {
          action,
          message: "No support bundle is available.",
          status: "unhandled"
        };
      }
      return this.#runHandler(
        action,
        (registeredAction) => this.#handlers.exportSupportBundle?.(this.#supportBundle as RuntimeSupportBundle, registeredAction),
        "Exported support bundle."
      );
    }
    return null;
  }

  async #runHandler(
    action: RuntimeRecoveryAction,
    handler: ((action: RuntimeRecoveryAction) => unknown | Promise<unknown>) | undefined,
    message: string
  ): Promise<RuntimeRecoveryActionExecutionResult> {
    if (!handler) {
      return {
        action,
        message: `No recovery handler registered for ${action.kind}.`,
        status: "unhandled"
      };
    }
    return {
      action,
      message,
      status: "handled",
      value: await handler(action)
    };
  }
}

export function createRuntimeRecoveryActionExecutor(
  options: RuntimeRecoveryActionExecutorOptions = {}
): RuntimeRecoveryActionExecutor {
  return new RuntimeRecoveryActionExecutor(options);
}
