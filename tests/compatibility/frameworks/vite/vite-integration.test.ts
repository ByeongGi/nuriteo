import assert from "node:assert/strict";
import fs from "node:fs";
import http from "node:http";
import os from "node:os";
import path from "node:path";
import { spawn, spawnSync } from "node:child_process";
import { once } from "node:events";
import { chromium } from "@playwright/test";

const root = new URL("../../../..", import.meta.url).pathname;
const fixtures = [
  {
    name: "vite-vanilla",
    path: path.join(root, "tests/fixtures/vite-vanilla"),
    messageFile: "src/message.ts"
  },
  {
    name: "vite-react",
    path: path.join(root, "tests/fixtures/vite-react"),
    messageFile: "src/message.js"
  },
  {
    name: "vite-vue",
    path: path.join(root, "tests/fixtures/vite-vue"),
    messageFile: "src/message.js"
  },
  {
    name: "vite-svelte",
    path: path.join(root, "tests/fixtures/vite-svelte"),
    messageFile: "src/message.js"
  }
];
const chromePath = process.env.CHROME_PATH || "/Applications/Google Chrome.app/Contents/MacOS/Google Chrome";

if (!fs.existsSync(chromePath)) {
  throw new Error(`Chrome not found at ${chromePath}`);
}

for (const fixture of fixtures) {
  for (const manager of ["npm", "pnpm"]) {
    await runViteFixture(fixture, manager);
  }
}

console.log("vite integration test ok");

async function runViteFixture(fixture, manager) {
  const workdir = fs.mkdtempSync(path.join(os.tmpdir(), `${fixture.name}-${manager}-`));
  let completed = false;
  try {
    copyFixture(fixture.path, workdir);
    const installArgs = manager === "npm"
      ? ["install", "--cache", path.join(workdir, ".npm-cache")]
      : ["install", "--frozen-lockfile=false", "--store-dir", path.join(workdir, ".pnpm-store")];
    const install = runInstallWithRecovery(manager, workdir, installArgs);
    assert.equal(install.status, 0, `${manager} install failed in ${workdir}\nstdout:\n${install.stdout}\nstderr:\n${install.stderr}`);

    const dev = spawnPackageManager(manager, workdir, ["run", "dev", "--", "--port", "0", "--strictPort"]);
    const devUrl = await waitForViteUrl(dev);
    const devBrowser = await chromium.launch({ headless: true, executablePath: chromePath });
    try {
      const page = await devBrowser.newPage();
      await page.goto(devUrl, { waitUntil: "networkidle" });
      await page.waitForFunction(() => document.querySelector("#app")?.textContent === "alpha:1");
      fs.writeFileSync(path.join(workdir, fixture.messageFile), "export const label = \"beta\";\n");
      await page.waitForFunction(() => document.querySelector("#app")?.textContent === "beta:1");
      const state = await page.evaluate(() => globalThis.__fixtureState?.count);
      assert.equal(state, 1);
    } finally {
      await devBrowser.close();
      dev.kill("SIGTERM");
      await onceExit(dev);
    }

    const build = runPackageManager(manager, workdir, ["run", "build"]);
    assert.equal(build.status, 0, build.stderr);
    assert.equal(fs.existsSync(path.join(workdir, "dist/index.html")), true);

    const previewServer = await serveDirectory(path.join(workdir, "dist"));
    const previewBrowser = await chromium.launch({ headless: true, executablePath: chromePath });
    try {
      const page = await previewBrowser.newPage();
      await page.goto(previewServer.url, { waitUntil: "networkidle" });
      await page.waitForFunction(() => document.querySelector("#app")?.textContent?.startsWith("beta:"));
    } finally {
      await previewBrowser.close();
      await previewServer.close();
    }

    const restarted = spawnPackageManager(manager, workdir, ["run", "dev", "--", "--port", "0", "--strictPort"]);
    await waitForViteUrl(restarted);
    restarted.kill("SIGTERM");
    await onceExit(restarted);
    completed = true;
  } finally {
    if (completed) fs.rmSync(workdir, { recursive: true, force: true });
    else console.error(`preserved failed Vite fixture at ${workdir}`);
  }
}

function runPackageManager(manager, cwd, args) {
  const entry = manager === "npm"
    ? path.join(root, "vendor/cli/npm/10.9.2/package/bin/npm-cli.js")
    : path.join(root, "vendor/cli/pnpm/9.15.9/package/bin/pnpm.cjs");
  return spawnSync(process.execPath, [entry, ...args], {
    cwd,
    env: {
      ...process.env,
      npm_config_audit: "false",
      npm_config_fund: "false",
      npm_config_loglevel: "error",
      npm_config_logs_dir: path.join(cwd, ".npm-logs"),
      npm_config_userconfig: path.join(cwd, ".npmrc"),
      npm_config_update_notifier: "false"
    },
    encoding: "utf8",
    timeout: 120000
  });
}

function spawnPackageManager(manager, cwd, args) {
  const entry = manager === "npm"
    ? path.join(root, "vendor/cli/npm/10.9.2/package/bin/npm-cli.js")
    : path.join(root, "vendor/cli/pnpm/9.15.9/package/bin/pnpm.cjs");
  return spawn(process.execPath, [entry, ...args], {
    cwd,
    env: {
      ...process.env,
      npm_config_audit: "false",
      npm_config_fund: "false",
      npm_config_loglevel: "error",
      npm_config_logs_dir: path.join(cwd, ".npm-logs"),
      npm_config_userconfig: path.join(cwd, ".npmrc"),
      npm_config_update_notifier: "false"
    },
    stdio: ["ignore", "pipe", "pipe"]
  });
}

function runInstallWithRecovery(manager, cwd, args) {
  const first = runPackageManager(manager, cwd, args);
  if (first.status === 0) return first;
  fs.rmSync(path.join(cwd, "node_modules"), { recursive: true, force: true });
  const second = runPackageManager(manager, cwd, args);
  if (second.status === 0) {
    return {
      ...second,
      stdout: `${first.stdout}\n[recovered after retry]\n${second.stdout}`,
      stderr: `${first.stderr}\n${second.stderr}`
    };
  }
  return {
    ...second,
    stdout: `${first.stdout}\n[retry failed]\n${second.stdout}`,
    stderr: `${first.stderr}\n${second.stderr}`
  };
}

async function waitForViteUrl(child) {
  let output = "";
  return await new Promise((resolve, reject) => {
    const timeout = setTimeout(() => reject(new Error(`Vite URL not found:\n${output}`)), 30000);
    const read = (chunk) => {
      output += String(chunk);
      const match = output.match(/http:\/\/127\.0\.0\.1:\d+\//);
      if (match) {
        clearTimeout(timeout);
        resolve(match[0]);
      }
    };
    child.stdout.on("data", read);
    child.stderr.on("data", read);
    child.once("exit", (code) => {
      clearTimeout(timeout);
      reject(new Error(`Vite exited early with ${code}:\n${output}`));
    });
  });
}

async function onceExit(child) {
  if (child.exitCode !== null || child.signalCode !== null) return;
  await Promise.race([
    once(child, "exit"),
    new Promise((resolve) => setTimeout(resolve, 1000))
  ]);
}

async function serveDirectory(dir) {
  const server = http.createServer((req, res) => {
    const url = new URL(req.url || "/", "http://127.0.0.1");
    const file = path.join(dir, url.pathname === "/" ? "index.html" : url.pathname);
    if (!file.startsWith(dir)) {
      res.writeHead(403);
      res.end("Forbidden");
      return;
    }
    fs.readFile(file, (error, body) => {
      if (error) {
        res.writeHead(404);
        res.end("Not found");
        return;
      }
      res.writeHead(200, { "content-type": mime(path.extname(file)) });
      res.end(body);
    });
  });
  await new Promise((resolve) => server.listen(0, "127.0.0.1", resolve));
  const { port } = server.address();
  return {
    url: `http://127.0.0.1:${port}/`,
    close: () => new Promise((resolve) => server.close(resolve))
  };
}

function mime(extension) {
  return {
    ".html": "text/html; charset=utf-8",
    ".js": "text/javascript; charset=utf-8",
    ".css": "text/css; charset=utf-8"
  }[extension] || "application/octet-stream";
}

function copyFixture(source, target) {
  fs.cpSync(source, target, { recursive: true });
}
