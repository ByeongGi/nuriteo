import type { JsonValue, OpfsLike } from "./types.ts";

export class MemoryOpfs implements OpfsLike {
  files: Map<string, JsonValue>;
  flushed: Set<string>;

  constructor() {
    this.files = new Map();
    this.flushed = new Set();
  }

  writeFile(path: string, value: JsonValue): void {
    this.files.set(path, structuredClone(value));
    this.flushed.delete(path);
  }

  readFile(path: string): JsonValue | null {
    if (!this.files.has(path)) return null;
    const value = this.files.get(path);
    return value === undefined ? null : structuredClone(value);
  }

  deleteFile(path: string): void {
    this.files.delete(path);
    this.flushed.delete(path);
  }

  flush(path: string): boolean {
    if (!this.files.has(path)) return false;
    this.flushed.add(path);
    return true;
  }

  isFlushed(path: string): boolean {
    return this.flushed.has(path);
  }

  listFiles(prefix = ""): string[] {
    return [...this.files.keys()].filter((path) => path.startsWith(prefix)).sort();
  }
}

export function createMemoryOpfs(): MemoryOpfs {
  return new MemoryOpfs();
}
