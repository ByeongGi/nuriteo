import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import net from "node:net";
import path from "node:path";
import { chromium } from "@playwright/test";

const root = new URL("../../..", import.meta.url).pathname;
const fixture = path.join(root, "tests/fixtures/static-cjs-factory-csp");
const port = await availablePort();
const server = spawn(path.join(root, "node_modules/.bin/vite"), ["--host", "127.0.0.1", "--port", String(port), "--strictPort"], {
  cwd: fixture,
  stdio: ["ignore", "pipe", "pipe"]
});
await new Promise<void>((resolve, reject) => {
  const timer = setTimeout(() => reject(new Error("static factory CSP server timeout")), 30_000);
  const ready = (chunk: unknown) => {
    if (!String(chunk).includes("Local:")) return;
    clearTimeout(timer);
    resolve();
  };
  server.stdout.on("data", ready);
  server.stderr.on("data", ready);
  server.on("error", reject);
  server.on("exit", (code) => reject(new Error(`static factory CSP server exited: ${code}`)));
});
const browser = await chromium.launch({ headless: true });
try {
  const page = await browser.newPage();
  const errors: string[] = [];
  page.on("pageerror", (error) => errors.push(error.message));
  page.on("console", (message) => message.type() === "error" && errors.push(message.text()));
  await page.goto(`http://127.0.0.1:${port}`);
  await page.locator("#result").getByText("0:strict-csp-static-factory").waitFor({ timeout: 30_000 }).catch(() => {
    throw new Error(`strict CSP fixture did not complete: ${errors.join(" | ")}`);
  });
  assert.match(await page.locator("#result").innerText(), /^0:/);
} finally {
  await browser.close();
  server.kill("SIGTERM");
}
console.log("browser strict-CSP static CJS factory test ok");

function availablePort(): Promise<number> {
  return new Promise((resolve, reject) => {
    const server = net.createServer();
    server.listen(0, "127.0.0.1", () => {
      const address = server.address();
      if (!address || typeof address === "string") return reject(new Error("port allocation failed"));
      server.close((error) => error ? reject(error) : resolve(address.port));
    });
  });
}
