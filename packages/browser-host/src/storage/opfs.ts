export class MemoryOpfs {
  constructor() {
    this.files = new Map();
    this.flushed = new Set();
  }

  writeFile(path, value) {
    this.files.set(path, structuredClone(value));
    this.flushed.delete(path);
  }

  readFile(path) {
    if (!this.files.has(path)) return null;
    return structuredClone(this.files.get(path));
  }

  deleteFile(path) {
    this.files.delete(path);
    this.flushed.delete(path);
  }

  flush(path) {
    if (!this.files.has(path)) return false;
    this.flushed.add(path);
    return true;
  }

  isFlushed(path) {
    return this.flushed.has(path);
  }

  listFiles(prefix = "") {
    return [...this.files.keys()].filter((path) => path.startsWith(prefix)).sort();
  }
}

export function createMemoryOpfs() {
  return new MemoryOpfs();
}
