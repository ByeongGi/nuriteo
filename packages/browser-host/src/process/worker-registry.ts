export class WorkerRegistry {
  #workers = new Map();

  register(pid, generation, worker) {
    const key = processKey(pid, generation);
    if (this.#workers.has(key)) {
      throw new Error(`worker already registered for ${key}`);
    }
    this.#workers.set(key, worker);
  }

  get(pid, generation) {
    return this.#workers.get(processKey(pid, generation)) || null;
  }

  terminate(pid, generation) {
    const key = processKey(pid, generation);
    const worker = this.#workers.get(key);
    if (!worker) return false;
    worker.terminate();
    this.#workers.delete(key);
    return true;
  }

  terminateAll() {
    for (const worker of this.#workers.values()) {
      worker.terminate();
    }
    this.#workers.clear();
  }

  size() {
    return this.#workers.size;
  }
}

export function processKey(pid, generation) {
  return `${pid}:${generation}`;
}
