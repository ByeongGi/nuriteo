import {
  createRuntimeSupportBundle,
  type RuntimeDiagnostic,
  type RuntimeSupportBundle,
  type RuntimeSupportBundleInput
} from "../../browser-host/src/observability/support-bundle.ts";

export type WorkflowStage = "install" | "dev" | "build" | "preview";

export type SupportErrorCategory =
  | "unsupported"
  | "package-manager"
  | "preview"
  | "quota"
  | "permission"
  | "crash";

export type SupportRecoveryAction =
  | "retry-install"
  | "clear-package-cache"
  | "restart-dev-server"
  | "export-project";

export type RecoveryOutcomeStatus = "success" | "failure";

export const WORKFLOW_STAGES = Object.freeze(["install", "dev", "build", "preview"] as const);

export const SUPPORT_ERROR_CATEGORIES = Object.freeze([
  "unsupported",
  "package-manager",
  "preview",
  "quota",
  "permission",
  "crash"
] as const);

export const SUPPORT_RECOVERY_ACTIONS = Object.freeze([
  "retry-install",
  "clear-package-cache",
  "restart-dev-server",
  "export-project"
] as const);

export const RUNTIME_METRICS_CANDIDATES = Object.freeze([
  "bootTimeMs",
  "installTimeMs",
  "hmrLatencyMs",
  "memoryUsageBytes",
  "quotaUsageBytes",
  "quotaLimitBytes"
] as const);

/** Machine-readable mapping of diagnostic codes to user-facing support categories. */
export const ERROR_CATALOG: Readonly<Record<string, SupportErrorCategory>> = Object.freeze({
  ERR_RUNTIME_DOCKER_UNSUPPORTED: "unsupported",
  ERR_RUNTIME_TCP_DB_UNSUPPORTED: "unsupported",
  ERR_RUNTIME_UNSUPPORTED_BINARY: "unsupported",
  ERR_PM_NATIVE_ADDON_UNSUPPORTED: "unsupported",
  ERR_NURITEO_UNSUPPORTED_BINDING: "unsupported",
  ERR_NURITEO_UNSUPPORTED_SHELL_SYNTAX: "unsupported",
  ERR_IMPORT_UNSUPPORTED_PACKAGE_MANAGER: "unsupported",
  ERR_CLI_ESM_ENTRY_UNSUPPORTED: "unsupported",
  ERR_PM_CLI_ENTRY_UNSUPPORTED: "unsupported",
  ERR_BUNDLER_STRICT_CSP_FACTORY_MISSING: "unsupported",
  ERR_BUNDLER_WASM_RUNTIME_UNVALIDATED: "unsupported",
  ESTATICFACTORYINTEGRITY: "unsupported",
  ESTATICFACTORYSOURCEMISMATCH: "unsupported",
  ESTATICFACTORYWORKERMISSING: "unsupported",
  ENOWORKERASSETRESOLVER: "unsupported",
  EWORKERASSETORIGIN: "unsupported",

  ERR_PM_LIFECYCLE_BLOCKED: "permission",
  EPERMISSION: "permission",
  ELEASEHELD: "permission",

  EOPFSQUOTA: "quota",
  ERR_ABUSE_ARCHIVE_SIZE: "quota",
  ERR_ABUSE_MEMORY_GROWTH: "quota",

  ESTALESESSION: "preview",
  ENOSERVER: "preview",
  ETIMEOUT: "preview",
  EBADMESSAGE: "preview",
  EDEVSERVER_SOURCE_DELETED: "preview",
  EDEVSERVER_SOURCE_RENAMED: "preview",

  ERR_PM_REAL_CLI_EVALUATION_REQUIRED: "package-manager",
  ERR_CLI_ENTRY_MISSING: "package-manager",
  ERR_CLI_MODE_UNKNOWN: "package-manager",
  ERR_BUNDLER_FIXTURE_REVISION_INVALID: "package-manager",
  ERR_BUNDLER_INTEGRITY_MISSING: "package-manager",
  ERR_BUNDLER_VERSION_NOT_EXACT: "package-manager",
  ERR_IMPORT_HEALTH: "package-manager",
  ERR_IMPORT_LOCKFILE_CONFLICT: "package-manager",
  ERR_IMPORT_MISSING_SCRIPT: "package-manager",
  ERR_IMPORT_MISSING_PACKAGE_JSON: "package-manager",
  ERR_IMPORT_INVALID_PACKAGE_JSON: "package-manager",
  ERR_IMPORT_NETWORK: "package-manager",
  ERR_IMPORT_FILE_TOO_LARGE: "package-manager",
  ERR_IMPORT_ARCHIVE_FORMAT: "package-manager",

  ERR_RUNTIME_TRACE_ERROR: "crash",
  ERR_ABUSE_WORKER_SPAWN: "crash",
  ERR_ABUSE_LOOP_ITERATIONS: "crash",
  ERR_WORKER_CRASH: "crash",
  ERR_PROCESS_CRASH: "crash"
});

const CATEGORY_PRIORITY: Readonly<Record<SupportErrorCategory, number>> = Object.freeze({
  crash: 60,
  unsupported: 50,
  permission: 40,
  quota: 30,
  "package-manager": 20,
  preview: 10
});

export interface WorkflowTraceHandle {
  traceId: string;
  stage: WorkflowStage;
  end(input?: { status?: "ok" | "error"; errorCode?: string }): WorkflowStageSpan;
}

export interface WorkflowStageSpan {
  stage: WorkflowStage;
  traceId: string;
  startedAt: number;
  endedAt: number | null;
  durationMs: number | null;
  status: "running" | "ok" | "error";
  errorCode?: string;
}

export interface WorkflowTraceExport {
  sessionId: string;
  stages: Partial<Record<WorkflowStage, string>>;
  spans: WorkflowStageSpan[];
}

export class WorkflowTrace {
  readonly sessionId: string;
  readonly now: () => number;
  #stages = new Map<WorkflowStage, string>();
  #spans: WorkflowStageSpan[] = [];
  #seq = 0;

  constructor(sessionId: string = `wf_${Math.random().toString(16).slice(2, 10)}`, now: () => number = () => Date.now()) {
    this.sessionId = sessionId;
    this.now = now;
  }

  startStage(stage: WorkflowStage): WorkflowTraceHandle {
    if (!(WORKFLOW_STAGES as readonly string[]).includes(stage)) {
      throw new Error(`Unsupported workflow stage: ${String(stage)}`);
    }
    this.#seq += 1;
    const traceId = `${this.sessionId}:${stage}:${this.#seq}`;
    this.#stages.set(stage, traceId);
    const span: WorkflowStageSpan = {
      stage,
      traceId,
      startedAt: this.now(),
      endedAt: null,
      durationMs: null,
      status: "running"
    };
    this.#spans.push(span);
    return {
      traceId,
      stage,
      end: (input = {}) => {
        if (span.endedAt !== null) {
          return cloneStageSpan(span);
        }
        span.endedAt = this.now();
        span.durationMs = Math.max(0, span.endedAt - span.startedAt);
        span.status = input.status || "ok";
        if (input.errorCode !== undefined) span.errorCode = input.errorCode;
        return cloneStageSpan(span);
      }
    };
  }

  traceIdFor(stage: WorkflowStage): string | undefined {
    return this.#stages.get(stage);
  }

  export(): WorkflowTraceExport {
    return {
      sessionId: this.sessionId,
      stages: Object.fromEntries(this.#stages.entries()) as Partial<Record<WorkflowStage, string>>,
      spans: this.#spans.map(cloneStageSpan)
    };
  }
}

export function createWorkflowTrace(sessionId?: string, now?: () => number): WorkflowTrace {
  return new WorkflowTrace(sessionId, now);
}

export function classifyErrorCode(code: string): SupportErrorCategory | null {
  if (!code) return null;
  const exact = ERROR_CATALOG[code];
  if (exact) return exact;
  if (code.startsWith("ERR_RUNTIME_") && code.includes("UNSUPPORTED")) return "unsupported";
  if (code.startsWith("ERR_PM_NATIVE") || code.includes("UNSUPPORTED")) return "unsupported";
  if (code === "EPERMISSION" || code.startsWith("ERR_PM_LIFECYCLE")) return "permission";
  if (code === "EOPFSQUOTA" || code.includes("QUOTA")) return "quota";
  if (code.startsWith("ERR_PM_") || code.startsWith("ERR_CLI_") || code.startsWith("ERR_IMPORT_")) return "package-manager";
  if (code === "ESTALESESSION" || code === "ENOSERVER" || code === "ETIMEOUT" || code === "EBADMESSAGE") return "preview";
  if (code.includes("CRASH") || code === "ERR_RUNTIME_TRACE_ERROR") return "crash";
  return null;
}

export interface ClassifiableSupportBundle {
  diagnostics?: readonly RuntimeDiagnostic[] | readonly { code?: string; severity?: string }[];
  logs?: readonly string[];
  environment?: Record<string, unknown>;
  trace?: { diagnostics?: readonly RuntimeDiagnostic[] };
}

export function classifySupportBundle(bundle: ClassifiableSupportBundle): SupportErrorCategory | "unknown" {
  const codes = collectBundleCodes(bundle);
  let best: SupportErrorCategory | null = null;
  let bestScore = -1;
  for (const code of codes) {
    const category = classifyErrorCode(code);
    if (!category) continue;
    const score = CATEGORY_PRIORITY[category];
    if (score > bestScore) {
      best = category;
      bestScore = score;
    }
  }
  if (best) return best;

  const haystack = `${(bundle.logs || []).join("\n")} ${JSON.stringify(bundle.environment || {})}`.toLowerCase();
  if (/\b(crash|segfault|worker terminated)\b/.test(haystack)) return "crash";
  if (/\bunsupported\b/.test(haystack)) return "unsupported";
  if (/\bpermission denied\b|\bepermission\b/.test(haystack)) return "permission";
  if (/\bquota\b|\beopfsquota\b/.test(haystack)) return "quota";
  if (/\bnpm\b|\bpnpm\b|\binstall\b/.test(haystack)) return "package-manager";
  if (/\bpreview\b|\bhmr\b|\bestalesession\b/.test(haystack)) return "preview";
  return "unknown";
}

export function aggregateFailureCategories(
  bundles: readonly ClassifiableSupportBundle[]
): Array<{ category: SupportErrorCategory | "unknown"; count: number }> {
  const counts = new Map<SupportErrorCategory | "unknown", number>();
  for (const bundle of bundles) {
    const category = classifySupportBundle(bundle);
    counts.set(category, (counts.get(category) || 0) + 1);
  }
  return [...counts.entries()]
    .map(([category, count]) => ({ category, count }))
    .sort((left, right) => right.count - left.count || String(left.category).localeCompare(String(right.category)));
}

export function exportSupportBundle(input: RuntimeSupportBundleInput = {}): {
  bundle: RuntimeSupportBundle;
  serialized: string;
} {
  const bundle = createRuntimeSupportBundle(input);
  return {
    bundle,
    serialized: JSON.stringify(bundle)
  };
}

export function importSupportBundle(payload: string | RuntimeSupportBundle | ClassifiableSupportBundle): RuntimeSupportBundle {
  const parsed = typeof payload === "string" ? JSON.parse(payload) as ClassifiableSupportBundle & {
    schemaVersion?: number;
    createdAt?: string;
    environment?: Record<string, string | number | boolean | null>;
    logs?: readonly string[];
    diagnostics?: readonly RuntimeDiagnostic[];
    trace?: RuntimeSupportBundle["trace"] | RuntimeSupportBundleInput["trace"];
  } : payload;

  if (!parsed || typeof parsed !== "object") {
    throw new Error("Support bundle payload must be an object");
  }

  const diagnostics = Array.isArray(parsed.diagnostics) ? [...parsed.diagnostics] : [];
  const logs = Array.isArray(parsed.logs) ? [...parsed.logs] : [];
  const environment = parsed.environment && typeof parsed.environment === "object"
    ? Object.fromEntries(
      Object.entries(parsed.environment).map(([key, value]) => {
        if (typeof value === "string" || typeof value === "number" || typeof value === "boolean" || value === null) {
          return [key, value];
        }
        return [key, String(value)];
      })
    )
    : {};

  const schemaVersion = (parsed as { schemaVersion?: number }).schemaVersion;
  if (schemaVersion !== undefined && schemaVersion !== 1) {
    throw new Error(`Unsupported support bundle schemaVersion: ${String(schemaVersion)}`);
  }

  const createdAt = (parsed as { createdAt?: string }).createdAt;
  const rawTrace = (parsed as { trace?: RuntimeSupportBundleInput["trace"] }).trace;
  const input: RuntimeSupportBundleInput = {
    diagnostics,
    logs,
    environment
  };
  if (typeof createdAt === "string") input.createdAt = createdAt;
  if (Array.isArray(rawTrace)) input.trace = rawTrace;

  // Re-run through createRuntimeSupportBundle so import path redacts secrets consistently.
  return createRuntimeSupportBundle(input);
}

export interface RecoveryOutcomeRecord {
  action: SupportRecoveryAction;
  status: RecoveryOutcomeStatus;
  recordedAt: string;
  detail?: string;
}

const recoveryOutcomes: RecoveryOutcomeRecord[] = [];

export function recordRecoveryOutcome(
  action: SupportRecoveryAction,
  status: RecoveryOutcomeStatus,
  detail?: string
): RecoveryOutcomeRecord {
  if (!(SUPPORT_RECOVERY_ACTIONS as readonly string[]).includes(action)) {
    throw new Error(`Unsupported recovery action: ${String(action)}`);
  }
  if (status !== "success" && status !== "failure") {
    throw new Error(`Unsupported recovery status: ${String(status)}`);
  }
  const record: RecoveryOutcomeRecord = {
    action,
    status,
    recordedAt: new Date().toISOString(),
    ...(detail !== undefined ? { detail } : {})
  };
  recoveryOutcomes.push(record);
  return { ...record };
}

export function listRecoveryOutcomes(): RecoveryOutcomeRecord[] {
  return recoveryOutcomes.map((entry) => ({ ...entry }));
}

export function clearRecoveryOutcomes(): void {
  recoveryOutcomes.length = 0;
}

export interface RuntimeMetricsCandidates {
  bootTimeMs?: number;
  installTimeMs?: number;
  hmrLatencyMs?: number;
  memoryUsageBytes?: number;
  quotaUsageBytes?: number;
  quotaLimitBytes?: number;
}

export function createRuntimeMetricsSnapshot(input: RuntimeMetricsCandidates = {}): RuntimeMetricsCandidates {
  const snapshot: RuntimeMetricsCandidates = {};
  if (input.bootTimeMs !== undefined) snapshot.bootTimeMs = input.bootTimeMs;
  if (input.installTimeMs !== undefined) snapshot.installTimeMs = input.installTimeMs;
  if (input.hmrLatencyMs !== undefined) snapshot.hmrLatencyMs = input.hmrLatencyMs;
  if (input.memoryUsageBytes !== undefined) snapshot.memoryUsageBytes = input.memoryUsageBytes;
  if (input.quotaUsageBytes !== undefined) snapshot.quotaUsageBytes = input.quotaUsageBytes;
  if (input.quotaLimitBytes !== undefined) snapshot.quotaLimitBytes = input.quotaLimitBytes;
  return snapshot;
}

export interface FailedWorkflowReplaySnapshot {
  phase?: string | null;
  stage?: WorkflowStage | null;
  projectId?: string | null;
  manager?: string | null;
  previewUrl?: string | null;
  diagnostics?: readonly RuntimeDiagnostic[];
  logs?: readonly string[];
  environment?: Record<string, string | number | boolean | null>;
  trace?: WorkflowTrace | WorkflowTraceExport | RuntimeSupportBundleInput["trace"];
  metrics?: RuntimeMetricsCandidates;
  recoveryOutcomes?: readonly RecoveryOutcomeRecord[];
  lastError?: { message?: string; code?: string; source?: string } | null;
}

export interface FailedWorkflowReplayFixture {
  schemaVersion: 1;
  kind: "failed-workflow-replay";
  createdAt: string;
  stage: WorkflowStage | null;
  category: SupportErrorCategory | "unknown";
  traceIds: Partial<Record<WorkflowStage, string>>;
  supportBundle: RuntimeSupportBundle;
  metrics: RuntimeMetricsCandidates;
  recoveryOutcomes: RecoveryOutcomeRecord[];
  snapshot: {
    phase: string | null;
    projectId: string | null;
    manager: string | null;
    previewUrl: string | null;
    lastError: FailedWorkflowReplaySnapshot["lastError"];
  };
}

export function createFailedWorkflowReplayFixture(snapshot: FailedWorkflowReplaySnapshot): FailedWorkflowReplayFixture {
  const workflowTrace = readWorkflowTraceExport(snapshot.trace);
  const traceIds = workflowTrace?.stages || {};
  const stage = snapshot.stage
    || inferStageFromPhase(snapshot.phase)
    || (workflowTrace?.spans.at(-1)?.stage ?? null);

  const diagnostics = [...(snapshot.diagnostics || [])];
  if (snapshot.lastError?.code || snapshot.lastError?.message) {
    diagnostics.push({
      code: snapshot.lastError.code || "ERR_WORKFLOW_FAILED",
      severity: "error",
      message: snapshot.lastError.message || "Workflow failed",
      source: snapshot.lastError.source || stage || "workflow"
    });
  }

  const runtimeTrace = toRuntimeTraceInput(snapshot.trace);
  const environment: Record<string, string | number | boolean | null> = {
    ...(snapshot.environment || {})
  };
  if (snapshot.projectId) environment.projectId = snapshot.projectId;
  if (snapshot.manager) environment.packageManager = snapshot.manager;
  if (stage) environment.workflowStage = stage;

  const supportInput: RuntimeSupportBundleInput = {
    diagnostics,
    logs: snapshot.logs || [],
    environment
  };
  if (runtimeTrace !== undefined) supportInput.trace = runtimeTrace;

  const { bundle } = exportSupportBundle(supportInput);

  return {
    schemaVersion: 1,
    kind: "failed-workflow-replay",
    createdAt: new Date().toISOString(),
    stage,
    category: classifySupportBundle(bundle),
    traceIds: { ...traceIds },
    supportBundle: bundle,
    metrics: createRuntimeMetricsSnapshot(snapshot.metrics || {}),
    recoveryOutcomes: (snapshot.recoveryOutcomes || listRecoveryOutcomes()).map((entry) => ({ ...entry })),
    snapshot: {
      phase: snapshot.phase ?? null,
      projectId: snapshot.projectId ?? null,
      manager: snapshot.manager ?? null,
      previewUrl: snapshot.previewUrl ?? null,
      lastError: snapshot.lastError ?? null
    }
  };
}

function readWorkflowTraceExport(trace: FailedWorkflowReplaySnapshot["trace"]): WorkflowTraceExport | null {
  if (!trace) return null;
  if (trace instanceof WorkflowTrace) return trace.export();
  if (
    typeof trace === "object"
    && !Array.isArray(trace)
    && "sessionId" in trace
    && "stages" in trace
    && "spans" in trace
  ) {
    return trace as WorkflowTraceExport;
  }
  return null;
}

function toRuntimeTraceInput(
  trace: FailedWorkflowReplaySnapshot["trace"]
): RuntimeSupportBundleInput["trace"] | undefined {
  if (!trace) return undefined;
  if (trace instanceof WorkflowTrace) return undefined;
  if (readWorkflowTraceExport(trace)) return undefined;
  if (Array.isArray(trace)) return trace;
  if (typeof (trace as { export?: unknown }).export === "function") {
    return trace as { export(): import("../../browser-host/src/observability/trace.ts").RuntimeTraceSpan[] };
  }
  return undefined;
}

function collectBundleCodes(bundle: ClassifiableSupportBundle): string[] {
  const codes: string[] = [];
  for (const diagnostic of bundle.diagnostics || []) {
    if (diagnostic?.code) codes.push(String(diagnostic.code));
  }
  for (const diagnostic of bundle.trace?.diagnostics || []) {
    if (diagnostic?.code) codes.push(String(diagnostic.code));
  }
  return codes;
}

function inferStageFromPhase(phase: string | null | undefined): WorkflowStage | null {
  if (!phase) return null;
  if (phase.includes("install")) return "install";
  if (phase.includes("build")) return "build";
  if (phase.includes("preview") || phase.includes("hmr")) return "preview";
  if (phase.includes("dev")) return "dev";
  return null;
}

function cloneStageSpan(span: WorkflowStageSpan): WorkflowStageSpan {
  return {
    stage: span.stage,
    traceId: span.traceId,
    startedAt: span.startedAt,
    endedAt: span.endedAt,
    durationMs: span.durationMs,
    status: span.status,
    ...(span.errorCode !== undefined ? { errorCode: span.errorCode } : {})
  };
}
