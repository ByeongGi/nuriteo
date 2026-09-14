import { BrowserRuntimeSupervisor } from "../../browser-host/src/supervisor.ts";

export class CargoContainer {
  #supervisor;

  constructor(options) {
    this.#supervisor = new BrowserRuntimeSupervisor(options);
  }

  get status() {
    return this.#supervisor.status;
  }

  get metrics() {
    return this.#supervisor.metrics;
  }

  boot(options = {}) {
    return this.#supervisor.boot(options);
  }

  teardown() {
    return this.#supervisor.teardown();
  }

  run(source, options = {}) {
    return this.#supervisor.run(source, options);
  }

  systemMetrics(options = {}) {
    return this.#supervisor.systemMetrics(options);
  }
}

export function createContainer(options) {
  return new CargoContainer(options);
}
