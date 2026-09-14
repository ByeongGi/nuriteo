export class CliRegistry {
  constructor(entries = []) {
    this.entries = new Map();
    for (const entry of entries) this.register(entry);
  }

  register(entry) {
    this.entries.set(entry.name, { ...entry });
  }

  resolve(name) {
    const entry = this.entries.get(name);
    if (!entry) throw new Error(`CLI not registered: ${name}`);
    return { ...entry };
  }

  versions() {
    return Object.fromEntries([...this.entries].map(([name, entry]) => [name, entry.version]));
  }
}
