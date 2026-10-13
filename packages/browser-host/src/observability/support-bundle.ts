import type { RuntimeTraceSpan } from "./trace.ts";

export type RuntimeDiagnosticSeverity = "info" | "warning" | "error";

export interface RuntimeDiagnostic {
  code: string;
  severity: RuntimeDiagnosticSeverity;
  message: string;
  source: string;
  requestId?: string | number;
  spanId?: number;
  remediation?: string;
}

export interface RuntimeTraceReport {
  spanCount: number;
  errorCount: number;
  runningCount: number;
  totalDurationMs: number;
  slowestSpans: RuntimeTraceSpan[];
  diagnostics: RuntimeDiagnostic[];
  flameHints: string[];
}

export interface RuntimeSupportBundleInput {
  trace?: RuntimeTraceSpan[] | { export(): RuntimeTraceSpan[] };
  logs?: readonly string[];
  diagnostics?: readonly RuntimeDiagnostic[];
  environment?: Record<string, string | number | boolean | null>;
  createdAt?: string;
  slowSpanThresholdMs?: number;
}

export interface RuntimeSupportBundle {
  schemaVersion: 1;
  createdAt: string;
  environment: Record<string, string | number | boolean | null>;
  trace: RuntimeTraceReport;
  logs: string[];
  diagnostics: RuntimeDiagnostic[];
}

const defaultSlowSpanThresholdMs = 1000;
const secretPatterns = [
  {
    pattern: /\b(authorization=)Bearer\s+[A-Za-z0-9._~+/=-]+/gi,
    replacement: "$1[REDACTED]"
  },
  {
    pattern: /\b(Bearer\s+)[A-Za-z0-9._~+/=-]+/gi,
    replacement: "$1[REDACTED]"
  },
  {
    pattern: /\b(npm_[A-Za-z0-9]+|gh[pousr]_[A-Za-z0-9_]+)\b/g,
    replacement: "[REDACTED_TOKEN]"
  },
  {
    pattern: /\b(password|passwd|token|secret|authorization|_auth|npm-auth-token)=([^&\s]+)/gi,
    replacement: "$1=[REDACTED]"
  },
  {
    pattern: /\b(cookie|set-cookie)=([^\s&]+)/gi,
    replacement: "$1=[REDACTED]"
  },
  {
    pattern: /\b((?:Cookie|Set-Cookie):\s*)(.+)/g,
    replacement: "$1[REDACTED]"
  },
  {
    pattern: /(https?:\/\/[^:/\s]+:)[^@\s]+(@)/g,
    replacement: "$1[REDACTED]$2"
  }
];

export function redactRuntimeLog(value: string): string {
  return secretPatterns.reduce((output, rule) => output.replace(rule.pattern, rule.replacement), value);
}

export function createRuntimeTraceReport(
  spans: readonly RuntimeTraceSpan[],
  options: { slowSpanThresholdMs?: number } = {}
): RuntimeTraceReport {
  const threshold = options.slowSpanThresholdMs ?? defaultSlowSpanThresholdMs;
  const completed = spans.filter((span) => span.durationMs !== null);
  const slowestSpans = [...completed]
    .sort((left, right) => (right.durationMs ?? 0) - (left.durationMs ?? 0))
    .slice(0, 5)
    .map(cloneSpan);
  const errorDiagnostics = spans
    .filter((span) => span.status === "error")
    .map(spanToErrorDiagnostic);
  const slowDiagnostics = completed
    .filter((span) => (span.durationMs ?? 0) >= threshold)
    .map((span) => spanToSlowDiagnostic(span, threshold));
  const diagnostics = [...errorDiagnostics, ...slowDiagnostics];

  return {
    spanCount: spans.length,
    errorCount: errorDiagnostics.length,
    runningCount: spans.filter((span) => span.status === "running").length,
    totalDurationMs: completed.reduce((total, span) => total + (span.durationMs ?? 0), 0),
    slowestSpans,
    diagnostics,
    flameHints: slowestSpans.map((span) => {
      const duration = span.durationMs ?? 0;
      return `${span.category}:${span.name} ${Math.round(duration)}ms`;
    })
  };
}

export function createRuntimeSupportBundle(input: RuntimeSupportBundleInput = {}): RuntimeSupportBundle {
  const spans = Array.isArray(input.trace) ? input.trace : input.trace?.export() || [];
  const traceOptions = input.slowSpanThresholdMs === undefined ? {} : { slowSpanThresholdMs: input.slowSpanThresholdMs };
  const trace = createRuntimeTraceReport(spans, traceOptions);
  const diagnostics = [...trace.diagnostics, ...(input.diagnostics || [])].map(cloneDiagnostic);
  return {
    schemaVersion: 1,
    createdAt: input.createdAt || new Date().toISOString(),
    environment: redactEnvironment(input.environment || {}),
    trace,
    logs: (input.logs || []).map(redactRuntimeLog),
    diagnostics
  };
}

function spanToErrorDiagnostic(span: RuntimeTraceSpan): RuntimeDiagnostic {
  const code = span.errorCode || "ERR_RUNTIME_TRACE_ERROR";
  return {
    code,
    severity: "error",
    message: `${span.category} operation ${span.name} failed`,
    source: span.category,
    ...(span.requestId !== undefined ? { requestId: span.requestId } : {}),
    spanId: span.spanId,
    remediation: remediationFor(code)
  };
}

function spanToSlowDiagnostic(span: RuntimeTraceSpan, threshold: number): RuntimeDiagnostic {
  return {
    code: "WARN_RUNTIME_SLOW_OPERATION",
    severity: "warning",
    message: `${span.category} operation ${span.name} exceeded ${threshold}ms`,
    source: span.category,
    ...(span.requestId !== undefined ? { requestId: span.requestId } : {}),
    spanId: span.spanId,
    remediation: "Check the slowest span list and compare it with the product performance baseline."
  };
}

function remediationFor(code: string): string {
  if (code.startsWith("ERR_PM_")) return "Review package scripts, native addon usage, and package-manager execution policy.";
  if (code.startsWith("E")) return "Retry the operation and include this support bundle if the error persists.";
  return "Inspect the trace span attributes and user-visible logs for the failing operation.";
}

function redactEnvironment(environment: Record<string, string | number | boolean | null>): Record<string, string | number | boolean | null> {
  return Object.fromEntries(
    Object.entries(environment).map(([key, value]) => {
      if (/token|secret|password|authorization|auth|cookie|_auth/i.test(key)) return [key, "[REDACTED]"];
      if (typeof value === "string") return [key, redactRuntimeLog(value)];
      return [key, value];
    })
  );
}

function cloneSpan(span: RuntimeTraceSpan): RuntimeTraceSpan {
  return { ...span, attributes: { ...span.attributes } };
}

function cloneDiagnostic(diagnostic: RuntimeDiagnostic): RuntimeDiagnostic {
  return { ...diagnostic };
}
