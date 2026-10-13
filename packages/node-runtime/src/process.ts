import type { RuntimeProcessOptions } from "./types.ts";

export class RuntimeProcess {
  pid: number;
  exitCode: number | undefined;
  exited: boolean;
  uncaughtException: unknown;

  constructor(options: RuntimeProcessOptions = {}) {
    this.pid = options.pid ?? 1;
    this.exitCode = undefined;
    this.exited = false;
    this.uncaughtException = null;
  }

  exit(code = 0): void {
    this.exitCode = code;
    this.exited = true;
  }

  captureUncaught(error: unknown): void {
    this.uncaughtException = error;
    this.exit(1);
  }
}
