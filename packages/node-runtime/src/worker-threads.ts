import type { RuntimeWorkerThreadOptions } from "./types.ts";

let nextThreadId = 1;

export class RuntimeWorkerThread {
  threadId: number;
  pid: number | null;
  started: boolean;
  entrypoint: NonNullable<RuntimeWorkerThreadOptions["entrypoint"]>;
  result: unknown;

  constructor(options: RuntimeWorkerThreadOptions = {}) {
    this.threadId = nextThreadId++;
    this.pid = options.pid ?? null;
    this.started = false;
    this.entrypoint = options.entrypoint || (() => {});
    this.result = undefined;
  }

  async start(): Promise<unknown> {
    this.started = true;
    this.result = await this.entrypoint({
      threadId: this.threadId,
      pid: this.pid
    });
    return this.result;
  }
}

export function startRuntimeThread(options: RuntimeWorkerThreadOptions = {}): { thread: RuntimeWorkerThread; completion: Promise<unknown> } {
  const thread = new RuntimeWorkerThread(options);
  const completion = thread.start();
  return { thread, completion };
}
