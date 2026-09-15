export interface WasiOptions {
  args?: string[];
  env?: Record<string, string | undefined>;
  preopens?: Record<string, string>;
  returnOnExit?: boolean;
  version?: "preview1" | string;
}

export class WASI {
  readonly args: string[];
  readonly env: Record<string, string | undefined>;
  readonly preopens: Record<string, string>;
  readonly returnOnExit: boolean;
  readonly version: string;
  readonly wasiImport: Record<string, unknown>;

  constructor(options: WasiOptions = {}) {
    this.args = [...(options.args || [])];
    this.env = { ...(options.env || {}) };
    this.preopens = { ...(options.preopens || {}) };
    this.returnOnExit = options.returnOnExit ?? false;
    this.version = options.version || "preview1";
    this.wasiImport = Object.freeze({});
  }

  getImportObject(): { wasi_snapshot_preview1: Record<string, unknown> } {
    return { wasi_snapshot_preview1: this.wasiImport };
  }

  initialize(_instance: WebAssembly.Instance): void {}

  start(_instance: WebAssembly.Instance): number | undefined {
    return this.returnOnExit ? 0 : undefined;
  }
}

export const wasiBuiltin = Object.freeze({
  WASI
});
