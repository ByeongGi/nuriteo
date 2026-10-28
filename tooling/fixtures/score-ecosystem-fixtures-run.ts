import fs from "node:fs";
import path from "node:path";
import { spawn, spawnSync } from "node:child_process";
import { resolveViteHmrUrl } from "../../packages/preview/src/index.ts";
import { createFallbackWorkspaceReader, createNodeFsWorkspaceReader } from "../shared/fs-workspace-reader.ts";
import { NodeThreadCliEvaluationWorker } from "../../packages/workers/node-thread-cli-worker.ts";
import { actualWorkerTimeoutMs, args, matrix, results } from "./score-ecosystem-fixtures.ts";

export function actualExecutionPort(execution) {
  const registered = execution.serverRegistrations?.find((registration) => typeof registration.port === "number")?.port;
  if (registered) return registered;
  const stdoutPort = String(execution.stdout || "").match(/http:\/\/127\.0\.0\.1:(\d+)\//)?.[1];
  return stdoutPort ? Number(stdoutPort) : 5173;
}


function workerCliOptions() {
  return {
    isolation: "worker",
    readyTimeoutMs: 1000,
    workerFactory: () => new NodeThreadCliEvaluationWorker(),
    workerTimeoutMs: actualWorkerTimeoutMs
  };
}


export function executeActualCli(workflow, args) {
  const timeoutMs = actualWorkerTimeoutMs + 5000;
  let timeout = null;
  const execution = workflow.executeRealCli(args, {}, workerCliOptions());
  const guard = new Promise((_, reject) => {
    timeout = setTimeout(() => {
      reject(new Error(`EACTUALCLITIMEOUT: actual product CLI scoring did not settle within ${timeoutMs}ms for ${args.join(" ")}`));
    }, timeoutMs);
  });
  return Promise.race([execution, guard]).finally(() => {
    if (timeout) clearTimeout(timeout);
  });
}


export function withTimeout(promise, timeoutMs, message) {
  let timeout = null;
  const guard = new Promise((_, reject) => {
    timeout = setTimeout(() => reject(new Error(message)), timeoutMs);
  });
  return Promise.race([promise, guard]).finally(() => {
    if (timeout) clearTimeout(timeout);
  });
}


export function summarizeWorkspaceDistArtifacts(snapshot, projectRoot) {
  const prefix = `${projectRoot}/dist/`;
  const files = (snapshot?.files || [])
    .filter((file) => file.path.startsWith(prefix))
    .map((file) => ({
      path: file.path.slice(projectRoot.length + 1),
      size: String(file.data || "").length
    }))
    .sort((left, right) => left.path.localeCompare(right.path));
  return {
    count: files.length,
    files
  };
}


export function parseHmrMessageType(message) {
  try {
    return JSON.parse(message).type || null;
  } catch {
    return null;
  }
}


export function headersForFetchPath(path) {
  if (path.startsWith("/@vite/") || path.startsWith("/@id/") || /\.[cm]?[jt]sx?(?:$|\?)/.test(path)) {
    return {
      accept: "*/*",
      "sec-fetch-dest": "script"
    };
  }
  if (/\.css(?:$|\?)/.test(path)) {
    return {
      accept: "text/css,*/*;q=0.1",
      "sec-fetch-dest": "style"
    };
  }
  return {
    accept: "text/html,application/xhtml+xml"
  };
}


function uniqueNames(values) {
  return [...new Set(values.filter((value) => typeof value === "string" && value.length > 0))].sort();
}


export function createDependencyReader(nodeModulesRoot) {
  const readers = [createNodeFsWorkspaceReader({
    root: nodeModulesRoot,
    virtualRoot: "/workspace/project/node_modules"
  })];
  const pnpmHoistedRoot = path.join(nodeModulesRoot, ".pnpm/node_modules");
  if (fs.existsSync(pnpmHoistedRoot)) {
    readers.push(createNodeFsWorkspaceReader({
      root: pnpmHoistedRoot,
      virtualRoot: "/workspace/project/node_modules"
    }));
  }
  return createFallbackWorkspaceReader(readers);
}


export function criterion(id, passed, result) {
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


export function summarize(results) {
  const passCount = results.filter((result) => result.status === "pass").length;
  return {
    total: results.length,
    passCount,
    milestoneB: passCount >= matrix.scope.minimumPassForMilestoneB ? "pass" : "not-yet"
  };
}


export function classifyScore(score, unsupportedBlocker) {
  if (unsupportedBlocker) return "unsupported";
  if (score >= 80) return "pass";
  if (score >= 50) return "partial-pass";
  return "hold";
}


export function summarizeFailures(results) {
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


export function runCommandString(command, cwd) {
  const [bin, ...argv] = command.split(/\s+/).filter(Boolean);
  if (!bin) throw new Error(`empty command for ${cwd}`);
  return run(bin, argv, cwd);
}


export function run(bin, argv, cwd) {
  return spawnSync(bin, argv, {
    cwd,
    encoding: "utf8",
    maxBuffer: 1024 * 1024 * 10,
    shell: false
  });
}


export function errorResult(error) {
  return {
    status: 1,
    stdout: "",
    stderr: error instanceof Error ? error.stack || error.message : String(error)
  };
}


export async function runDevPreviewAndHmr(command, cwd) {
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
  const marker = `\n// nuriteo-hmr-${Date.now()}\n`;
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


export function defaultOutputForMode(scoreMode) {
  if (scoreMode === "product-adapter") return "compat/ecosystem-fixture-product-results.json";
  if (scoreMode === "product-actual") return "compat/ecosystem-fixture-actual-product-results.json";
  return "compat/ecosystem-fixture-results.json";
}


export function readPackageVersion(packageRoot) {
  try {
    return JSON.parse(fs.readFileSync(path.join(path.resolve(packageRoot), "package.json"), "utf8")).version || null;
  } catch {
    return null;
  }
}


export function valueAfter(name) {
  const prefix = `${name}=`;
  const values = process.argv.slice(2);
  const inline = values.find((arg) => arg.startsWith(prefix));
  if (inline) return inline.slice(prefix.length);
  const index = values.indexOf(name);
  if (index < 0) return undefined;
  const value = values[index + 1];
  return value && !value.startsWith("--") ? value : undefined;
}
