export type AbuseLimitKind = "worker-spawn" | "archive" | "loop" | "memory-growth";
export type AbuseDecision = "allow" | "deny";
export type AbuseErrorCode =
  | "ERR_ABUSE_WORKER_SPAWN"
  | "ERR_ABUSE_ARCHIVE_SIZE"
  | "ERR_ABUSE_LOOP_ITERATIONS"
  | "ERR_ABUSE_MEMORY_GROWTH"
  | (string & {});

export interface AbuseLimitPolicy {
  maxWorkerSpawn: number;
  maxArchiveBytes: number;
  maxLoopIterations: number;
  maxMemoryGrowthBytes: number;
}

export interface AbuseCheckRequest {
  kind: AbuseLimitKind;
  workerSpawnCount?: number;
  archiveBytes?: number;
  loopIterations?: number;
  memoryGrowthBytes?: number;
  projectId?: string;
}

export interface AbuseDiagnostic {
  code: AbuseErrorCode;
  severity: "error";
  message: string;
  source: "security:abuse";
  remediation: string;
  projectId?: string;
  kind: AbuseLimitKind;
  observed: number;
  limit: number;
}

export interface AbuseCheckResult {
  decision: AbuseDecision;
  diagnostic: AbuseDiagnostic | null;
}

export const DEFAULT_ABUSE_LIMIT_POLICY: AbuseLimitPolicy = {
  maxWorkerSpawn: 16,
  maxArchiveBytes: 25 * 1024 * 1024,
  maxLoopIterations: 1_000_000,
  maxMemoryGrowthBytes: 256 * 1024 * 1024
};

export function createAbuseLimitPolicy(overrides: Partial<AbuseLimitPolicy> = {}): AbuseLimitPolicy {
  return {
    ...DEFAULT_ABUSE_LIMIT_POLICY,
    ...overrides
  };
}

export class AbuseLimitError extends Error {
  code: AbuseErrorCode;
  diagnostic: AbuseDiagnostic;

  constructor(diagnostic: AbuseDiagnostic) {
    super(diagnostic.message);
    this.name = "AbuseLimitError";
    this.code = diagnostic.code;
    this.diagnostic = diagnostic;
  }
}

export function checkAbuse(
  request: AbuseCheckRequest,
  policy: AbuseLimitPolicy = DEFAULT_ABUSE_LIMIT_POLICY
): AbuseCheckResult {
  const observed = observedFor(request);
  const limit = limitFor(request.kind, policy);
  if (observed <= limit) {
    return { decision: "allow", diagnostic: null };
  }

  return {
    decision: "deny",
    diagnostic: {
      code: codeFor(request.kind),
      severity: "error",
      message: messageFor(request.kind, observed, limit),
      source: "security:abuse",
      remediation: remediationFor(request.kind),
      ...(request.projectId ? { projectId: request.projectId } : {}),
      kind: request.kind,
      observed,
      limit
    }
  };
}

export function assertAbuseAllowed(
  request: AbuseCheckRequest,
  policy: AbuseLimitPolicy = DEFAULT_ABUSE_LIMIT_POLICY
): void {
  const result = checkAbuse(request, policy);
  if (result.decision === "deny" && result.diagnostic) {
    throw new AbuseLimitError(result.diagnostic);
  }
}

function observedFor(request: AbuseCheckRequest): number {
  switch (request.kind) {
    case "worker-spawn":
      return request.workerSpawnCount ?? 0;
    case "archive":
      return request.archiveBytes ?? 0;
    case "loop":
      return request.loopIterations ?? 0;
    case "memory-growth":
      return request.memoryGrowthBytes ?? 0;
  }
}

function limitFor(kind: AbuseLimitKind, policy: AbuseLimitPolicy): number {
  switch (kind) {
    case "worker-spawn":
      return policy.maxWorkerSpawn;
    case "archive":
      return policy.maxArchiveBytes;
    case "loop":
      return policy.maxLoopIterations;
    case "memory-growth":
      return policy.maxMemoryGrowthBytes;
  }
}

function codeFor(kind: AbuseLimitKind): AbuseErrorCode {
  switch (kind) {
    case "worker-spawn":
      return "ERR_ABUSE_WORKER_SPAWN";
    case "archive":
      return "ERR_ABUSE_ARCHIVE_SIZE";
    case "loop":
      return "ERR_ABUSE_LOOP_ITERATIONS";
    case "memory-growth":
      return "ERR_ABUSE_MEMORY_GROWTH";
  }
}

function messageFor(kind: AbuseLimitKind, observed: number, limit: number): string {
  switch (kind) {
    case "worker-spawn":
      return `Worker spawn count ${observed} exceeded abuse limit ${limit}.`;
    case "archive":
      return `Archive size ${observed} bytes exceeded abuse limit ${limit} bytes.`;
    case "loop":
      return `Loop iterations ${observed} exceeded abuse limit ${limit}.`;
    case "memory-growth":
      return `Memory growth ${observed} bytes exceeded abuse limit ${limit} bytes.`;
  }
}

function remediationFor(kind: AbuseLimitKind): string {
  switch (kind) {
    case "worker-spawn":
      return "Reduce concurrent workers or raise the configured worker spawn limit for trusted workloads.";
    case "archive":
      return "Import a smaller archive or raise the archive size limit for trusted projects.";
    case "loop":
      return "Stop the runaway loop, inspect the package script, and retry with a bounded workload.";
    case "memory-growth":
      return "Free cached artifacts, restart the runtime, or lower peak memory usage before retrying.";
  }
}
