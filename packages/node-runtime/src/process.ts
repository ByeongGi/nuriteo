export class RuntimeProcess {
  constructor(options = {}) {
    this.pid = options.pid ?? 1;
    this.exitCode = undefined;
    this.exited = false;
    this.uncaughtException = null;
  }

  exit(code = 0) {
    this.exitCode = code;
    this.exited = true;
  }

  captureUncaught(error) {
    this.uncaughtException = error;
    this.exit(1);
  }
}
