export type SensitiveHeaderName =
  | "authorization"
  | "cookie"
  | "npm-auth-token"
  | "proxy-authorization"
  | (string & {});

export interface RegistryCredential {
  registryOrigin: string;
  scope?: string;
  token: string;
}

export interface RedactedRegistryCredential {
  registryOrigin: string;
  scope?: string;
  token: "[REDACTED]";
}

export class RegistryCredentialStore {
  #credentials: RegistryCredential[] = [];

  setToken(input: RegistryCredential): void {
    const credential = {
      registryOrigin: normalizeOrigin(input.registryOrigin),
      ...(input.scope ? { scope: input.scope } : {}),
      token: input.token
    };
    this.#credentials = this.#credentials.filter((entry) => entry.registryOrigin !== credential.registryOrigin || entry.scope !== credential.scope);
    this.#credentials.push(credential);
  }

  authorizationFor(input: string | URL, scope?: string): string | null {
    const origin = normalizeOrigin(input);
    const credential = this.#credentials.find((entry) => entry.registryOrigin === origin && (entry.scope === undefined || entry.scope === scope));
    return credential ? `Bearer ${credential.token}` : null;
  }

  clear(): void {
    this.#credentials = [];
  }

  snapshot(): RedactedRegistryCredential[] {
    return this.#credentials.map((entry) => ({
      registryOrigin: entry.registryOrigin,
      ...(entry.scope ? { scope: entry.scope } : {}),
      token: "[REDACTED]"
    }));
  }
}

export function createRegistryCredentialStore(): RegistryCredentialStore {
  return new RegistryCredentialStore();
}

export function redactSecrets(input: string, secrets: readonly string[]): string {
  return secrets.reduce((text, secret) => {
    if (!secret) return text;
    return text.split(secret).join("[REDACTED]");
  }, input);
}

export function stripSensitiveHeadersForRedirect(headers: HeadersInit = {}, from: string | URL, to: string | URL): Headers {
  const output = new Headers(headers);
  if (normalizeOrigin(from) === normalizeOrigin(to)) return output;
  for (const header of sensitiveHeaders()) output.delete(header);
  return output;
}

export function sensitiveHeaders(): SensitiveHeaderName[] {
  return ["authorization", "proxy-authorization", "cookie", "npm-auth-token"];
}

function normalizeOrigin(input: string | URL): string {
  return new URL(input).origin;
}
