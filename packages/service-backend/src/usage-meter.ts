import type { UsageMeterSnapshot } from "./types.ts";

export interface UsageMeter {
  get(userId: string): UsageMeterSnapshot;
  recordStorageBytes(userId: string, bytes: number): UsageMeterSnapshot;
  recordInstall(userId: string, count?: number): UsageMeterSnapshot;
  recordRuntimeMinutes(userId: string, minutes: number): UsageMeterSnapshot;
  replaceAll(byUser: Record<string, UsageMeterSnapshot>): void;
  dump(): Record<string, UsageMeterSnapshot>;
}

function emptyUsage(): UsageMeterSnapshot {
  return { storageBytes: 0, installCount: 0, runtimeMinutes: 0 };
}

/**
 * Stub metering for private beta. Candidates only — not billed.
 * Tracks storage bytes, install count, and runtime minutes per user.
 */
export class InMemoryUsageMeter implements UsageMeter {
  #byUser = new Map<string, UsageMeterSnapshot>();

  get(userId: string): UsageMeterSnapshot {
    return structuredClone(this.#byUser.get(userId) ?? emptyUsage());
  }

  recordStorageBytes(userId: string, bytes: number): UsageMeterSnapshot {
    const current = this.#ensure(userId);
    current.storageBytes = Math.max(0, bytes);
    return structuredClone(current);
  }

  recordInstall(userId: string, count = 1): UsageMeterSnapshot {
    const current = this.#ensure(userId);
    current.installCount += count;
    return structuredClone(current);
  }

  recordRuntimeMinutes(userId: string, minutes: number): UsageMeterSnapshot {
    const current = this.#ensure(userId);
    current.runtimeMinutes += Math.max(0, minutes);
    return structuredClone(current);
  }

  replaceAll(byUser: Record<string, UsageMeterSnapshot>): void {
    this.#byUser.clear();
    for (const [userId, usage] of Object.entries(byUser)) {
      this.#byUser.set(userId, structuredClone(usage));
    }
  }

  dump(): Record<string, UsageMeterSnapshot> {
    const out: Record<string, UsageMeterSnapshot> = {};
    for (const [userId, usage] of this.#byUser) {
      out[userId] = structuredClone(usage);
    }
    return out;
  }

  #ensure(userId: string): UsageMeterSnapshot {
    let current = this.#byUser.get(userId);
    if (!current) {
      current = emptyUsage();
      this.#byUser.set(userId, current);
    }
    return current;
  }
}
