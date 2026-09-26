import { chromium } from "@playwright/test";
import { spawn } from "node:child_process";
import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "../../..");
const appRoot = path.join(root, "apps/preview-service");
const chromePath = process.env.CHROME_PATH || "/Applications/Google Chrome.app/Contents/MacOS/Google Chrome";
const port = 20_000 + (process.pid % 20_000);
const baseUrl = `http://127.0.0.1:${port}`;
const viteEntry = path.join(appRoot, "node_modules/vite/bin/vite.js");

assert.ok(fs.existsSync(chromePath), `Chrome not found at ${chromePath}`);

const server = spawn(process.execPath, [viteEntry, "--host", "127.0.0.1", "--port", String(port), "--strictPort"], {
  cwd: appRoot,
  detached: process.platform !== "win32",
  env: { ...process.env },
  stdio: ["ignore", "pipe", "pipe"]
});

await waitForServer();

const browser = await chromium.launch({ executablePath: chromePath, headless: true });
const page = await browser.newPage();
const cdp = await browser.newBrowserCDPSession();
const pageErrors: string[] = [];
page.on("pageerror", (error) => pageErrors.push(error.message));

try {
  await page.goto(baseUrl, { waitUntil: "networkidle" });
  await page.waitForFunction(() => Boolean(globalThis.__previewService), null, { timeout: 30_000 });
  await page.evaluate(() => globalThis.__previewService.loadTemplate("vite-react"));
  await page.waitForFunction(() => globalThis.__previewService.snapshot().phase === "template_loaded");

  const baselineWorkers = await processWorkerTargetCount();

  // Establish different state in two real terminal tabs before either process starts.
  await page.evaluate(async () => {
    const controller = globalThis.__previewService.controller;
    await controller.runShellCommand("cd /workspace/app/first", "term-1");
    await controller.runShellCommand("export TERMINAL_NAME=first", "term-1");
  });
  await page.getByRole("button", { name: "New terminal" }).click();
  await page.getByRole("tab", { name: "Terminal 2" }).waitFor();
  await page.evaluate(async () => {
    const controller = globalThis.__previewService.controller;
    await controller.runShellCommand("cd /workspace/app/second", "term-2");
    await controller.runShellCommand("export TERMINAL_NAME=second", "term-2");
  });

  // Submit through xterm, not through a test-only process API. worker-cat maps to
  // the allowlisted persistent Worker command; its stdin is echoed as stdout.
  await submitTerminalCommand("term-1", "worker-cat");
  await submitTerminalCommand("term-2", "worker-cat");
  await page.waitForFunction(() => globalThis.__previewService.controller.listShellProcesses().length === 2);
  await waitForWorkerTargets(baselineWorkers + 2);
  await page.waitForFunction(() => globalThis.__previewService.controller.listShellProcesses().every((entry) => entry.status === "ready"));

  const running = await page.evaluate(() => globalThis.__previewService.controller.listShellProcesses()) as Array<{
    argv?: string[];
    command: string;
    cwd: string;
    generation?: number;
    pid: number;
    status: string;
    terminalId: string;
    terminalSize?: { cols: number; rows: number };
  }>;
  assert.deepEqual(running.map((entry) => entry.terminalId).sort(), ["term-1", "term-2"]);
  assert.deepEqual(running.map((entry) => entry.cwd).sort(), ["/workspace/app/first", "/workspace/app/second"]);
  assert.equal(new Set(running.map((entry) => entry.pid)).size, 2, "terminal tabs must own different PIDs");
  assert.ok(running.every((entry) => Number.isInteger(entry.generation)), "process generation must be observable");
  assert.ok(running.every((entry) => entry.argv?.[0] === "cat" || entry.command === "cat"));

  assert.equal(await page.evaluate(() => globalThis.__previewService.controller.writeShellInput("first-stdin-token", "term-1")), true);
  await page.waitForFunction(() => globalThis.__previewService.snapshot().logs.join("\n").includes("first-stdin-token"));
  assert.equal(await page.evaluate(() => globalThis.__previewService.controller.writeShellInput("second-stdin-token", "term-2")), true);
  await page.waitForFunction(() => {
    const logs = globalThis.__previewService.snapshot().logs.join("\n");
    return logs.includes("second-stdin-token");
  });

  await page.evaluate(() => {
    const controller = globalThis.__previewService.controller;
    controller.resizeShell(111, 37, "term-1");
    controller.resizeShell(93, 29, "term-2");
  });
  await page.waitForFunction(() => {
    const entries = globalThis.__previewService.controller.listShellProcesses() as Array<{
      terminalId: string;
      terminalSize?: { cols: number; rows: number };
    }>;
    return entries.find((entry) => entry.terminalId === "term-1")?.terminalSize?.cols === 111
      && entries.find((entry) => entry.terminalId === "term-2")?.terminalSize?.rows === 29;
  });

  // The product process panel must show both processes and route its controls to
  // the matching terminal, leaving the sibling process alive.
  await page.getByRole("button", { name: "Ports" }).click();
  const processPanel = page.getByRole("complementary", { name: "Ports in use" });
  const firstProcess = processPanel.locator("li").filter({ hasText: "term-1" });
  const secondProcess = processPanel.locator("li").filter({ hasText: "term-2" });
  await firstProcess.getByRole("button", { name: "Interrupt" }).click();
  await page.waitForFunction(() => {
    const ids = globalThis.__previewService.controller.listShellProcesses().map((entry) => entry.terminalId);
    return !ids.includes("term-1") && ids.includes("term-2");
  });
  await expectTerminalText("term-1", "exit 130");
  await secondProcess.getByRole("button", { name: "Terminate" }).click();
  await page.waitForFunction(() => globalThis.__previewService.controller.listShellProcesses().length === 0);
  await expectTerminalText("term-2", "exit 143");

  // Closing a session tears it down. Reusing the same terminal id creates a clean
  // session at the project root instead of retaining cwd/env or stale PID state.
  const restarted = await page.evaluate(async () => {
    const controller = globalThis.__previewService.controller;
    if (!controller.closeShell("term-1")) throw new Error("term-1 should have a session to close");
    const pwd = await controller.runShellCommand("worker-pwd", "term-1");
    const env = await controller.runShellCommand("worker-env", "term-1");
    return { cwd: pwd.stdout.trim(), env: env.stdout };
  });
  assert.equal(restarted.cwd, "/workspace/app");
  assert.doesNotMatch(restarted.env, /TERMINAL_NAME=first/);

  // Exercise immediate SIGKILL on a fresh process and ensure it can be replaced.
  const killed = await page.evaluate(async () => {
    const controller = globalThis.__previewService.controller;
    const pending = controller.runShellCommand("worker-cat", "kill-probe");
    const deadline = Date.now() + 5_000;
    while (!controller.listShellProcesses().some((entry) => entry.terminalId === "kill-probe")) {
      if (Date.now() >= deadline) throw new Error("kill-probe process did not start");
      await new Promise((resolve) => setTimeout(resolve, 10));
    }
    if (!controller.signalShell("SIGKILL", "kill-probe")) throw new Error("SIGKILL must reach the active process");
    const result = await pending;
    controller.closeShell("kill-probe");
    return { exitCode: result.exitCode, status: result.entry.status };
  });
  assert.equal(killed.exitCode, 137);
  assert.equal(killed.status, "cancelled");

  // Verify resize at the process implementation boundary: terminal-size reads the
  // BrowserProcess TTY, observes SIGWINCH, and streams the changed dimensions.
  const resized = await page.evaluate(async () => {
    const controller = globalThis.__previewService.controller;
    let output = "";
    const pending = controller.runShellCommand("worker-tty --watch", "resize-probe", (chunk) => {
      output += chunk.data;
    });
    let deadline = Date.now() + 5_000;
    while (!output.includes("80x24")) {
      if (Date.now() >= deadline) throw new Error(`initial TTY size was not streamed: ${output}`);
      await new Promise((resolve) => setTimeout(resolve, 10));
    }
    controller.resizeShell(123, 45, "resize-probe");
    deadline = Date.now() + 5_000;
    while (!output.includes("123x45")) {
      if (Date.now() >= deadline) throw new Error(`resized TTY size was not streamed: ${output}`);
      await new Promise((resolve) => setTimeout(resolve, 10));
    }
    const snapshot = controller.listShellProcesses().find((entry) => entry.terminalId === "resize-probe") as
      | (typeof controller.listShellProcesses extends () => Array<infer Entry> ? Entry : never) & {
          terminalSize?: { cols: number; rows: number };
        }
      | undefined;
    if (!controller.signalShell("SIGTERM", "resize-probe")) throw new Error("resize probe did not accept SIGTERM");
    const result = await pending;
    controller.closeShell("resize-probe");
    return { exitCode: result.exitCode, output, terminalSize: snapshot?.terminalSize };
  });
  assert.equal(resized.exitCode, 143);
  assert.match(resized.output, /80x24/);
  assert.match(resized.output, /123x45/);
  assert.deepEqual(resized.terminalSize, { cols: 123, rows: 45 });

  // More than the one-MiB retention window is streamed through the real Worker in
  // acknowledged chunks. The live stream must make progress while retained output
  // remains bounded and reports truncation.
  const pressure = await page.evaluate(async () => {
    const controller = globalThis.__previewService.controller;
    let streamedBytes = 0;
    const pending = controller.runShellCommand("worker-cat", "pressure", (chunk) => {
      streamedBytes += new TextEncoder().encode(chunk.data).byteLength;
    });
    let deadline = Date.now() + 5_000;
    while (!controller.listShellProcesses().some((entry) => entry.terminalId === "pressure")) {
      if (Date.now() >= deadline) throw new Error("pressure process did not start");
      await new Promise((resolve) => setTimeout(resolve, 10));
    }
    const chunk = "x".repeat(16 * 1024);
    for (let index = 0; index < 72; index += 1) {
      const expected = (index + 1) * chunk.length;
      if (!controller.writeShellInput(chunk, "pressure")) throw new Error(`stdin chunk ${index} rejected`);
      deadline = Date.now() + 10_000;
      while (streamedBytes < expected) {
        if (Date.now() >= deadline) throw new Error(`stdin chunk ${index} did not drain`);
        await new Promise((resolve) => setTimeout(resolve, 10));
      }
    }
    if (!controller.signalShell("SIGTERM", "pressure")) throw new Error("pressure process must accept SIGTERM");
    const result = await pending;
    controller.closeShell("pressure");
    return {
      exitCode: result.exitCode,
      outputBytes: new TextEncoder().encode(result.stdout).byteLength,
      outputTruncatedBytes: result.outputTruncatedBytes || result.entry.outputTruncatedBytes,
      streamedBytes
    };
  });
  assert.equal(pressure.exitCode, 143);
  assert.equal(pressure.streamedBytes, 72 * 16 * 1024);
  assert.ok(pressure.outputBytes <= 1024 * 1024, `retained output was not bounded: ${pressure.outputBytes}`);
  assert.ok(pressure.outputTruncatedBytes > 0, "bounded output must report dropped bytes");

  const syntax = await page.evaluate(async () => {
    const controller = globalThis.__previewService.controller;
    const messages: string[] = [];
    for (const command of ["echo safe; echo injected", "echo $(pwd)"]) {
      try {
        await controller.runShellCommand(command, "security");
      } catch (error) {
        messages.push(error instanceof Error ? error.message : String(error));
      }
    }
    return messages;
  });
  assert.equal(syntax.length, 2);
  assert.ok(syntax.every((message) => message.includes("unsupported shell syntax")));

  await page.waitForFunction(() => globalThis.__previewService.controller.listShellProcesses().length === 0);
  await waitForWorkerTargets(baselineWorkers);
  assert.deepEqual(pageErrors, []);
  console.log("preview terminal production Worker browser e2e ok");
} finally {
  await browser.close();
  stopServer();
}

async function submitTerminalCommand(terminalId: string, command: string): Promise<void> {
  await activateTerminal(terminalId);
  await page.keyboard.type(command);
  await page.keyboard.press("Enter");
}

async function activateTerminal(terminalId: string): Promise<void> {
  const sequence = Number(terminalId.replace(/^term-/, ""));
  if (Number.isSafeInteger(sequence)) await page.getByRole("tab", { name: `Terminal ${sequence}` }).click();
  await page.locator(`#terminal-xterm-${terminalId} .xterm-screen`).click();
}

async function expectTerminalText(terminalId: string, expected: string): Promise<void> {
  await activateTerminal(terminalId);
  await page.waitForFunction(
    ({ id, text }) => document.querySelector(`#terminal-xterm-${id} .xterm-rows`)?.textContent?.includes(text),
    { id: terminalId, text: expected }
  );
}

async function processWorkerTargetCount(): Promise<number> {
  const targets = await cdp.send("Target.getTargets");
  return targets.targetInfos.filter((target) => target.type === "worker" && target.url.includes("process-worker")).length;
}

async function waitForWorkerTargets(expected: number): Promise<void> {
  const deadline = Date.now() + 15_000;
  do {
    if (await processWorkerTargetCount() === expected) return;
    await new Promise((resolve) => setTimeout(resolve, 25));
  } while (Date.now() < deadline);
  assert.equal(await processWorkerTargetCount(), expected, "unexpected live process Worker target count");
}

function waitForServer(): Promise<void> {
  return new Promise((resolve, reject) => {
    const timer = setTimeout(() => reject(new Error("preview-service vite start timeout")), 60_000);
    const onData = (chunk: Buffer) => {
      const text = String(chunk);
      if (text.includes("Local:") || text.includes(baseUrl)) {
        clearTimeout(timer);
        resolve();
      }
    };
    server.stdout.on("data", onData);
    server.stderr.on("data", (chunk) => {
      process.stderr.write(chunk);
      onData(chunk);
    });
    server.on("exit", (code) => {
      clearTimeout(timer);
      reject(new Error(`preview-service vite exited early: ${code}`));
    });
  });
}

function stopServer(): void {
  if (process.platform !== "win32" && server.pid) {
    try {
      process.kill(-server.pid, "SIGKILL");
      return;
    } catch {
      // Fall back to the direct child when process groups are unavailable.
    }
  }
  server.kill("SIGKILL");
}
