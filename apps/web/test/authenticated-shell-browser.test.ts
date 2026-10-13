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

const observedRequests: Array<{ cookie: string; path: string }> = [];
const core = http.createServer(async (request, response) => {
  const cookie = request.headers.cookie ?? "missing";
  const session = sessionFrom(cookie);
  const requestPath = request.url ?? "missing";
  observedRequests.push({ cookie, path: requestPath });
  response.setHeader("cache-control", "no-store");
  response.setHeader("content-type", "application/json");
  response.setHeader("x-request-id", `shell-${session ?? "anonymous"}`);

  if (session === undefined) {
    response.statusCode = 401;
    response.setHeader("content-type", "application/problem+json");
    response.end(JSON.stringify(problemDetails()));
    return;
  }

  if (request.method === "GET" && requestPath === "/api/v1/me") {
    response.end(JSON.stringify(currentUser(session)));
    return;
  }

  if (request.method === "GET" && requestPath === "/api/v1/me/workspaces") {
    if (session === "unavailable") {
      response.statusCode = 503;
      response.setHeader("content-type", "application/problem+json");
      response.end(JSON.stringify({ ...problemDetails(), status: 503 }));
      return;
    }
    if (session === "a") {
      await new Promise((resolve) => setTimeout(resolve, 40));
    }
    response.end(JSON.stringify({ workspaces: workspaces(session) }));
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
  observedRequests.length = 0;

  const browser = await chromium.launch({ headless: true });
  try {
    const contextA = await browser.newContext();
    const contextB = await browser.newContext();
    await Promise.all([
      contextA.addCookies([{ name: "nrt_session", value: "session-a", url: origin }]),
      contextB.addCookies([{ name: "nrt_session", value: "session-b", url: origin }])
    ]);
    const pageA = await contextA.newPage();
    const pageB = await contextB.newPage();

    await Promise.all([
      pageA.goto(`${origin}/workspaces`, { waitUntil: "networkidle" }),
      pageB.goto(`${origin}/workspaces`, { waitUntil: "networkidle" })
    ]);

    await Promise.all([
      pageA.getByRole("heading", { level: 1, name: "Workspaces" }).waitFor(),
      pageB.getByRole("heading", { level: 1, name: "Workspaces" }).waitFor()
    ]);
    assert.equal(await pageA.getByText("User Alpha", { exact: true }).count(), 1);
    assert.equal(await pageB.getByText("User Beta", { exact: true }).count(), 1);
    assert.equal(await pageA.getByText("Alpha Platform", { exact: true }).count(), 1);
    assert.equal(await pageA.getByText("Beta Personal", { exact: true }).count(), 0);
    assert.equal(await pageB.getByText("Beta Personal", { exact: true }).count(), 1);
    assert.equal(await pageB.getByText("Alpha Platform", { exact: true }).count(), 0);

    const selector = pageA.getByRole("navigation", { name: "Available Workspaces" });
    const personal = selector.getByRole("link", { name: /Alpha Personal Personal Workspace/u });
    const organization = selector.getByRole("link", {
      name: /Alpha Platform Organization Workspace/u
    });
    assert.equal(await personal.getAttribute("aria-current"), "page");
    await personal.focus();
    assert.equal(await personal.evaluate((element) => element === document.activeElement), true);
    await pageA.keyboard.press("Tab");
    assert.equal(await organization.evaluate((element) => element === document.activeElement), true);
    await Promise.all([
      pageA.waitForURL(`**/workspaces?workspace=${workspaces("a")[1]?.storageScopeId}`),
      pageA.keyboard.press("Enter")
    ]);
    assert.equal(await organization.getAttribute("aria-current"), "page");

    for (const observed of observedRequests.filter(({ path: requestPath }) =>
      requestPath === "/api/v1/me" || requestPath === "/api/v1/me/workspaces"
    )) {
      assert.match(observed.cookie, /^nrt_session=session-[ab]$/u);
    }

    const anonymousContext = await browser.newContext();
    const emptyContext = await browser.newContext();
    const unavailableContext = await browser.newContext();
    await Promise.all([
      emptyContext.addCookies([{ name: "nrt_session", value: "session-empty", url: origin }]),
      unavailableContext.addCookies([{
        name: "nrt_session",
        value: "session-unavailable",
        url: origin
      }])
    ]);
    const anonymousPage = await anonymousContext.newPage();
    const emptyPage = await emptyContext.newPage();
    const unavailablePage = await unavailableContext.newPage();
    await Promise.all([
      anonymousPage.goto(`${origin}/workspaces`, { waitUntil: "networkidle" }),
      emptyPage.goto(`${origin}/workspaces`, { waitUntil: "networkidle" }),
      unavailablePage.goto(`${origin}/workspaces`, { waitUntil: "networkidle" })
    ]);
    assert.equal(new URL(anonymousPage.url()).pathname, "/sign-in");
    await anonymousPage.getByRole("heading", { name: "Sign in to NURITEO" }).waitFor();
    await emptyPage.getByRole("heading", { name: "Ask an administrator for access" }).waitFor();
    await unavailablePage.getByRole("heading", {
      name: "Workspaces are temporarily unavailable"
    }).waitFor();

    await Promise.all([
      contextA.close(),
      contextB.close(),
      anonymousContext.close(),
      emptyContext.close(),
      unavailableContext.close()
    ]);
  } finally {
    await browser.close();
  }
} catch (error) {
  throw new Error(`authenticated shell journey failed; server output: ${serverOutput}`, {
    cause: error
  });
} finally {
  web.kill("SIGTERM");
  core.close();
}

console.log("web authenticated shell isolation journey ok");

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

function problemDetails() {
  return {
    type: "about:blank",
    title: "Authentication required",
    status: 401,
    detail: "Authentication is required.",
    instance: "/api/v1/me",
    code: "AUTHENTICATION_REQUIRED",
    request_id: "shell-anonymous",
    errors: []
  };
}

type MockSession = "a" | "b" | "empty" | "unavailable";

function sessionFrom(cookie: string): MockSession | undefined {
  for (const session of ["a", "b", "empty", "unavailable"] as const) {
    if (cookie.includes(`nrt_session=session-${session}`)) {
      return session;
    }
  }
  return undefined;
}

function currentUser(session: MockSession) {
  const suffix = sessionSuffix(session);
  return {
    user: {
      id: `0199ee6c-c777-7000-8000-00000000${suffix}001`,
      email: `user-${session}@example.test`,
      display_name: displayName(session),
      is_instance_admin: false
    },
    session: {
      id: `0199ee6c-c777-7000-8000-00000000${suffix}002`,
      last_seen_at: "2026-10-04T00:00:00.000Z",
      idle_expires_at: "2026-10-04T01:00:00.000Z",
      absolute_expires_at: "2026-10-05T00:00:00.000Z"
    }
  };
}

function sessionSuffix(session: MockSession): string {
  return { a: "a", b: "b", empty: "c", unavailable: "d" }[session];
}

function displayName(session: MockSession): string {
  return { a: "User Alpha", b: "User Beta", empty: "Test User", unavailable: "Test User" }[
    session
  ];
}

function workspaces(session: MockSession) {
  if (session === "a") {
    return [
      {
        ownerType: "user",
        ownerId: "0199ee6c-c777-7000-8000-00000000a001",
        displayLabel: "Alpha Personal",
        storageScopeId: "0199ee6c-c777-7000-8000-00000000a011"
      },
      {
        ownerType: "organization",
        ownerId: "0199ee6c-c777-7000-8000-00000000a020",
        displayLabel: "Alpha Platform",
        storageScopeId: "0199ee6c-c777-7000-8000-00000000a021"
      }
    ] as const;
  }
  if (session === "b") {
    return [{
    ownerType: "user",
    ownerId: "0199ee6c-c777-7000-8000-00000000b001",
    displayLabel: "Beta Personal",
    storageScopeId: "0199ee6c-c777-7000-8000-00000000b011"
    }] as const;
  }
  return [];
}
