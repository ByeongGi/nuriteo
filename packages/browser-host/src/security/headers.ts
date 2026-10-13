export type RuntimeHeaderCheckStatus = "pass" | "fail";

export interface RuntimeHeaderInput {
  url: string;
  headers: HeadersInit;
  kind?: "document" | "worker" | "wasm" | "preview";
}

export interface RuntimeHeaderIssue {
  header: string;
  expected: string;
  actual: string | null;
  message: string;
}

export interface RuntimeHeaderValidation {
  status: RuntimeHeaderCheckStatus;
  url: string;
  kind: NonNullable<RuntimeHeaderInput["kind"]>;
  issues: RuntimeHeaderIssue[];
}

export const REQUIRED_RUNTIME_HEADERS = {
  coop: "same-origin",
  coep: "require-corp",
  csp: "default-src 'self'; script-src 'self' 'wasm-unsafe-eval'; worker-src 'self'; connect-src 'self'; img-src 'self' data:; style-src 'self'",
  wasmMime: "application/wasm"
} as const;

export function createRuntimeHeaderSet(): Record<string, string> {
  return {
    "Cross-Origin-Opener-Policy": REQUIRED_RUNTIME_HEADERS.coop,
    "Cross-Origin-Embedder-Policy": REQUIRED_RUNTIME_HEADERS.coep,
    "Content-Security-Policy": REQUIRED_RUNTIME_HEADERS.csp
  };
}

export function validateRuntimeHeaders(input: RuntimeHeaderInput): RuntimeHeaderValidation {
  const kind = input.kind || "document";
  const headers = new Headers(input.headers);
  const issues = [
    requireHeader(headers, "cross-origin-opener-policy", REQUIRED_RUNTIME_HEADERS.coop),
    requireHeader(headers, "cross-origin-embedder-policy", REQUIRED_RUNTIME_HEADERS.coep),
    requireCsp(headers),
    kind === "wasm" ? requireHeader(headers, "content-type", REQUIRED_RUNTIME_HEADERS.wasmMime) : null
  ].filter((issue): issue is RuntimeHeaderIssue => issue !== null);

  return {
    status: issues.length === 0 ? "pass" : "fail",
    url: input.url,
    kind,
    issues
  };
}

function requireHeader(headers: Headers, name: string, expected: string): RuntimeHeaderIssue | null {
  const actual = headers.get(name);
  if (actual === expected || actual?.startsWith(`${expected};`)) return null;
  return {
    header: name,
    expected,
    actual,
    message: `${name} header drift: expected ${expected}, got ${actual || "<missing>"}`
  };
}

function requireCsp(headers: Headers): RuntimeHeaderIssue | null {
  const actual = headers.get("content-security-policy");
  const expectedDirectives = REQUIRED_RUNTIME_HEADERS.csp.split("; ");
  const missing = expectedDirectives.filter((directive) => !actual?.includes(directive));
  if (missing.length === 0) return null;
  return {
    header: "content-security-policy",
    expected: REQUIRED_RUNTIME_HEADERS.csp,
    actual,
    message: `content-security-policy header drift: missing ${missing.join(", ")}`
  };
}
