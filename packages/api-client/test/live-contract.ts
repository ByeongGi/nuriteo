import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";

import {
  ApiError,
  createApiClient,
  createSession,
  deleteSession,
  getCurrentUser,
  getCurrentWorkspaces
} from "../src/index.ts";

const baseUrl = requiredEnvironment("NURITEO_CLIENT_TEST_BASE_URL");
const email = requiredEnvironment("NURITEO_CLIENT_TEST_EMAIL");
const password = (
  await readFile(requiredEnvironment("NURITEO_CLIENT_TEST_PASSWORD_FILE"), "utf8")
).replace(/\r?\n$/u, "");
const browser = createFixtureBrowser(baseUrl);
const client = createApiClient({ baseUrl, credentials: "include", fetch: browser.fetch });

const login = await createSession(client, { email, password });
assert.equal(login.status, 204);

const me = await getCurrentUser(client);
assert.equal(me.data.user.email, email);
assert.equal(me.data.user.is_instance_admin, true);
assert.equal(me.data.user.display_name, "Fixture Administrator");

const workspaces = await getCurrentWorkspaces(client);
assert.equal(workspaces.data.workspaces.length, 1);
const personal = workspaces.data.workspaces[0];
assert.equal(personal?.ownerType, "user");
assert.equal(personal?.ownerId, me.data.user.id);
assert.equal(personal?.displayLabel, me.data.user.display_name);

await deleteSession(client, { csrfToken: browser.csrfToken() });
await assert.rejects(
  getCurrentUser(client),
  (error) => error instanceof ApiError && error.status === 401
);

assert.doesNotMatch(
  JSON.stringify({ login, me, workspaces }),
  /nrt_session_|nrt_csrf_|set-cookie/u
);
console.log("api client live contract ok");

function createFixtureBrowser(origin: string): {
  readonly csrfToken: () => string;
  readonly fetch: typeof globalThis.fetch;
} {
  const cookies = new Map<string, string>();
  return {
    fetch: async (input, init) => {
      const headers = new Headers(init?.headers);
      if (cookies.size > 0) {
        headers.set(
          "cookie",
          [...cookies].map(([name, value]) => `${name}=${value}`).join("; ")
        );
      }
      if (init?.method !== undefined && !["GET", "HEAD"].includes(init.method)) {
        headers.set("origin", origin);
      }
      const response = await globalThis.fetch(input, { ...init, headers });
      const responseHeaders = response.headers as Headers & {
        getSetCookie(): string[];
      };
      for (const value of responseHeaders.getSetCookie()) {
        updateCookieJar(cookies, value);
      }
      return response;
    },
    csrfToken: () => {
      const token = cookies.get("nuriteo_dev_csrf");
      assert.ok(token, "the Core API did not issue a CSRF cookie");
      return token;
    }
  };
}

function updateCookieJar(cookies: Map<string, string>, setCookie: string): void {
  const pair = setCookie.split(";", 1)[0];
  assert.ok(pair);
  const separator = pair.indexOf("=");
  assert.ok(separator > 0);
  const name = pair.slice(0, separator);
  const value = pair.slice(separator + 1);
  if (value.length === 0) {
    cookies.delete(name);
  } else {
    cookies.set(name, value);
  }
}

function requiredEnvironment(name: string): string {
  const value = process.env[name];
  if (value === undefined || value.length === 0) {
    throw new Error(`required fixture variable ${name} is missing`);
  }
  return value;
}
