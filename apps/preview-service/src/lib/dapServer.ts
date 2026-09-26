import type { DapEvent, DapRequest, DapResponse } from "./dapProtocol.ts";

export class FixtureDebugAdapter {
  readonly #send: (message: DapResponse | DapEvent) => void;
  #sequence = 1;
  #line = 1;
  #breakpoints: number[] = [];
  #launched = false;

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
        this.#line = 1;
        return {};
      case "setBreakpoints": {
        const args = request.arguments as { breakpoints?: Array<{ line: number }> };
        this.#breakpoints = (args.breakpoints || []).map((breakpoint) => breakpoint.line);
        return { breakpoints: this.#breakpoints.map((line) => ({ verified: true, line })) };
      }
      case "configurationDone":
        this.#assertLaunched();
        this.#line = this.#breakpoints[0] || 3;
        queueMicrotask(() => this.#event("stopped", { reason: "breakpoint", threadId: 1 }));
        return {};
      case "continue":
        this.#assertLaunched();
        this.#line += 2;
        queueMicrotask(() => this.#event("stopped", { reason: "breakpoint", threadId: 1 }));
        return { allThreadsContinued: true };
      case "next":
      case "stepIn":
      case "stepOut":
        this.#assertLaunched();
        this.#line += 1;
        queueMicrotask(() => this.#event("stopped", { reason: "step", threadId: 1 }));
        return {};
      case "threads":
        return { threads: [{ id: 1, name: "main" }] };
      case "stackTrace":
        return {
          stackFrames: [{ id: 100, name: "fixtureMain", line: this.#line, column: 1, source: { name: "debug-fixture.ts", path: "file:///workspace/debug-fixture.ts" } }],
          totalFrames: 1
        };
      case "scopes":
        return { scopes: [{ name: "Locals", variablesReference: 200, expensive: false }] };
      case "variables":
        return { variables: [{ name: "counter", value: String(this.#line), type: "number", variablesReference: 0 }] };
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
}
