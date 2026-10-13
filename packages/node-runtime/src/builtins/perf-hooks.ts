export interface PerformanceEntry {
  duration: number;
  entryType: string;
  name: string;
  startTime: number;
}

export class PerformanceObserver {
  static supportedEntryTypes = Object.freeze(["mark", "measure"]);

  #callback: (list: { getEntries: () => PerformanceEntry[] }, observer: PerformanceObserver) => void;
  #entries: PerformanceEntry[] = [];

  constructor(callback: (list: { getEntries: () => PerformanceEntry[] }, observer: PerformanceObserver) => void) {
    this.#callback = callback;
  }

  disconnect(): void {
    this.#entries = [];
  }

  observe(): void {
    this.#callback({ getEntries: () => [...this.#entries] }, this);
  }

  takeRecords(): PerformanceEntry[] {
    const records = [...this.#entries];
    this.#entries = [];
    return records;
  }
}

const entries: PerformanceEntry[] = [];

export const performance = Object.freeze({
  clearMarks(name?: string): void {
    clearEntries("mark", name);
  },
  clearMeasures(name?: string): void {
    clearEntries("measure", name);
  },
  getEntries(): PerformanceEntry[] {
    return [...entries];
  },
  getEntriesByName(name: string): PerformanceEntry[] {
    return entries.filter((entry) => entry.name === name);
  },
  getEntriesByType(type: string): PerformanceEntry[] {
    return entries.filter((entry) => entry.entryType === type);
  },
  mark(name: string): PerformanceEntry {
    const entry = createEntry(name, "mark", now(), 0);
    entries.push(entry);
    return entry;
  },
  measure(name: string, startMark?: string, endMark?: string): PerformanceEntry {
    const startTime = startMark ? findMark(startMark)?.startTime ?? now() : 0;
    const endTime = endMark ? findMark(endMark)?.startTime ?? now() : now();
    const entry = createEntry(name, "measure", startTime, Math.max(0, endTime - startTime));
    entries.push(entry);
    return entry;
  },
  now,
  timeOrigin: Date.now() - now()
});

export const constants = Object.freeze({
  NODE_PERFORMANCE_ENTRY_TYPE_DNS: "dns",
  NODE_PERFORMANCE_ENTRY_TYPE_FUNCTION: "function",
  NODE_PERFORMANCE_ENTRY_TYPE_GC: "gc",
  NODE_PERFORMANCE_ENTRY_TYPE_HTTP: "http",
  NODE_PERFORMANCE_ENTRY_TYPE_HTTP2: "http2",
  NODE_PERFORMANCE_ENTRY_TYPE_MARK: "mark",
  NODE_PERFORMANCE_ENTRY_TYPE_MEASURE: "measure",
  NODE_PERFORMANCE_ENTRY_TYPE_NET: "net"
});

export const perfHooksBuiltin = Object.freeze({
  PerformanceObserver,
  constants,
  performance
});

function now(): number {
  return globalThis.performance?.now ? globalThis.performance.now() : Date.now();
}

function createEntry(name: string, entryType: string, startTime: number, duration: number): PerformanceEntry {
  return Object.freeze({ duration, entryType, name, startTime });
}

function findMark(name: string): PerformanceEntry | undefined {
  return [...entries].reverse().find((entry) => entry.entryType === "mark" && entry.name === name);
}

function clearEntries(type: string, name?: string): void {
  for (let index = entries.length - 1; index >= 0; index -= 1) {
    const entry = entries[index];
    if (entry?.entryType === type && (name === undefined || entry.name === name)) entries.splice(index, 1);
  }
}
