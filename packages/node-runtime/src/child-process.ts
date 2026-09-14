import { RuntimeProcess } from "./process.ts";
import { createScheduler } from "./scheduler.ts";
import { createStdio } from "./io/index.ts";

export class RuntimeChildProcess {
  constructor(options = {}) {
    this.process = new RuntimeProcess({
      pid: options.pid,
      parent: options.parent,
      cwd: options.cwd,
      env: options.env
    });
    this.scheduler = createScheduler({ process: this.process });
    this.stdio = options.stdio || createStdio(options.stdioCapacity || 65536);
    this.entrypoint = options.entrypoint || (() => {});
    this.started = false;
  }

  start() {
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

  async wait() {
    if (!this.started) this.start();
    return this.scheduler.runUntilIdle();
  }

  waitSync() {
    if (!this.started) this.start();
    return this.scheduler.runUntilIdle();
  }
}

export function spawnRuntimeChild(options) {
  return new RuntimeChildProcess(options).start();
}
