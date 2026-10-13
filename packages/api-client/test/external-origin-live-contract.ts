import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";

import { createApiClient, createSession, getCurrentUser } from "../src/index.ts";

const baseUrl = requiredEnvironment("NURITEO_CLIENT_TEST_BASE_URL");
const externalOrigin = requiredEnvironment("NURITEO_CLIENT_TEST_EXTERNAL_URL");
const email = requiredEnvironment("NURITEO_CLIENT_TEST_EMAIL");
const password = (await readFile(
  requiredEnvironment("NURITEO_CLIENT_TEST_PASSWORD_FILE"),
  "utf8"
)).trim();
const browser = createOriginBrowser(baseUrl, externalOrigin);
const client = createApiClient({ baseUrl, credentials: "include", fetch: browser.fetch });

await createSession(client, { email, password });
const identity = await getCurrentUser(client);
assert.equal(identity.data.user.email, email);
assert.ok(browser.mutationOrigins.length > 0);
assert.ok(browser.mutationOrigins.every((origin) => origin === externalOrigin));
assert.ok(browser.requestUrls.every((url) => url.startsWith(`${baseUrl}/`)));

console.log("api client external origin live contract ok");

function createOriginBrowser(origin: string, mutationOrigin: string): {
  readonly fetch: typeof globalThis.fetch;
  readonly mutationOrigins: readonly string[];
  readonly requestUrls: readonly string[];
} {
  const cookies = new Map<string, string>();
  const mutationOrigins: string[] = [];
  const requestUrls: string[] = [];
  return {
    fetch: async (input, init) => {
      const url = new URL(String(input), origin).toString();
      requestUrls.push(url);
      const headers = new Headers(init?.headers);
      if (cookies.size > 0) {
        headers.set("cookie", [...cookies].map(([name, value]) => `${name}=${value}`).join("; "));
      }
      if (init?.method !== undefined && !["GET", "HEAD"].includes(init.method)) {
        headers.set("origin", mutationOrigin);
        mutationOrigins.push(mutationOrigin);
      }
      const response = await globalThis.fetch(url, { ...init, headers });
      const responseHeaders = response.headers as Headers & { getSetCookie(): string[] };
      for (const value of responseHeaders.getSetCookie()) updateCookieJar(cookies, value);
      return response;
    },
    mutationOrigins,
    requestUrls
  };
}

function updateCookieJar(cookies: Map<string, string>, setCookie: string): void {
  const pair = setCookie.split(";", 1)[0];
  const separator = pair?.indexOf("=") ?? -1;
  if (pair === undefined || separator < 1) return;
  cookies.set(pair.slice(0, separator), pair.slice(separator + 1));
}

function requiredEnvironment(name: string): string {
  const value = process.env[name];
  if (!value) throw new Error(`${name} is required`);
  return value;
}
