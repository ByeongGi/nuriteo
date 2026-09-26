import type { DapEvent, DapRequest, DapResponse } from "./dapProtocol.ts";
import { DEBUG_FIXTURE_SOURCE_MAP, DEBUG_FIXTURE_SOURCE_URI, RuntimeSourceMap } from "./sourceMap.ts";

type RuntimeBreakpoint = { sourceLine: number; generatedLine: number; condition?: string };

export class FixtureDebugAdapter {
  readonly #send: (message: DapResponse | DapEvent) => void;
  #sequence = 1;
  readonly #sourceMap = new RuntimeSourceMap(DEBUG_FIXTURE_SOURCE_MAP);
  #generatedLine = 3;
  #breakpoints: RuntimeBreakpoint[] = [];
  #launched = false;
  #counter = 0;

  constructor(send: (message: DapResponse | DapEvent) => void) {
    this.#send = send;
  }

  receive(request: DapRequest): void {
    try {
      this.#respond(request, this.#handle(request));
    } catch (error) {
      this.#send({
        seq: this.#sequence++,
        type: "response",
        request_seq: request.seq,
        success: false,
        command: request.command,
        message: error instanceof Error ? error.message : String(error)
      });
    }
  }

  #handle(request: DapRequest): unknown {
    switch (request.command) {
      case "initialize":
        queueMicrotask(() => this.#event("initialized"));
        return { supportsTerminateRequest: true, supportsConfigurationDoneRequest: true };
      case "launch":
        this.#launched = true;
        this.#generatedLine = 3;
        this.#counter = 0;
        return {};
      case "setBreakpoints": {
        const args = request.arguments as { source?: { path?: string }; breakpoints?: Array<{ line: number; condition?: string }> };
        const sourceUri = args.source?.path || DEBUG_FIXTURE_SOURCE_URI;
        this.#breakpoints = (args.breakpoints || []).flatMap((breakpoint) => {
          const generated = this.#sourceMap.generatedPositionFor(sourceUri, breakpoint.line);
          return generated ? [{ sourceLine: breakpoint.line, generatedLine: generated.line, ...(breakpoint.condition ? { condition: breakpoint.condition } : {}) }] : [];
        });
        return {
          breakpoints: (args.breakpoints || []).map((breakpoint) => ({
            verified: this.#breakpoints.some((entry) => entry.sourceLine === breakpoint.line),
            line: breakpoint.line,
            source: { path: sourceUri }
          }))
        };
      }
      case "configurationDone":
        this.#assertLaunched();
        this.#generatedLine = this.#breakpoints[0]?.generatedLine || 5;
        this.#satisfyBreakpointCondition(this.#breakpoints[0]);
        queueMicrotask(() => this.#event("stopped", { reason: "breakpoint", threadId: 1 }));
        return {};
      case "continue":
        this.#assertLaunched();
        this.#counter += 1;
        this.#satisfyBreakpointCondition(this.#breakpoints[0]);
        queueMicrotask(() => this.#event("stopped", { reason: "breakpoint", threadId: 1 }));
        return { allThreadsContinued: true };
      case "next":
      case "stepIn":
      case "stepOut":
        this.#assertLaunched();
        this.#generatedLine += 1;
        this.#counter += 1;
        queueMicrotask(() => this.#event("stopped", { reason: "step", threadId: 1 }));
        return {};
      case "threads":
        return { threads: [{ id: 1, name: "main" }] };
      case "stackTrace":
        return this.#stackTrace();
      case "scopes":
        return {
          scopes: [{ name: "Locals", variablesReference: 200, expensive: false }]
        };
      case "variables":
        return { variables: [{ name: "counter", value: String(this.#counter), type: "number", variablesReference: 0 }] };
      case "evaluate": {
        const args = request.arguments as { expression?: string; context?: string };
        const result = this.#evaluate(args.expression || "", args.context === "repl");
        return { result, type: "number", variablesReference: 0 };
      }
      case "terminate":
      case "disconnect":
        this.#launched = false;
        queueMicrotask(() => this.#event("terminated"));
        return {};
      default:
        throw new Error(`Unsupported DAP command: ${request.command}`);
    }
  }

  #respond(request: DapRequest, body: unknown): void {
    this.#send({ seq: this.#sequence++, type: "response", request_seq: request.seq, success: true, command: request.command, body });
  }

  #event(event: string, body?: unknown): void {
    this.#send({ seq: this.#sequence++, type: "event", event, ...(body === undefined ? {} : { body }) });
  }

  #assertLaunched(): void {
    if (!this.#launched) throw new Error("Debug fixture has not been launched.");
  }

  #stackTrace(): unknown {
    const original = this.#sourceMap.originalPositionFor(this.#generatedLine);
    if (!original) throw new Error("Generated location has no source-map entry.");
    return {
      stackFrames: [{
        id: 100,
        name: "guestMain",
        line: original.line,
        column: original.column + 1,
        source: { name: "debug-fixture.ts", path: original.uri },
        presentationHint: "normal"
      }],
      totalFrames: 1
    };
  }

  #satisfyBreakpointCondition(breakpoint: RuntimeBreakpoint | undefined): void {
    if (!breakpoint?.condition) return;
    for (let attempt = 0; attempt < 100 && this.#evaluate(breakpoint.condition, false) !== "true"; attempt += 1) {
      this.#counter += 1;
    }
    if (this.#evaluate(breakpoint.condition, false) !== "true") throw new Error("Conditional breakpoint did not converge.");
  }

  #evaluate(expression: string, allowAssignment: boolean): string {
    const input = expression.trim();
    const assignment = /^counter\s*=\s*(-?\d+)$/.exec(input);
    if (assignment) {
      if (!allowAssignment) throw new Error("Assignment is only allowed in the debug console.");
      this.#counter = Number(assignment[1]);
      return String(this.#counter);
    }
    if (input === "counter") return String(this.#counter);
    const addition = /^counter\s*\+\s*(-?\d+)$/.exec(input);
    if (addition) return String(this.#counter + Number(addition[1]));
    const comparison = /^counter\s*(>=|<=|===|>|<)\s*(-?\d+)$/.exec(input);
    if (comparison) {
      const right = Number(comparison[2]);
      const result = comparison[1] === ">=" ? this.#counter >= right
        : comparison[1] === "<=" ? this.#counter <= right
          : comparison[1] === "===" ? this.#counter === right
            : comparison[1] === ">" ? this.#counter > right
              : this.#counter < right;
      return String(result);
    }
    throw new Error("Debug expression is outside the safe counter expression grammar.");
  }
}
