import type { CliEntry } from "../types.ts";

export class CliRegistry {
  entries: Map<string, CliEntry>;

  constructor(entries: CliEntry[] = []) {
    this.entries = new Map();
    for (const entry of entries) this.register(entry);
  }

  register(entry: CliEntry): void {
    this.entries.set(entry.name, { ...entry });
  }

  resolve(name: string): CliEntry {
    const entry = this.entries.get(name);
    if (!entry) throw new Error(`CLI not registered: ${name}`);
    return { ...entry };
  }

  versions(): Record<string, string> {
    return Object.fromEntries([...this.entries].map(([name, entry]) => [name, entry.version]));
  }
}
