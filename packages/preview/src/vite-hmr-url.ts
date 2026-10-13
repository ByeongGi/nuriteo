export interface ViteHmrUrlInput {
  clientSource?: string;
  previewUrl: string | URL;
}

export interface ViteHmrUrlResolution {
  protocol: "ws:" | "wss:";
  token: string | null;
  url: string;
}

export function resolveViteHmrUrl(input: ViteHmrUrlInput): ViteHmrUrlResolution {
  const preview = new URL(input.previewUrl);
  const source = input.clientSource || "";
  const protocol = resolveProtocol(source, preview);
  const hostname = firstStringTemplateFallback(source, "importMetaUrl.hostname") || preview.hostname;
  const port = resolvePort(source) || preview.port;
  const base = normalizeBase(resolveHmrBase(source) || "/");
  const token = resolveStringConst(source, "wsToken");
  const url = new URL(base, `${protocol}//${hostname}${port ? `:${port}` : ""}`);
  if (token) url.searchParams.set("token", token);
  return {
    protocol: protocol === "wss:" ? "wss:" : "ws:",
    token,
    url: url.href
  };
}

function resolveProtocol(source: string, preview: URL): "ws:" | "wss:" {
  const value = resolveStringConst(source, "socketProtocol");
  if (value === "wss" || value === "wss:") return "wss:";
  if (value === "ws" || value === "ws:") return "ws:";
  return preview.protocol === "https:" ? "wss:" : "ws:";
}

function resolvePort(source: string): string {
  const numeric = source.match(/\bconst\s+hmrPort\s*=\s*(\d+)\s*;/)?.[1];
  if (numeric) return numeric;
  return resolveStringConst(source, "hmrPort") || "";
}

function resolveHmrBase(source: string): string | null {
  const match = source.match(/\$\{\s*hmrPort\s*\|\|\s*importMetaUrl\.port\s*\}\$\{\s*(['"])(.*?)\1\s*\}/);
  if (!match?.[2] || match[2].startsWith("__")) return null;
  return match[2];
}

function resolveStringConst(source: string, name: string): string | null {
  const match = source.match(new RegExp(`\\bconst\\s+${name}\\s*=\\s*(['"])(.*?)\\1\\s*;`));
  if (!match?.[2] || match[2].startsWith("__")) return null;
  return match[2];
}

function firstStringTemplateFallback(source: string, fallbackExpression: string): string | null {
  const escaped = fallbackExpression.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
  const match = source.match(new RegExp(`\\$\\{\\s*(['"])(.*?)\\1\\s*\\|\\|\\s*${escaped}\\s*\\}`));
  if (!match?.[2] || match[2].startsWith("__")) return null;
  return match[2];
}

function normalizeBase(value: string): string {
  if (!value || value === "__HMR_BASE__") return "/";
  return value.startsWith("/") ? value : `/${value}`;
}
