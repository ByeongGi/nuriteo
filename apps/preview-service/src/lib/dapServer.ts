import type { DapEvent, DapRequest, DapResponse } from "./dapProtocol.ts";
import { formatRuntimeValue, SafeJavaScriptRuntime } from "./safeJavaScriptRuntime.ts";

type RuntimeBreakpoint = { requestedLine: number; line: number; instruction: number; condition?: string };

export class WorkspaceDebugAdapter {
  readonly #send: (message: DapResponse | DapEvent) => void;
  #sequence = 1;
  #runtime: SafeJavaScriptRuntime | null = null;
  #programUri = "";
  #instruction = 0;
  #breakpoints: RuntimeBreakpoint[] = [];
  #paused = false;
  #reason = "";
  #exception = "";
  #stopOnEntry = false;

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
        return {
          supportsConditionalBreakpoints: true,
          supportsConfigurationDoneRequest: true,
          supportsEvaluateForHovers: true,
          supportsSetVariable: true,
          supportsTerminateRequest: true
        };
      case "launch":
        return this.#launch(request.arguments);
      case "setBreakpoints":
        return this.#setBreakpoints(request.arguments);
      case "configurationDone":
        this.#requiredRuntime();
        if (this.#stopOnEntry) this.#stop("entry");
        else this.#runUntilStop();
        return {};
      case "continue":
        if (this.#resumeCurrentInstruction()) this.#runUntilStop();
        return { allThreadsContinued: true };
      case "next":
      case "stepIn":
      case "stepOut":
        if (this.#resumeCurrentInstruction()) {
          if (this.#instruction < this.#requiredRuntime().instructions.length) this.#stop("step");
          else this.#terminate();
        }
        return {};
      case "threads":
        return { threads: [{ id: 1, name: "browser-runtime" }] };
      case "stackTrace":
        return this.#stackTrace();
      case "scopes":
        this.#assertPaused();
        return { scopes: [{ name: "Module", variablesReference: 200, expensive: false }] };
      case "variables":
        this.#assertPaused();
        return { variables: this.#requiredRuntime().variables() };
      case "evaluate":
        return this.#evaluate(request.arguments);
      case "setVariable":
        return this.#setVariable(request.arguments);
      case "source":
        return { content: this.#requiredRuntime().source, mimeType: "text/typescript" };
      case "exceptionInfo":
        return { exceptionId: "BrowserRuntimeError", description: this.#exception, breakMode: "always" };
      case "terminate":
      case "disconnect":
        this.#terminate();
        return {};
      default:
        throw new Error(`Unsupported DAP command: ${request.command}`);
    }
  }

  #launch(args: unknown): Record<string, never> {
    const launch = args as { program?: string; source?: string; stopOnEntry?: boolean };
    if (!launch.program || launch.source === undefined) throw new Error("DAP launch requires workspace program and source text.");
    this.#programUri = launch.program;
    this.#runtime = new SafeJavaScriptRuntime(launch.program, launch.source, (output) => {
      this.#event("output", { category: "stdout", output: `${output}\n` });
    });
    this.#instruction = 0;
    this.#breakpoints = [];
    this.#paused = false;
    this.#reason = "";
    this.#exception = "";
    this.#stopOnEntry = launch.stopOnEntry === true;
    return {};
  }

  #setBreakpoints(args: unknown): { breakpoints: Array<{ verified: boolean; line: number; message?: string; source: { path: string } }> } {
    const runtime = this.#requiredRuntime();
    const params = args as { source?: { path?: string }; breakpoints?: Array<{ line: number; condition?: string }> };
    const sourceUri = params.source?.path || this.#programUri;
    if (sourceUri !== this.#programUri) {
      return { breakpoints: (params.breakpoints ?? []).map((breakpoint) => ({ verified: false, line: breakpoint.line, message: "Source is not loaded.", source: { path: sourceUri } })) };
    }
    this.#breakpoints = (params.breakpoints ?? []).flatMap((breakpoint) => {
      const instruction = runtime.instructions.findIndex((candidate) => candidate.line >= breakpoint.line);
      if (instruction < 0) return [];
      const resolved = runtime.instructions[instruction];
      return resolved ? [{ requestedLine: breakpoint.line, line: resolved.line, instruction, ...(breakpoint.condition ? { condition: breakpoint.condition } : {}) }] : [];
    });
    return {
      breakpoints: (params.breakpoints ?? []).map((breakpoint) => {
        const resolved = this.#breakpoints.find((candidate) => candidate.requestedLine === breakpoint.line);
        return resolved
          ? { verified: true, line: resolved.line, source: { path: sourceUri } }
          : { verified: false, line: breakpoint.line, message: "No executable statement at or after this line.", source: { path: sourceUri } };
      })
    };
  }

  #runUntilStop(): void {
    const runtime = this.#requiredRuntime();
    this.#paused = false;
    while (this.#instruction < runtime.instructions.length) {
      const breakpoint = this.#breakpoints.find((candidate) => candidate.instruction === this.#instruction);
      if (breakpoint && this.#breakpointMatches(breakpoint)) {
        this.#stop("breakpoint");
        return;
      }
      if (!this.#executeCurrent()) return;
    }
    this.#terminate();
  }

  #resumeCurrentInstruction(): boolean {
    this.#assertPaused();
    this.#paused = false;
    return this.#executeCurrent();
  }

  #executeCurrent(): boolean {
    const runtime = this.#requiredRuntime();
    if (this.#instruction >= runtime.instructions.length) return true;
    try {
      runtime.execute(this.#instruction);
      this.#instruction += 1;
      return true;
    } catch (error) {
      this.#exception = error instanceof Error ? error.message : String(error);
      this.#stop("exception", this.#exception);
      return false;
    }
  }

  #breakpointMatches(breakpoint: RuntimeBreakpoint): boolean {
    if (!breakpoint.condition) return true;
    try {
      return Boolean(this.#requiredRuntime().evaluate(breakpoint.condition, false));
    } catch (error) {
      this.#exception = `Breakpoint condition failed: ${error instanceof Error ? error.message : String(error)}`;
      return true;
    }
  }

  #evaluate(args: unknown): { result: string; type: string; variablesReference: number } {
    this.#assertPaused();
    const params = args as { expression?: string; context?: string };
    const value = this.#requiredRuntime().evaluate(params.expression ?? "", params.context === "repl");
    return { result: formatRuntimeValue(value), type: value === null ? "null" : typeof value, variablesReference: 0 };
  }

  #setVariable(args: unknown): { value: string; type: string; variablesReference: number } {
    this.#assertPaused();
    const params = args as { name?: string; value?: string };
    if (!params.name || params.value === undefined) throw new Error("setVariable requires name and value.");
    const value = this.#requiredRuntime().setVariable(params.name, params.value);
    return { value: formatRuntimeValue(value), type: value === null ? "null" : typeof value, variablesReference: 0 };
  }

  #stackTrace(): unknown {
    this.#assertPaused();
    const runtime = this.#requiredRuntime();
    const instruction = runtime.instructions[Math.min(this.#instruction, runtime.instructions.length - 1)];
    if (!instruction) throw new Error("Debug program has no current source location.");
    return {
      stackFrames: [{
        id: 100,
        name: "module",
        line: instruction.line,
        column: 1,
        source: { name: this.#programUri.split("/").at(-1), path: this.#programUri },
        presentationHint: "normal"
      }],
      totalFrames: 1
    };
  }

  #stop(reason: string, text?: string): void {
    this.#paused = true;
    this.#reason = reason;
    queueMicrotask(() => this.#event("stopped", { reason, threadId: 1, allThreadsStopped: true, ...(text ? { text } : {}) }));
  }

  #terminate(): void {
    this.#paused = false;
    queueMicrotask(() => this.#event("terminated"));
  }

  #assertPaused(): void {
    if (!this.#paused) throw new Error("Debug runtime is not paused.");
  }

  #requiredRuntime(): SafeJavaScriptRuntime {
    if (!this.#runtime) throw new Error("Workspace debug program has not been launched.");
    return this.#runtime;
  }

  #respond(request: DapRequest, body: unknown): void {
    this.#send({ seq: this.#sequence++, type: "response", request_seq: request.seq, success: true, command: request.command, body });
  }

  #event(event: string, body?: unknown): void {
    this.#send({ seq: this.#sequence++, type: "event", event, ...(body === undefined ? {} : { body }) });
  }
}
