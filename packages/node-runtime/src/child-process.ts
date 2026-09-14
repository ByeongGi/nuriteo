import { RuntimeProcess } from "./process.ts";
import { createScheduler } from "./scheduler.ts";
import { createStdio } from "./io/index.ts";
import type { RuntimeChildEntrypoint, RuntimeChildProcessOptions, RuntimeExitStatus } from "./types.ts";
import type { RuntimeStdio } from "./io/stdio.ts";

export class RuntimeChildProcess {
  process: RuntimeProcess;
  scheduler: ReturnType<typeof createScheduler>;
  stdio: RuntimeStdio;
  entrypoint: RuntimeChildEntrypoint;
  started: boolean;

  constructor(options: RuntimeChildProcessOptions = {}) {
    this.process = new RuntimeProcess(options.pid === undefined ? {} : { pid: options.pid });
    this.scheduler = createScheduler({ process: this.process });
    this.stdio = options.stdio || createStdio(options.stdioCapacity || 65536);
    this.entrypoint = options.entrypoint || (() => {});
    this.started = false;
  }

  start(): RuntimeChildProcess {
    this.started = true;
    this.scheduler.nextTick(async () => {
      await this.entrypoint({
        process: this.process,
        scheduler: this.scheduler,
        stdio: this.stdio
      });
    });
    return this;
  }

  async wait(): Promise<RuntimeExitStatus> {
    if (!this.started) this.start();
    return this.scheduler.runUntilIdle();
  }

  waitSync(): Promise<RuntimeExitStatus> {
    if (!this.started) this.start();
    return this.scheduler.runUntilIdle();
  }
}

export function spawnRuntimeChild(options: RuntimeChildProcessOptions = {}): RuntimeChildProcess {
  return new RuntimeChildProcess(options).start();
}
