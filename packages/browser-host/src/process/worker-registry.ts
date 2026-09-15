import type { HostWorkerLike } from "./types.ts";

export class WorkerRegistry {
  #workers: Map<string, HostWorkerLike> = new Map();

  register(pid: number, generation: number, worker: HostWorkerLike): void {
    const key = processKey(pid, generation);
    if (this.#workers.has(key)) {
      throw new Error(`worker already registered for ${key}`);
    }
    this.#workers.set(key, worker);
  }

  get(pid: number, generation: number): HostWorkerLike | null {
    return this.#workers.get(processKey(pid, generation)) || null;
  }

  terminate(pid: number, generation: number): boolean {
    const key = processKey(pid, generation);
    const worker = this.#workers.get(key);
    if (!worker) return false;
    worker.terminate();
    this.#workers.delete(key);
    return true;
  }

  terminateAll(): void {
    for (const worker of this.#workers.values()) {
      worker.terminate();
    }
    this.#workers.clear();
  }

  size(): number {
    return this.#workers.size;
  }
}

export function processKey(pid: number, generation: number): string {
  return `${pid}:${generation}`;
}
