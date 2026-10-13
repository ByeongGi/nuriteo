import type { CliEntry } from "../types.ts";
import { isAbsolute, join } from "../builtins/path.ts";

type PortableCliEntry = CliEntry & { entryRelative?: string };

export class CliRegistry {
  entries: Map<string, CliEntry>;
  root: string;

  constructor(entries: PortableCliEntry[] = [], options: { root?: string } = {}) {
    this.entries = new Map();
    this.root = options.root || runtimeWorkingDirectory();
    for (const entry of entries) this.register(entry);
  }

  register(entry: PortableCliEntry): void {
    const portableEntry = entry.entryRelative || entry.entry;
    this.entries.set(entry.name, {
      ...entry,
      entry: isAbsolute(portableEntry) ? portableEntry : join(this.root, portableEntry)
    });
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

function runtimeWorkingDirectory(): string {
  const runtimeProcess = (globalThis as { process?: { cwd?: () => string } }).process;
  return runtimeProcess?.cwd?.() || "/";
}
