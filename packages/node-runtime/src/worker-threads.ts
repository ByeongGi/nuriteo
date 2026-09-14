let nextThreadId = 1;

export class RuntimeWorkerThread {
  constructor(options = {}) {
    this.threadId = nextThreadId++;
    this.pid = options.pid ?? null;
    this.started = false;
    this.entrypoint = options.entrypoint || (() => {});
    this.result = undefined;
  }

  async start() {
    this.started = true;
    this.result = await this.entrypoint({
      threadId: this.threadId,
      pid: this.pid
    });
    return this.result;
  }
}

export function startRuntimeThread(options) {
  const thread = new RuntimeWorkerThread(options);
  const completion = thread.start();
  return { thread, completion };
}
