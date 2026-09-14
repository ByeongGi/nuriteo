import type { RuntimeModule } from "../types.ts";

export type EsmRecordStatus = "evaluating" | "evaluated";

export interface EsmRecord {
  status: EsmRecordStatus;
  namespace: Record<string, unknown>;
  bindings: Map<string, () => unknown>;
}

export interface ModuleCacheOptions {
  realpaths?: Record<string, string>;
}

export class ModuleCache {
  cjs: Map<string, RuntimeModule>;
  esm: Map<string, EsmRecord>;
  realpaths: Map<string, string>;

  constructor(options: ModuleCacheOptions = {}) {
    this.cjs = new Map();
    this.esm = new Map();
    this.realpaths = new Map(Object.entries(options.realpaths || {}));
  }

  canonicalize(url: string): string {
    return this.realpaths.get(url) || url;
  }
}
