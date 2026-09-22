import {
  BrowserRuntimeSupervisor,
  type BrowserRuntimeSupervisorOptions,
  type RuntimeBootOptions,
  type RuntimeMetrics,
  type RuntimeRunOptions,
  type RuntimeRunResult,
  type RuntimeStatus,
  type RuntimeSystemMetricsOptions
} from "@cargo-container/browser-host/supervisor";
import type { MessageDetails, ReadyMessage } from "@cargo-container/protocol";
import { CargoContainerServices, type CargoContainerServicesOptions } from "./services.ts";

export type CargoContainerOptions = BrowserRuntimeSupervisorOptions & {
  services?: CargoContainerServicesOptions;
};
export type CargoContainerBootOptions = RuntimeBootOptions;
export type CargoContainerRunOptions = RuntimeRunOptions;

export class CargoContainer {
  #supervisor: BrowserRuntimeSupervisor;
  readonly services: CargoContainerServices;

  constructor(options: CargoContainerOptions) {
    const { services, ...supervisorOptions } = options;
    this.#supervisor = new BrowserRuntimeSupervisor(supervisorOptions);
    this.services = new CargoContainerServices(services);
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
