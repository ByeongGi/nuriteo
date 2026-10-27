export type StudioConsoleSource = "page" | "server";

export interface StudioConsoleEntry {
  readonly id: number;
  readonly level: "debug" | "error" | "info" | "log" | "warn";
  readonly message: string;
  readonly source: StudioConsoleSource;
  readonly stack: string;
}

const CONSOLE_SOURCE_CAP = 100;

export function studioConsoleSourceLabel(source: StudioConsoleSource): string {
  return source === "server" ? "개발 서버" : "페이지";
}

export function appendStudioConsole(current: readonly StudioConsoleEntry[], entry: StudioConsoleEntry): readonly StudioConsoleEntry[] {
  const next = [...current, entry];
  const page = next.filter((item) => item.source === "page").slice(-CONSOLE_SOURCE_CAP);
  const server = next.filter((item) => item.source === "server").slice(-CONSOLE_SOURCE_CAP);
  const kept = new Set([...page, ...server].map((item) => item.id));
  return next.filter((item) => kept.has(item.id));
}

export function freshServerLogLines(previous: readonly string[], next: readonly string[]): readonly string[] {
  let shared = 0;
  while (shared < previous.length && shared < next.length && previous[shared] === next[shared]) shared += 1;
  if (shared === previous.length) return next.slice(shared);
  for (let drop = 1; drop <= previous.length; drop += 1) {
    const kept = previous.slice(drop);
    if (kept.length <= next.length && kept.every((line, index) => next[index] === line)) return next.slice(kept.length);
  }
  return next;
}
