const STORAGE_KEY = "cargo-container.debug-breakpoints.v1";

export interface PersistedBreakpoint {
  line: number;
  condition?: string;
}

type DebugConfigurationState = { schemaVersion: 1; programs: Record<string, PersistedBreakpoint[]> };

export function loadDebugBreakpoints(program: string): PersistedBreakpoint[] {
  if (typeof localStorage === "undefined") return [];
  try {
    const parsed = JSON.parse(localStorage.getItem(STORAGE_KEY) || "null") as DebugConfigurationState | null;
    return parsed?.schemaVersion === 1 ? sanitize(parsed.programs[program]) : [];
  } catch {
    return [];
  }
}

export function saveDebugBreakpoints(program: string, breakpoints: PersistedBreakpoint[]): void {
  if (typeof localStorage === "undefined") return;
  let state: DebugConfigurationState = { schemaVersion: 1, programs: {} };
  try {
    const parsed = JSON.parse(localStorage.getItem(STORAGE_KEY) || "null") as DebugConfigurationState | null;
    if (parsed?.schemaVersion === 1) state = parsed;
  } catch {
    // Replace malformed state with a clean versioned record.
  }
  state.programs[program] = sanitize(breakpoints);
  localStorage.setItem(STORAGE_KEY, JSON.stringify(state));
}

function sanitize(value: unknown): PersistedBreakpoint[] {
  if (!Array.isArray(value)) return [];
  return value.flatMap((entry) => {
    if (!entry || typeof entry !== "object") return [];
    const candidate = entry as { line?: unknown; condition?: unknown };
    if (!Number.isSafeInteger(candidate.line) || Number(candidate.line) < 1) return [];
    return [{
      line: Number(candidate.line),
      ...(typeof candidate.condition === "string" && candidate.condition.trim()
        ? { condition: candidate.condition.slice(0, 500) }
        : {})
    }];
  }).slice(0, 100);
}
