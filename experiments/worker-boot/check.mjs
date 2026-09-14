import { spawn } from "node:child_process";
import http from "node:http";
import fs from "node:fs";
import path from "node:path";
import { once } from "node:events";

const chromePath = process.env.CHROME_PATH || "/Applications/Google Chrome.app/Contents/MacOS/Google Chrome";

if (!fs.existsSync(chromePath)) {
  console.error(`Chrome not found at ${chromePath}`);
  process.exit(1);
}

function getJson(url) {
  return new Promise((resolve, reject) => {
    http.get(url, (res) => {
      let body = "";
      res.setEncoding("utf8");
      res.on("data", (chunk) => body += chunk);
      res.on("end", () => {
        try {
          resolve(JSON.parse(body));
        } catch (error) {
          reject(error);
        }
      });
    }).on("error", reject);
  });
}

function putJson(url) {
  return new Promise((resolve, reject) => {
    const req = http.request(url, { method: "PUT" }, (res) => {
      let body = "";
      res.setEncoding("utf8");
      res.on("data", (chunk) => body += chunk);
      res.on("end", () => {
        try {
          resolve(JSON.parse(body));
        } catch (error) {
          reject(error);
        }
      });
    });
    req.on("error", reject);
    req.end();
  });
}

async function waitForVersion(port) {
  const deadline = Date.now() + 10000;
  while (Date.now() < deadline) {
    try {
      return await getJson(`http://127.0.0.1:${port}/json/version`);
    } catch {
      await new Promise((resolve) => setTimeout(resolve, 100));
    }
  }
  throw new Error("Chrome remote debugging endpoint did not start");
}

let nextId = 1;

function createCdp(wsUrl) {
  const ws = new WebSocket(wsUrl);
  const pending = new Map();
  const listeners = new Map();
  ws.addEventListener("message", (event) => {
    const msg = JSON.parse(event.data);
    if (msg.id && pending.has(msg.id)) {
      const { resolve, reject } = pending.get(msg.id);
      pending.delete(msg.id);
      if (msg.error) reject(new Error(JSON.stringify(msg.error)));
      else resolve(msg.result);
      return;
    }
    const list = listeners.get(msg.method) || [];
    for (const listener of list) listener(msg.params || {});
  });
  const opened = new Promise((resolve, reject) => {
    ws.addEventListener("open", resolve, { once: true });
    ws.addEventListener("error", reject, { once: true });
  });
  return {
    opened,
    on(method, listener) {
      listeners.set(method, [...(listeners.get(method) || []), listener]);
    },
    send(method, params = {}) {
      const id = nextId++;
      ws.send(JSON.stringify({ id, method, params }));
      return new Promise((resolve, reject) => pending.set(id, { resolve, reject }));
    },
    close() {
      ws.close();
    }
  };
}

async function evaluatePage(cdp, url) {
  const diagnostics = {
    exceptions: [],
    console: []
  };
  cdp.on("Runtime.exceptionThrown", (params) => {
    diagnostics.exceptions.push({
      text: params.exceptionDetails?.text,
      url: params.exceptionDetails?.url,
      lineNumber: params.exceptionDetails?.lineNumber,
      columnNumber: params.exceptionDetails?.columnNumber,
      description: params.exceptionDetails?.exception?.description
    });
  });
  cdp.on("Runtime.consoleAPICalled", (params) => {
    diagnostics.console.push(params.args?.map((arg) => arg.value || arg.description || "").join(" ") || params.type);
  });
  await cdp.send("Page.enable");
  await cdp.send("Runtime.enable");
  const loaded = new Promise((resolve) => cdp.on("Page.loadEventFired", resolve));
  await cdp.send("Page.navigate", { url });
  await loaded;
  const result = await cdp.send("Runtime.evaluate", {
    awaitPromise: true,
    returnByValue: true,
    expression: `
      new Promise((resolve) => {
        const deadline = Date.now() + 7000;
        const tick = () => {
          if (globalThis.__workerBootResult) resolve(globalThis.__workerBootResult);
          else if (Date.now() > deadline) resolve({ timeout: true, isolated: crossOriginIsolated });
          else setTimeout(tick, 50);
        };
        tick();
      })
    `
  });
  return {
    ...result.result.value,
    diagnostics
  };
}

async function main() {
  const server = spawn(process.execPath, [new URL("./server.mjs", import.meta.url).pathname], {
    stdio: ["ignore", "pipe", "inherit"]
  });
  const [serverLine] = await once(server.stdout, "data");
  const baseUrl = String(serverLine).trim();
  const userDataDir = path.join("/private/tmp", `cargo-container-worker-boot-${process.pid}`);
  const debugPort = 9400 + (process.pid % 1000);
  const chrome = spawn(chromePath, [
    "--headless=new",
    `--remote-debugging-port=${debugPort}`,
    `--user-data-dir=${userDataDir}`,
    "--no-first-run",
    "--disable-background-networking",
    "about:blank"
  ], { stdio: ["ignore", "ignore", "ignore"] });

  try {
    await waitForVersion(debugPort);
    const target = await putJson(`http://127.0.0.1:${debugPort}/json/new?about:blank`);
    const cdp = createCdp(target.webSocketDebuggerUrl);
    await cdp.opened;
    const summary = await evaluatePage(cdp, `${baseUrl}/index.html`);
    cdp.close();
    console.log(JSON.stringify(summary, null, 2));

    if (!summary.timeout && !summary.crossOriginIsolated) throw new Error("runtime lab page was not isolated");
    if (summary.timeout) throw new Error(`runtime lab timed out: ${JSON.stringify(summary.diagnostics)}`);
    if (summary.cycles.length !== 3) throw new Error("expected three boot cycles");
    for (const cycle of summary.cycles) {
      if (cycle.boot.role !== "system") throw new Error("boot did not resolve from system worker");
      if (!cycle.boot.details.processSeen) throw new Error("system worker did not observe process worker");
      if (cycle.boot.details.syscall?.payload !== "pong") throw new Error("SAB syscall ping did not roundtrip");
      if (cycle.statusAfterBoot !== "ready") throw new Error("status after boot was not ready");
      if (cycle.statusAfterTeardown !== "stopped") throw new Error("status after teardown was not stopped");
    }
    if (!summary.failures.process.includes("Process worker failed")) throw new Error("process failure did not propagate");
    if (!summary.failures.system.includes("System worker failed")) throw new Error("system failure did not propagate");
    if (summary.uiGuestRan) throw new Error("guest code ran on the UI page");
  } finally {
    chrome.kill("SIGTERM");
    server.kill("SIGTERM");
  }
}

main().catch((error) => {
  console.error(error);
  process.exit(1);
});
