import {
  BrowserRuntimeSupervisor,
  type BrowserRuntimeSupervisorOptions,
  type RuntimeBootOptions,
  type RuntimeMetrics,
  type RuntimeRunOptions,
  type RuntimeRunResult,
  type RuntimeStatus,
  type RuntimeSystemMetricsOptions
} from "@nuriteo/browser-host/supervisor";
import type { MessageDetails, ReadyMessage } from "@nuriteo/protocol";
import { NuriteoServices, type NuriteoServicesOptions } from "./services.ts";

export type NuriteoOptions = BrowserRuntimeSupervisorOptions & {
  services?: NuriteoServicesOptions;
};
export type NuriteoBootOptions = RuntimeBootOptions;
export type NuriteoRunOptions = RuntimeRunOptions;

export class Nuriteo {
  #supervisor: BrowserRuntimeSupervisor;
  readonly services: NuriteoServices;

  constructor(options: NuriteoOptions) {
    const { services, ...supervisorOptions } = options;
    this.#supervisor = new BrowserRuntimeSupervisor(supervisorOptions);
    this.services = new NuriteoServices(services);
  }

  get status(): RuntimeStatus {
    return this.#supervisor.status;
  }

  get metrics(): RuntimeMetrics {
    return this.#supervisor.metrics;
  }

  boot(options: NuriteoBootOptions = {}): Promise<ReadyMessage> {
    return this.#supervisor.boot(options);
  }

  teardown(): Promise<void> {
    return this.#supervisor.teardown();
  }

  run(source: string, options: NuriteoRunOptions = {}): Promise<RuntimeRunResult> {
    return this.#supervisor.run(source, options);
  }

  systemMetrics(options: RuntimeSystemMetricsOptions = {}): Promise<MessageDetails> {
    return this.#supervisor.systemMetrics(options);
  }
}

export function createContainer(options: NuriteoOptions): Nuriteo {
  return new Nuriteo(options);
}
