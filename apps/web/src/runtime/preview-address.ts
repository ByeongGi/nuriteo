export interface PreviewHistory {
  readonly entries: readonly string[];
  readonly index: number;
}

const PREVIEW_ADDRESS_BASE = "https://preview.local";
const MAX_PREVIEW_ADDRESS_LENGTH = 2_048;

export function createPreviewHistory(): PreviewHistory {
  return { entries: ["/"], index: 0 };
}

export function normalizePreviewAddress(input: string): string | null {
  const trimmed = input.trim();
  if (trimmed.length === 0) return "/";
  if (trimmed.length > MAX_PREVIEW_ADDRESS_LENGTH) return null;
  const rawPath = trimmed.split(/[?#]/u)[0] ?? trimmed;
  if (/(^|\/)\.\.?(?:\/|$)/u.test(rawPath)) return null;
  let candidate = trimmed;
  if (/^[a-z][a-z0-9+.-]*:/iu.test(candidate)) {
    let url: URL;
    try {
      url = new URL(candidate);
    } catch {
      return null;
    }
    if (url.protocol !== "http:" && url.protocol !== "https:") return null;
    if (url.username || url.password) return null;
    candidate = `${url.pathname}${url.search}${url.hash}`;
  } else if (!candidate.startsWith("/") && !candidate.startsWith("?") && !candidate.startsWith("#")) {
    candidate = `/${candidate}`;
  }
  if (candidate.startsWith("//") || candidate.includes("\\") || candidate.includes("\0")) return null;
  const pathOnly = candidate.split(/[?#]/u)[0] ?? candidate;
  if (/(^|\/)\.\.?(?:\/|$)/u.test(pathOnly)) return null;
  let parsed: URL;
  try {
    parsed = new URL(candidate, PREVIEW_ADDRESS_BASE);
  } catch {
    return null;
  }
  if (parsed.origin !== PREVIEW_ADDRESS_BASE) return null;
  if (parsed.pathname.split("/").some((segment) => segment === "." || segment === "..")) return null;
  return `${parsed.pathname}${parsed.search}${parsed.hash}`;
}

export function recordPreviewHistory(history: PreviewHistory, path: string): PreviewHistory {
  const normalized = normalizePreviewAddress(path);
  if (!normalized) return history;
  if (history.entries[history.index] === normalized) return history;
  const nextIndex = history.index + 1;
  if (history.entries[nextIndex] === normalized) return { entries: history.entries, index: nextIndex };
  return {
    entries: [...history.entries.slice(0, nextIndex), normalized],
    index: nextIndex
  };
}

export function movePreviewHistory(history: PreviewHistory, direction: -1 | 1): PreviewHistory {
  const index = history.index + direction;
  if (index < 0 || index >= history.entries.length) return history;
  return { entries: history.entries, index };
}
