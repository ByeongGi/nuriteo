import { createLocalDraftWriterLease } from "../../src/runtime/local-draft-writer.ts";
import type { LocalDraftWriterLease } from "../../src/runtime/local-draft-writer.ts";

declare global {
  interface Window {
    __localDraftWriterFixture: {
      acquire(namespace: string): Promise<boolean>;
      holdRaw(namespace: string): Promise<void>;
      releaseRaw(): void;
      takeOver(): Promise<void>;
      release(): Promise<void>;
      snapshot(): { lost: number; status: LocalDraftWriterLease["status"] | "none" };
    };
  }
}

let lease: LocalDraftWriterLease | null = null;
let lost = 0;
let releaseRawLock: (() => void) | null = null;

window.__localDraftWriterFixture = {
  async acquire(namespace) {
    lease = createLocalDraftWriterLease({ namespace, onLost: () => { lost += 1; } });
    return lease.acquire();
  },
  async holdRaw(namespace) {
    let markAcquired!: () => void;
    const acquired = new Promise<void>((resolve) => { markAcquired = resolve; });
    const hold = new Promise<void>((resolve) => { releaseRawLock = resolve; });
    void navigator.locks.request(`nuriteo:local-draft:${namespace}`, async () => {
      markAcquired();
      await hold;
    });
    await acquired;
  },
  releaseRaw() {
    releaseRawLock?.();
    releaseRawLock = null;
  },
  async takeOver() {
    if (!lease) throw new Error("lease unavailable");
    await lease.takeOver();
  },
  async release() {
    await lease?.release();
    lease = null;
  },
  snapshot() {
    return { lost, status: lease?.status ?? "none" };
  }
};
