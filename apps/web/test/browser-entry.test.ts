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
const bffCalls: string[] = [];
const forwardedOrigins: string[] = [];
const core = http.createServer(async (request, response) => {
  response.setHeader("cache-control", "no-store");
  response.setHeader("x-request-id", "browser-server-request");

  if (request.method === "GET" && request.url === "/api/v1/setup/status") {
    response.setHeader("content-type", "application/json");
    response.end(JSON.stringify({ bootstrapRequired }));
    return;
  }

  if (request.method === "GET" && request.url === "/api/v1/me") {
    if (request.headers.cookie?.includes("nrt_session=opaque") === true) {
      bffCalls.push("get-current-user");
      response.setHeader("content-type", "application/json");
      response.end(JSON.stringify(currentUser()));
      return;
    }
    response.statusCode = 401;
    response.setHeader("content-type", "application/problem+json");
    response.end(JSON.stringify(problemDetails(401, "AUTHENTICATION_REQUIRED", "browser-server-request")));
    return;
  }

  if (request.method === "GET" && request.url === "/api/v1/me/workspaces") {
    if (request.headers.cookie?.includes("nrt_session=opaque") === true) {
      response.setHeader("content-type", "application/json");
      response.end(JSON.stringify({
        workspaces: [{
          ownerType: "user",
          ownerId: "0199ee6c-c777-7000-8000-000000009001",
          displayLabel: "Personal Workspace",
          storageScopeId: "0199ee6c-c777-7000-8000-000000009003"
        }]
      }));
      return;
    }
    response.statusCode = 401;
    response.setHeader("content-type", "application/problem+json");
    response.end(JSON.stringify(problemDetails(401, "AUTHENTICATION_REQUIRED", "browser-server-request")));
    return;
  }

  if (request.method === "POST" && request.url === "/api/v1/auth/sessions") {
    bffCalls.push("create-session");
    forwardedOrigins.push(request.headers.origin ?? "missing");
    const body = JSON.parse(await readRequestBody(request)) as { email?: unknown };
    if (body.email !== "admin@example.test") {
      response.statusCode = 401;
      response.setHeader("content-type", "application/problem+json");
      response.setHeader("x-request-id", "browser-invalid-login");
      response.end(JSON.stringify(problemDetails(401, "AUTHENTICATION_FAILED", "browser-invalid-login")));
      return;
    }
    response.statusCode = 204;
    response.setHeader("set-cookie", [
      "nrt_session=opaque; Path=/; HttpOnly; SameSite=Lax",
      "nrt_csrf=opaque-csrf; Path=/; SameSite=Lax"
    ]);
    response.end();
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
    const apiResponses: string[] = [];
    const pageErrors: string[] = [];
    const browserRequestOrigins: Array<string | undefined> = [];

    page.on("pageerror", (error) => pageErrors.push(String(error)));
    page.on("request", (request) => {
      if (request.url().includes("/api/v1/auth/sessions")) {
        browserRequestOrigins.push(request.headers().origin);
      }
    });

    page.on("response", (response) => {
      if (response.url().includes("/api/v1/")) {
        apiResponses.push(`${response.status()} ${response.url()}`);
      }
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
      JSON.stringify({ apiResponses, bffCalls, browserRequestOrigins, pageErrors })
    );
    assert.equal(await page.getByLabel("Password").inputValue(), "");
    assert.equal(await page.getByLabel("Password").evaluate((element) => element === document.activeElement), true);

    await page.getByLabel("Email").fill("admin@example.test");
    await page.getByLabel("Password").fill("correct-password");
    await page.getByRole("button", { name: "Sign in" }).click();
    await page.waitForURL("**/workspaces");

    const cookieNames = (await page.context().cookies(origin))
      .map((cookie) => cookie.name)
      .sort();
    assert.deepEqual(cookieNames, ["nrt_csrf", "nrt_session"]);

    assert.equal(bffCalls.filter((call) => call === "create-session").length, 2);
    assert.ok(bffCalls.filter((call) => call === "get-current-user").length >= 2);
    assert.deepEqual(forwardedOrigins, [origin, origin]);
    assert.ok(apiResponses.some((response) => response.startsWith("401 ")));
    assert.ok(apiResponses.some((response) => response.startsWith("204 ")));
    assert.deepEqual(pageErrors, []);
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

function problemDetails(status: number, code: string, requestId: string) {
  return {
    type: "about:blank",
    title: "Authentication failed",
    status,
    detail: "The request could not be authenticated.",
    instance: "/api/v1/auth/sessions",
    code,
    request_id: requestId,
    errors: []
  };
}

function currentUser() {
  return {
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
  };
}

async function readRequestBody(request: http.IncomingMessage): Promise<string> {
  const chunks: Buffer[] = [];
  for await (const chunk of request) {
    chunks.push(Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk));
  }
  return Buffer.concat(chunks).toString("utf8");
}
