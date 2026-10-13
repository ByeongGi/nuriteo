export type RuntimeTraceCategory = "syscall" | "process" | "filesystem" | "network" | "package-manager" | "preview";
export type RuntimeTraceStatus = "ok" | "error";

export interface RuntimeTraceSpanInput {
  category: RuntimeTraceCategory;
  name: string;
  requestId?: string | number;
  attributes?: Record<string, string | number | boolean | null>;
}

export interface RuntimeTraceEndInput {
  status?: RuntimeTraceStatus;
  errorCode?: string;
  attributes?: Record<string, string | number | boolean | null>;
}

export interface RuntimeTraceSpan extends RuntimeTraceSpanInput {
  spanId: number;
  startedAt: number;
  endedAt: number | null;
  durationMs: number | null;
  status: RuntimeTraceStatus | "running";
  errorCode?: string;
  attributes: Record<string, string | number | boolean | null>;
}

export interface RuntimeTraceHandle {
  end(input?: RuntimeTraceEndInput): RuntimeTraceSpan;
}

export interface RuntimeTraceSink {
  startSpan(input: RuntimeTraceSpanInput): RuntimeTraceHandle;
}

export class RuntimeTraceCollector implements RuntimeTraceSink {
  readonly now: () => number;
  #nextSpanId = 1;
  #spans: RuntimeTraceSpan[] = [];

  constructor(now: () => number = () => performance.now()) {
    this.now = now;
  }

  startSpan(input: RuntimeTraceSpanInput): RuntimeTraceHandle {
    const span: RuntimeTraceSpan = {
      spanId: this.#nextSpanId++,
      startedAt: this.now(),
      endedAt: null,
      durationMs: null,
      status: "running",
      ...input,
      attributes: { ...(input.attributes || {}) }
    };
    this.#spans.push(span);
    return {
      end: (endInput = {}) => {
        if (span.endedAt !== null) return { ...span, attributes: { ...span.attributes } };
        span.endedAt = this.now();
        span.durationMs = Math.max(0, span.endedAt - span.startedAt);
        span.status = endInput.status || "ok";
        if (endInput.errorCode !== undefined) span.errorCode = endInput.errorCode;
        span.attributes = { ...span.attributes, ...(endInput.attributes || {}) };
        return { ...span, attributes: { ...span.attributes } };
      }
    };
  }

  export(): RuntimeTraceSpan[] {
    return this.#spans.map((span) => ({ ...span, attributes: { ...span.attributes } }));
  }

  clear(): void {
    this.#spans = [];
  }
}

export function createRuntimeTraceCollector(now?: () => number): RuntimeTraceCollector {
  return new RuntimeTraceCollector(now);
}
