import { createContainer, protocolVersion } from "@nuriteo/sdk";

export interface SdkExampleResult {
  protocolVersion: number;
  status: string;
  value: unknown;
  size: unknown;
}

interface RuntimeManifest {
  revision: string;
}

export async function runSdkExample(): Promise<SdkExampleResult> {
  const manifestResponse = await fetch("/runtime/manifest.json");
  if (!manifestResponse.ok) throw new Error("런타임 자산 매니페스트를 읽지 못했습니다.");
  const manifest = await manifestResponse.json() as RuntimeManifest;
  const base = new URL(`/runtime/${manifest.revision}/`, location.origin);
  const container = createContainer({
    systemWorkerUrl: new URL("system-worker.js", base),
    processWorkerUrl: new URL("process-worker.js", base),
    systemWasmUrl: new URL("system.wasm", base)
  });
  try {
    const ready = await container.boot({ timeoutMs: 20_000 });
    const run = await container.run("", { entrypoint: "fs-smoke", timeoutMs: 20_000 });
    if (!run.ok) throw new Error(run.error || "런타임 실행이 실패했습니다.");
    const exports = run.exports as { value?: unknown; size?: unknown } | undefined;
    return {
      protocolVersion: ready.protocolVersion || protocolVersion,
      status: container.status,
      value: exports?.value,
      size: exports?.size
    };
  } finally {
    await container.teardown();
  }
}
