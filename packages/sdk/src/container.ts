import {
  BrowserRuntimeSupervisor,
  type BrowserRuntimeSupervisorOptions,
  type RuntimeBootOptions,
  type RuntimeMetrics,
  type RuntimeRunOptions,
  type RuntimeRunResult,
  type RuntimeStatus,
  type RuntimeSystemMetricsOptions
} from "../../browser-host/src/supervisor.ts";
import type { MessageDetails, ReadyMessage } from "../../protocol/src/index.ts";

export type CargoContainerOptions = BrowserRuntimeSupervisorOptions;
export type CargoContainerBootOptions = RuntimeBootOptions;
export type CargoContainerRunOptions = RuntimeRunOptions;

export class CargoContainer {
  #supervisor: BrowserRuntimeSupervisor;

  constructor(options: CargoContainerOptions) {
    this.#supervisor = new BrowserRuntimeSupervisor(options);
  }

  get status(): RuntimeStatus {
    return this.#supervisor.status;
  }

  get metrics(): RuntimeMetrics {
    return this.#supervisor.metrics;
  }

  boot(options: CargoContainerBootOptions = {}): Promise<ReadyMessage> {
    return this.#supervisor.boot(options);
  }

  teardown(): Promise<void> {
    return this.#supervisor.teardown();
  }

  run(source: string, options: CargoContainerRunOptions = {}): Promise<RuntimeRunResult> {
    return this.#supervisor.run(source, options);
  }

  systemMetrics(options: RuntimeSystemMetricsOptions = {}): Promise<MessageDetails> {
    return this.#supervisor.systemMetrics(options);
  }
}

export function createContainer(options: CargoContainerOptions): CargoContainer {
  return new CargoContainer(options);
}
