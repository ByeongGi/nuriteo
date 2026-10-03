import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import fs from "node:fs";
import http from "node:http";
import path from "node:path";
import { fileURLToPath } from "node:url";

import { chromium } from "@playwright/test";

const webRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const standaloneRoot = path.join(webRoot, ".next/standalone");
const standaloneWeb = path.join(standaloneRoot, "apps/web");
const serverEntry = path.join(standaloneWeb, "server.js");

assert.ok(fs.existsSync(serverEntry), "Run the production build before this browser check.");
fs.cpSync(path.join(webRoot, ".next/static"), path.join(standaloneWeb, ".next/static"), {
  force: true,
  recursive: true
});

let bootstrapRequired = true;
const core = http.createServer((request, response) => {
  response.setHeader("cache-control", "no-store");
  response.setHeader("x-request-id", "browser-server-request");

  if (request.method === "GET" && request.url === "/api/v1/setup/status") {
    response.setHeader("content-type", "application/json");
    response.end(JSON.stringify({ bootstrapRequired }));
    return;
  }

  if (request.method === "GET" && request.url === "/api/v1/me") {
    response.statusCode = 401;
    response.setHeader("content-type", "application/problem+json");
    response.end(JSON.stringify({
      type: "about:blank",
      title: "Authentication required",
      status: 401,
      code: "AUTHENTICATION_REQUIRED"
    }));
    return;
  }

  response.statusCode = 404;
  response.end();
});

await listen(core);
const coreAddress = core.address();
assert.ok(coreAddress && typeof coreAddress !== "string");

const webPort = await reservePort();
const web = spawn(process.execPath, [serverEntry], {
  cwd: standaloneWeb,
  env: {
    ...process.env,
    HOSTNAME: "127.0.0.1",
    NURITEO_INTERNAL_API_URL: `http://127.0.0.1:${coreAddress.port}`,
    PORT: String(webPort)
  },
  stdio: ["ignore", "pipe", "pipe"]
});
let serverOutput = "";
for (const stream of [web.stdout, web.stderr]) {
  stream.on("data", (chunk: Buffer) => {
    serverOutput = `${serverOutput}${chunk.toString("utf8")}`.slice(-4_000);
  });
}

try {
  const origin = `http://127.0.0.1:${webPort}`;
  await waitUntilReady(origin);

  const browser = await chromium.launch({ headless: true });
  try {
    const page = await browser.newPage();
    const browserCalls: string[] = [];
    const apiResponses: string[] = [];
    const pageErrors: string[] = [];
    let validCredentials = false;

    page.on("pageerror", (error) => pageErrors.push(String(error)));

    page.on("response", (response) => {
      if (response.url().includes("/api/v1/")) {
        apiResponses.push(`${response.status()} ${response.url()}`);
      }
    });

    await page.route("**/api/v1/auth/sessions", async (route) => {
      browserCalls.push("create-session");
      if (!validCredentials) {
        await route.fulfill({
          body: JSON.stringify({
            type: "about:blank",
            title: "Authentication failed",
            status: 401,
            code: "AUTHENTICATION_FAILED"
          }),
          contentType: "application/problem+json",
          headers: { "x-request-id": "browser-invalid-login" },
          status: 401
        });
        return;
      }
      await route.fulfill({
        headers: { "set-cookie": "nrt_session=opaque; Path=/; HttpOnly; SameSite=Lax" },
        status: 204
      });
    });
    await page.route("**/api/v1/me", async (route) => {
      browserCalls.push("get-current-user");
      await route.fulfill({
        body: JSON.stringify({
          user: {
            id: "0199ee6c-c777-7000-8000-000000009001",
            email: "admin@example.test",
            display_name: "Instance Administrator",
            is_instance_admin: true
          },
          session: {
            id: "0199ee6c-c777-7000-8000-000000009002",
            last_seen_at: "2026-10-04T00:00:00.000Z",
            idle_expires_at: "2026-10-04T01:00:00.000Z",
            absolute_expires_at: "2026-10-05T00:00:00.000Z"
          }
        }),
        contentType: "application/json",
        headers: { "x-request-id": "browser-session-check" },
        status: 200
      });
    });

    await page.goto(origin, { waitUntil: "networkidle" });
    await page.getByRole("heading", { name: "Finish setup from your server" }).waitFor();
    assert.equal(new URL(page.url()).pathname, "/setup");
    assert.equal(await page.getByText("docker compose run --rm bootstrap-admin").count(), 1);

    bootstrapRequired = false;
    await page.getByRole("link", { name: "Check setup status" }).click();
    await page.getByRole("heading", { name: "Sign in to NURITEO" }).waitFor();
    assert.equal(new URL(page.url()).pathname, "/sign-in");

    await page.getByLabel("Email").fill("unknown@example.test");
    await page.getByLabel("Password").fill("not-a-real-password");
    await page.getByRole("button", { name: "Sign in" }).click();
    const signInError = page.locator("#sign-in-error");
    await signInError.waitFor();
    assert.equal(
      await signInError.textContent(),
      "The email or password is incorrect.Request reference: browser-invalid-login",
      JSON.stringify({ apiResponses, browserCalls, pageErrors })
    );
    assert.equal(await page.getByLabel("Password").inputValue(), "");
    assert.equal(await page.getByLabel("Password").evaluate((element) => element === document.activeElement), true);

    validCredentials = true;
    await page.getByLabel("Email").fill("admin@example.test");
    await page.getByLabel("Password").fill("correct-password");
    await page.getByRole("button", { name: "Sign in" }).click();
    await page.waitForURL("**/workspaces");

    assert.deepEqual(browserCalls, [
      "create-session",
      "create-session",
      "get-current-user"
    ]);
  } finally {
    await browser.close();
  }
} catch (error) {
  throw new Error(`browser entry journey failed; server output: ${serverOutput}`, { cause: error });
} finally {
  web.kill("SIGTERM");
  core.close();
}

console.log("web setup and sign-in browser journey ok");

async function listen(server: http.Server): Promise<void> {
  await new Promise<void>((resolve, reject) => {
    server.once("error", reject);
    server.listen(0, "127.0.0.1", () => resolve());
  });
}

async function reservePort(): Promise<number> {
  const reservation = http.createServer();
  await listen(reservation);
  const address = reservation.address();
  assert.ok(address && typeof address !== "string");
  const port = address.port;
  await new Promise<void>((resolve, reject) => {
    reservation.close((error) => error ? reject(error) : resolve());
  });
  return port;
}

async function waitUntilReady(origin: string): Promise<void> {
  const deadline = Date.now() + 15_000;
  while (Date.now() < deadline) {
    try {
      const response = await fetch(`${origin}/sign-in`, { redirect: "manual" });
      if (response.status < 500) {
        return;
      }
    } catch {
      // The standalone server is still starting.
    }
    await new Promise((resolve) => setTimeout(resolve, 100));
  }
  throw new Error("standalone server did not become ready");
}
