import assert from "node:assert/strict";
import { randomBytes } from "node:crypto";
import fs from "node:fs";
import http from "node:http";
import os from "node:os";
import path from "node:path";
import { spawn } from "node:child_process";
import { fileURLToPath } from "node:url";

import { issueSignedPreviewBinding } from "../src/lib/preview/signed-binding.ts";

const webRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const standaloneDirectory = path.join(webRoot, ".next/standalone/apps/web");
assert.ok(fs.existsSync(path.join(standaloneDirectory, "server.js")), "run the production Web build before this fixture");
const temporaryDirectory = fs.mkdtempSync(path.join(os.tmpdir(), "nuriteo-preview-standalone-"));
const signingKey = randomBytes(32).toString("base64url");
const signingKeyFile = path.join(temporaryDirectory, "preview-signing-key");
fs.writeFileSync(signingKeyFile, signingKey, { mode: 0o600 });

try {
  const instance = await startStandalone(signingKeyFile);
  try {
    const binding = await issueSignedPreviewBinding(signingKey, 4173);
    const host = `r-${binding.runtimeId}-p4173.preview.localhost:${instance.port}`;
    const response = await request(instance.port, host, "/runtime-preview/bootstrap");
    assert.equal(response.status, 200);
    assert.match(response.body, /runtime-preview\/bootstrap\.js/u);
    assert.equal(response.headers["cross-origin-opener-policy"], "same-origin");

    const unsigned = await request(instance.port, `r-${"a".repeat(45)}-p4173.preview.localhost:${instance.port}`, "/runtime-preview/bootstrap");
    assert.equal(unsigned.status, 404);
    assert.equal(unsigned.headers["cache-control"], "no-store");

    const expiredBinding = await issueSignedPreviewBinding(signingKey, 4173, Date.now() - 30_000, 1_000);
    const expired = await request(instance.port, `r-${expiredBinding.runtimeId}-p4173.preview.localhost:${instance.port}`, "/runtime-preview/bootstrap");
    assert.equal(expired.status, 410);
    assert.equal(expired.headers["cache-control"], "no-store");
  } finally {
    await stop(instance.child);
  }
} finally {
  fs.rmSync(temporaryDirectory, { recursive: true });
}

async function startStandalone(signingKeyPath: string): Promise<{ child: ReturnType<typeof spawn>; port: number }> {
  for (let attempt = 0; attempt < 5; attempt += 1) {
    const port = await reservePort();
    const child = spawn(process.execPath, ["server.js"], {
      cwd: standaloneDirectory,
      env: {
        ...process.env,
        HOSTNAME: "127.0.0.1",
        NURITEO_EXTERNAL_URL: `http://app.localhost:${port}`,
        NURITEO_INTERNAL_API_URL: "http://127.0.0.1:1",
        NURITEO_PREVIEW_BASE_DOMAIN: "preview.localhost",
        NURITEO_PREVIEW_SIGNING_KEY_FILE: signingKeyPath,
        PORT: String(port)
      },
      stdio: "ignore"
    });
    if (await ready(port, child)) return { child, port };
    await stop(child);
  }
  throw new Error("standalone Web did not bind after bounded retries");
}

async function ready(port: number, child: ReturnType<typeof spawn>): Promise<boolean> {
  const deadline = Date.now() + 15_000;
  while (Date.now() < deadline) {
    if (child.exitCode !== null) return false;
    try {
      const response = await request(port, `app.localhost:${port}`, "/sign-in");
      if (response.status < 500) return true;
    } catch { /* starting */ }
    await new Promise((resolve) => setTimeout(resolve, 100));
  }
  return false;
}

async function request(port: number, host: string, requestPath: string): Promise<{
  body: string;
  headers: http.IncomingHttpHeaders;
  status: number;
}> {
  return await new Promise((resolve, reject) => {
    const requestValue = http.request({ headers: { host }, hostname: "127.0.0.1", path: requestPath, port }, (response) => {
      const chunks: Buffer[] = [];
      response.on("data", (chunk: Buffer) => chunks.push(chunk));
      response.once("end", () => resolve({
        body: Buffer.concat(chunks).toString("utf8"),
        headers: response.headers,
        status: response.statusCode ?? 0
      }));
    });
    requestValue.once("error", reject);
    requestValue.end();
  });
}

async function reservePort(): Promise<number> {
  const server = http.createServer();
  await new Promise<void>((resolve, reject) => {
    server.once("error", reject);
    server.listen(0, "127.0.0.1", resolve);
  });
  const address = server.address();
  assert.ok(address && typeof address !== "string");
  await new Promise<void>((resolve) => server.close(() => resolve()));
  return address.port;
}

async function stop(child: ReturnType<typeof spawn>): Promise<void> {
  if (child.exitCode !== null) return;
  child.kill("SIGTERM");
  const exited = new Promise<boolean>((resolve) => child.once("exit", () => resolve(true)));
  if (await Promise.race([exited, new Promise<false>((resolve) => setTimeout(() => resolve(false), 2_000))])) return;
  child.kill("SIGKILL");
  await Promise.race([exited, new Promise((resolve) => setTimeout(resolve, 1_000))]);
}

console.log("PRV-001 standalone signed wildcard middleware ok");
