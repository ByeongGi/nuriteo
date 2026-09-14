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
  ws.addEventListener("message", (event) => {
    const msg = JSON.parse(event.data);
    if (msg.id && pending.has(msg.id)) {
      const { resolve, reject } = pending.get(msg.id);
      pending.delete(msg.id);
      if (msg.error) reject(new Error(JSON.stringify(msg.error)));
      else resolve(msg.result);
    }
  });
  const opened = new Promise((resolve, reject) => {
    ws.addEventListener("open", resolve, { once: true });
    ws.addEventListener("error", reject, { once: true });
  });
  return {
    opened,
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
  await cdp.send("Page.enable");
  await cdp.send("Runtime.enable");
  const loaded = new Promise((resolve) => {
    const original = cdp.send.bind(cdp);
    cdp.send = original;
    resolve();
  });
  await cdp.send("Page.navigate", { url });
  await loaded;
  const result = await cdp.send("Runtime.evaluate", {
    awaitPromise: true,
    returnByValue: true,
    expression: `
      new Promise((resolve) => {
        const deadline = Date.now() + 5000;
        const tick = () => {
          if (globalThis.__p0Result) resolve(globalThis.__p0Result);
          else if (Date.now() > deadline) resolve({ timeout: true, isolated: crossOriginIsolated, sab: typeof SharedArrayBuffer });
          else setTimeout(tick, 50);
        };
        tick();
      })
    `
  });
  return result.result.value;
}

async function main() {
  const server = spawn(process.execPath, [new URL("./server.mjs", import.meta.url).pathname], {
    stdio: ["ignore", "pipe", "inherit"]
  });
  const [serverLine] = await once(server.stdout, "data");
  const baseUrl = String(serverLine).trim();
  const userDataDir = path.join("/private/tmp", `cargo-container-chrome-${process.pid}`);
  const debugPort = 9300 + (process.pid % 1000);
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
    const isolated = await evaluatePage(cdp, `${baseUrl}/index.html`);
    const broken = await evaluatePage(cdp, `${baseUrl}/broken/index.html`);
    cdp.close();

    const summary = { isolated, broken };
    console.log(JSON.stringify(summary, null, 2));

    if (!isolated.crossOriginIsolated) throw new Error("isolated page was not crossOriginIsolated");
    if (!isolated.worker?.sabOk) throw new Error("isolated worker did not complete SAB check");
    if (!isolated.preview?.accepted) throw new Error("same-origin preview handshake was not accepted");
    if (!isolated.preview?.rejectedBadOrigin) throw new Error("bad origin message was not rejected");
    if (isolated.inlineScriptRan) throw new Error("CSP allowed inline script unexpectedly");
    if (broken.crossOriginIsolated) throw new Error("broken page unexpectedly became crossOriginIsolated");
    if (broken.worker?.sabOk) throw new Error("broken page unexpectedly completed SAB check");
  } finally {
    chrome.kill("SIGTERM");
    server.kill("SIGTERM");
  }
}

main().catch((error) => {
  console.error(error);
  process.exit(1);
});
