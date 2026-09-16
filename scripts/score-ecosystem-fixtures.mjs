#!/usr/bin/env node
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { spawn, spawnSync } from "node:child_process";
import { ViteProductWorkflow } from "../packages/node-runtime/src/index.ts";
import { resolveViteHmrUrl } from "../packages/preview/src/index.ts";

const root = new URL("..", import.meta.url).pathname;
const matrixPath = path.join(root, "compat/ecosystem-fixtures.json");
const matrix = JSON.parse(fs.readFileSync(matrixPath, "utf8"));
const args = new Set(process.argv.slice(2));
const planOnly = args.has("--plan");
const mode = valueAfter("--mode") || "reference";
const selectedIds = valueAfter("--fixtures")?.split(",").filter(Boolean) || matrix.fixtures.map((fixture) => fixture.id);
const workdir = valueAfter("--workdir") || path.join(os.tmpdir(), "cargo-container-ecosystem-fixtures");
const outputPath = valueAfter("--output") || path.join(root, mode === "product-adapter"
  ? "compat/ecosystem-fixture-product-results.json"
  : "compat/ecosystem-fixture-results.json");

const selected = matrix.fixtures.filter((fixture) => selectedIds.includes(fixture.id));
if (selected.length !== selectedIds.length) {
  const known = new Set(matrix.fixtures.map((fixture) => fixture.id));
  const missing = selectedIds.filter((id) => !known.has(id));
  throw new Error(`Unknown fixture id: ${missing.join(", ")}`);
}

const results = [];
for (const fixture of selected) {
  results.push(planOnly ? plannedResult(fixture) : await scoreFixture(fixture, mode));
}
const payload = {
  schemaVersion: 1,
  generatedAt: new Date().toISOString(),
  source: "compat/ecosystem-fixtures.json",
  minimumPassForMilestoneB: matrix.scope.minimumPassForMilestoneB,
  results,
  failureSummary: summarizeFailures(results),
  summary: summarize(results)
};

if (planOnly) {
  process.stdout.write(`${JSON.stringify(payload, null, 2)}\n`);
} else {
  fs.writeFileSync(outputPath, `${JSON.stringify(payload, null, 2)}\n`);
  process.stdout.write(`ecosystem fixture results written: ${path.relative(root, outputPath)}\n`);
}

function plannedResult(fixture) {
  return {
    id: fixture.id,
    name: fixture.name,
    mode: "plan",
    packageManager: fixture.packageManager,
    repository: fixture.repository,
    subdirectory: fixture.subdirectory || null,
    expectedCommands: fixture.expectedCommands,
    score: 0,
    status: "not-run",
    unsupportedBlocker: false,
    criteria: matrix.scoringRubric.criteria.map((criterion) => ({
      id: criterion.id,
      points: criterion.points,
      status: "not-run"
    }))
  };
}

async function scoreFixture(fixture, scoreMode) {
  if (scoreMode === "product-adapter") return scoreProductAdapterFixture(fixture);
  if (scoreMode !== "reference") throw new Error(`Unsupported score mode: ${scoreMode}`);

  const checkout = path.join(workdir, fixture.id);
  const projectDir = fixture.subdirectory ? path.join(checkout, fixture.subdirectory) : checkout;
  const criteria = [];
  fs.mkdirSync(workdir, { recursive: true });
  if (!fs.existsSync(checkout)) {
    const clone = run("git", ["clone", "--depth", "1", fixture.repository, checkout], workdir);
    if (clone.status !== 0) return failedResult(fixture, "install", clone);
  }

  const install = runCommandString(fixture.expectedCommands.install, projectDir);
  criteria.push(criterion("install", install.status === 0, install));
  const build = runCommandString(fixture.expectedCommands.build, projectDir);
  criteria.push(criterion("build-dist", build.status === 0, build));

  const { devPreview, editHmr } = await runDevPreviewAndHmr(fixture.expectedCommands.dev, projectDir);
  criteria.push(criterion("dev-preview", devPreview.status === 0, devPreview));
  criteria.push(criterion("edit-hmr", editHmr.status === 0, editHmr));

  const score = criteria.reduce((total, entry) => total + (entry.status === "pass" ? entry.points : 0), 0);
  return {
    id: fixture.id,
    name: fixture.name,
    mode: "measured-reference",
    packageManager: fixture.packageManager,
    repository: fixture.repository,
    subdirectory: fixture.subdirectory || null,
    score,
    status: classifyScore(score, false),
    unsupportedBlocker: false,
    criteria
  };
}

function scoreProductAdapterFixture(fixture) {
  const workflow = new ViteProductWorkflow({
    manager: fixture.packageManager,
    projectId: fixture.id,
    projectRoot: `/workspace/${fixture.id}`
  });
  const criteria = [];

  try {
    const install = workflow.install();
    criteria.push(criterion("install", install.installed, {
      status: install.installed ? 0 : 1,
      stdout: `installed ${install.packages.length} packages\nwrote ${install.lockfile}\nvite package source ${install.vitePackageSource}\n`,
      stderr: ""
    }));
  } catch (error) {
    criteria.push(criterion("install", false, errorResult(error)));
  }

  try {
    const build = workflow.buildFromPackageScript();
    criteria.push(criterion("build-dist", build.files.length > 0 && build.distSmoke.includes("<!doctype html>"), {
      status: build.files.length > 0 ? 0 : 1,
      stdout: `emitted ${build.files.join(", ")}\n${build.distSmoke}\n`,
      stderr: ""
    }));
  } catch (error) {
    criteria.push(criterion("build-dist", false, errorResult(error)));
  }

  try {
    const devServer = workflow.startDevServerFromPackageScript();
    const preview = workflow.preview("/");
    criteria.push(criterion("dev-preview", devServer.running && preview.statusCode === 200, {
      status: devServer.running && preview.statusCode === 200 ? 0 : 1,
      stdout: `dev server ${devServer.source} ${devServer.command} on 127.0.0.1:${devServer.port}\n${preview.body}\n`,
      stderr: ""
    }));
  } catch (error) {
    criteria.push(criterion("dev-preview", false, errorResult(error)));
  }

  try {
    const hmr = workflow.editMessage("product-adapter");
    criteria.push(criterion("edit-hmr", hmr.update.updates.length > 0 && hmr.statePreserved, {
      status: hmr.update.updates.length > 0 && hmr.statePreserved ? 0 : 1,
      stdout: `${JSON.stringify(hmr.update)}\n`,
      stderr: ""
    }));
  } catch (error) {
    criteria.push(criterion("edit-hmr", false, errorResult(error)));
  } finally {
    workflow.stopDevServer();
  }

  const score = criteria.reduce((total, entry) => total + (entry.status === "pass" ? entry.points : 0), 0);
  return {
    id: fixture.id,
    name: fixture.name,
    mode: "measured-product-adapter",
    packageManager: fixture.packageManager,
    repository: fixture.repository,
    subdirectory: fixture.subdirectory || null,
    score,
    status: classifyScore(score, false),
    unsupportedBlocker: false,
    criteria
  };
}

function failedResult(fixture, criterionId, result) {
  return {
    id: fixture.id,
    name: fixture.name,
    mode: "measured-reference",
    packageManager: fixture.packageManager,
    repository: fixture.repository,
    subdirectory: fixture.subdirectory || null,
    score: 0,
    status: "partial-pass",
    unsupportedBlocker: false,
    criteria: [
      criterion(criterionId, false, result),
      ...matrix.scoringRubric.criteria
        .filter((entry) => entry.id !== criterionId)
        .map((entry) => ({ id: entry.id, points: entry.points, status: "not-run" }))
    ]
  };
}

function criterion(id, passed, result) {
  const spec = matrix.scoringRubric.criteria.find((entry) => entry.id === id);
  return {
    id,
    points: spec?.points || 0,
    status: passed ? "pass" : "fail",
    exitCode: result.status,
    ...(!passed ? { failureCategory: classifyFailure(id, result) } : {}),
    stdoutTail: tail(result.stdout),
    stderrTail: tail(result.stderr)
  };
}

function summarize(results) {
  const passCount = results.filter((result) => result.status === "pass").length;
  return {
    total: results.length,
    passCount,
    milestoneB: passCount >= matrix.scope.minimumPassForMilestoneB ? "pass" : "not-yet"
  };
}

function classifyScore(score, unsupportedBlocker) {
  if (unsupportedBlocker) return "unsupported";
  if (score >= 80) return "pass";
  if (score >= 50) return "partial-pass";
  return "hold";
}

function summarizeFailures(results) {
  const counts = {};
  for (const result of results) {
    for (const entry of result.criteria) {
      if (entry.status !== "fail") continue;
      const category = entry.failureCategory || "unclassified";
      counts[category] = (counts[category] || 0) + 1;
    }
  }
  return Object.fromEntries(Object.entries(counts).sort(([left], [right]) => left.localeCompare(right)));
}

function classifyFailure(id, result) {
  const text = `${result.stdout || ""}\n${result.stderr || ""}`.toLowerCase();
  if (text.includes("err_pnpm_ignored_builds")) return "package-manager-ignored-build-scripts";
  if (text.includes("preview did not become ready") || text.includes("preview returned http")) return "dev-preview-unavailable";
  if (id === "edit-hmr" && text.includes("skipped hmr")) return "dev-preview-unavailable";
  if (id === "edit-hmr" && text.includes("hmr socket failed")) return "hmr-socket-connect-failed";
  if (id === "edit-hmr" && text.includes("hmr socket did not open")) return "hmr-socket-connect-failed";
  if (id === "edit-hmr" && text.includes("hmr update was not observed")) return "hmr-update-timeout";
  if (id === "edit-hmr" && text.includes("no editable source")) return "hmr-edit-source-missing";
  if (text.includes("native addon")) return "native-addon-unsupported";
  return `${id}-command-failed`;
}

function runCommandString(command, cwd) {
  const [bin, ...argv] = command.split(/\s+/).filter(Boolean);
  if (!bin) throw new Error(`empty command for ${cwd}`);
  return run(bin, argv, cwd);
}

function run(bin, argv, cwd) {
  return spawnSync(bin, argv, {
    cwd,
    encoding: "utf8",
    maxBuffer: 1024 * 1024 * 10,
    shell: false
  });
}

function errorResult(error) {
  return {
    status: 1,
    stdout: "",
    stderr: error instanceof Error ? error.stack || error.message : String(error)
  };
}

async function runDevPreviewAndHmr(command, cwd) {
  const [bin, ...argv] = command.split(/\s+/).filter(Boolean);
  if (!bin) throw new Error(`empty dev command for ${cwd}`);
  const child = spawn(bin, argv, {
    cwd,
    detached: process.platform !== "win32",
    env: {
      ...process.env,
      BROWSER: "none",
      CI: "true",
      HOST: "127.0.0.1",
      PORT: "5173"
    },
    shell: false
  });
  let stdout = "";
  let stderr = "";
  child.stdout.on("data", (chunk) => {
    stdout += chunk;
  });
  child.stderr.on("data", (chunk) => {
    stderr += chunk;
  });

  try {
    const response = await waitForPreview(() => firstPreviewUrl(stdout, stderr) || "http://127.0.0.1:5173/");
    const previewUrl = firstPreviewUrl(stdout, stderr) || "http://127.0.0.1:5173/";
    const editHmr = response.ok
      ? await runEditHmr(previewUrl, cwd)
      : { status: 1, stdout: "", stderr: `preview returned HTTP ${response.status}` };
    return {
      devPreview: {
        status: response.ok ? 0 : 1,
        stdout,
        stderr: response.ok ? stderr : `${stderr}\npreview returned HTTP ${response.status}`
      },
      editHmr
    };
  } catch (error) {
    return {
      devPreview: {
        status: 1,
        stdout,
        stderr: `${stderr}\n${error instanceof Error ? error.message : String(error)}`
      },
      editHmr: {
        status: 1,
        stdout: "",
        stderr: "Skipped HMR because preview did not become ready."
      }
    };
  } finally {
    await stopChildProcess(child);
  }
}

async function runEditHmr(previewUrl, cwd) {
  const target = findEditableSource(cwd);
  if (!target) {
    return {
      status: 1,
      stdout: "",
      stderr: "No editable source candidate found."
    };
  }
  const original = fs.readFileSync(target, "utf8");
  const marker = `\n// cargo-container-hmr-${Date.now()}\n`;
  const hmrUrl = await resolveHmrUrl(previewUrl);
  const moduleUrl = sourceModuleUrl(previewUrl, path.relative(cwd, target));
  let socket;
  try {
    await fetch(moduleUrl);
    socket = await connectHmrSocket(hmrUrl);
    const update = waitForHmrUpdate(socket);
    fs.writeFileSync(target, `${original}${marker}`);
    const message = await update;
    return {
      status: 0,
      stdout: `edited ${path.relative(cwd, target)}\n${message}`,
      stderr: ""
    };
  } catch (error) {
    return {
      status: 1,
      stdout: `edited ${path.relative(cwd, target)}`,
      stderr: error instanceof Error ? error.message : String(error)
    };
  } finally {
    fs.writeFileSync(target, original);
    socket?.close();
  }
}

async function stopChildProcess(child) {
  if (child.exitCode !== null || child.signalCode) return;
  killChildProcess(child, "SIGTERM");
  const exited = await waitForExit(child, 1000);
  if (exited) return;
  killChildProcess(child, "SIGKILL");
  await waitForExit(child, 1000);
}

function killChildProcess(child, signal) {
  try {
    if (process.platform !== "win32" && child.pid) process.kill(-child.pid, signal);
    else child.kill(signal);
  } catch {
    child.kill(signal);
  }
}

function waitForExit(child, timeoutMs) {
  return new Promise((resolve) => {
    const timer = setTimeout(() => resolve(false), timeoutMs);
    child.once("exit", () => {
      clearTimeout(timer);
      resolve(true);
    });
  });
}

async function waitForPreview(urlProvider) {
  const deadline = Date.now() + 15000;
  let lastError = null;
  while (Date.now() < deadline) {
    const url = urlProvider();
    try {
      const response = await fetch(url);
      if (response.status < 500) return response;
    } catch (error) {
      lastError = error;
    }
    await new Promise((resolve) => setTimeout(resolve, 250));
  }
  throw new Error(`preview did not become ready: ${lastError instanceof Error ? lastError.message : "timeout"}`);
}

function firstPreviewUrl(stdout, stderr) {
  const match = `${stdout}\n${stderr}`.match(/https?:\/\/(?:localhost|127\.0\.0\.1):\d+\/?/);
  return match?.[0] || null;
}

function findEditableSource(cwd) {
  const candidates = [
    "src/App.jsx",
    "src/App.tsx",
    "src/App.js",
    "src/App.ts",
    "src/main.jsx",
    "src/main.tsx",
    "src/main.js",
    "src/main.ts"
  ];
  return candidates.map((candidate) => path.join(cwd, candidate)).find((candidate) => fs.existsSync(candidate)) || null;
}

function sourceModuleUrl(previewUrl, relativePath) {
  const url = new URL(relativePath.replaceAll("\\", "/"), previewUrl);
  url.searchParams.set("t", String(Date.now()));
  return url.href;
}

async function resolveHmrUrl(previewUrl) {
  const parsed = new URL(previewUrl);
  const clientUrl = new URL("/@vite/client", parsed);
  try {
    const source = await fetch(clientUrl).then((response) => response.ok ? response.text() : "");
    return resolveViteHmrUrl({ previewUrl, clientSource: source }).url;
  } catch {
    return resolveViteHmrUrl({ previewUrl }).url;
  }
}

function connectHmrSocket(url) {
  return new Promise((resolve, reject) => {
    const socket = new WebSocket(url, "vite-hmr");
    const timeout = setTimeout(() => {
      socket.close();
      reject(new Error(`HMR socket did not open: ${url}`));
    }, 5000);
    socket.addEventListener("open", () => {
      clearTimeout(timeout);
      resolve(socket);
    }, { once: true });
    socket.addEventListener("error", () => {
      clearTimeout(timeout);
      reject(new Error(`HMR socket failed: ${url}`));
    }, { once: true });
  });
}

function waitForHmrUpdate(socket) {
  return new Promise((resolve, reject) => {
    const timeout = setTimeout(() => reject(new Error("HMR update was not observed after source edit.")), 10000);
    socket.addEventListener("message", (event) => {
      const data = String(event.data);
      if (!data.includes("\"update\"")) return;
      clearTimeout(timeout);
      resolve(data);
    });
  });
}

function tail(value = "") {
  const lines = value.split(/\r?\n/).filter(Boolean);
  return lines.slice(-20).join("\n");
}

function valueAfter(name) {
  const prefix = `${name}=`;
  return process.argv.slice(2).find((arg) => arg.startsWith(prefix))?.slice(prefix.length);
}
