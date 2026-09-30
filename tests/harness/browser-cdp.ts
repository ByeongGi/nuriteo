import { spawn } from "node:child_process";
import http from "node:http";
import fs from "node:fs";
import path from "node:path";

const chromePath = process.env.CHROME_PATH || "/Applications/Google Chrome.app/Contents/MacOS/Google Chrome";

function getJson(url) {
  return new Promise((resolve, reject) => {
    http.get(url, (res) => {
      let body = "";
      res.setEncoding("utf8");
      res.on("data", (chunk) => body += chunk);
      res.on("end", () => {
        try { resolve(JSON.parse(body)); }
        catch (error) { reject(error); }
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
        try { resolve(JSON.parse(body)); }
        catch (error) { reject(error); }
      });
    });
    req.on("error", reject);
    req.end();
  });
}

async function waitForVersion(port) {
  const deadline = Date.now() + 10000;
  while (Date.now() < deadline) {
    try { return await getJson(`http://127.0.0.1:${port}/json/version`); }
    catch { await new Promise((resolve) => setTimeout(resolve, 100)); }
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
    for (const listener of listeners.get(msg.method) || []) listener(msg.params || {});
  });
  return {
    opened: new Promise((resolve, reject) => {
      ws.addEventListener("open", resolve, { once: true });
      ws.addEventListener("error", reject, { once: true });
    }),
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

export async function withChromePage(callback) {
  if (!fs.existsSync(chromePath)) throw new Error(`Chrome not found at ${chromePath}`);
  const debugPort = 9500 + (process.pid % 1000);
  const userDataDir = path.join("/private/tmp", `nuriteo-harness-${process.pid}-${Date.now()}`);
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
    try {
      return await callback(cdp);
    } finally {
      cdp.close();
    }
  } finally {
    chrome.kill("SIGTERM");
  }
}
