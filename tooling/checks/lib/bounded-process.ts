import { spawn } from "node:child_process";

const DEFAULT_TERMINATION_GRACE_MS = 5_000;
const DEFAULT_KILL_GRACE_MS = 2_000;

export async function runBoundedProcess(options) {
  if (process.platform === "win32") {
    throw new Error("bounded process groups require a POSIX host");
  }

  const child = spawn(options.command, options.arguments, {
    cwd: options.workingDirectory,
    detached: true,
    env: options.environment,
    stdio: "inherit"
  });
  let launchError;
  child.once("error", (error) => {
    launchError = error;
  });
  const closed = new Promise((resolve) => {
    child.once("close", (status, signal) => resolve({ signal, status }));
  });
  const timeout = Symbol("timeout");
  const executionDeadline = deadline(options.timeoutMs, timeout);
  const first = await Promise.race([
    closed,
    executionDeadline.promise
  ]);
  executionDeadline.cancel();

  if (first !== timeout) {
    return { ...first, launchError, timedOut: false };
  }

  signalProcessGroup(child.pid, "SIGTERM");
  const terminationGraceMs = options.terminationGraceMs ?? DEFAULT_TERMINATION_GRACE_MS;
  if (await waitForProcessGroupExit(child.pid, terminationGraceMs)) {
    const afterTermination = await waitForLeaderClose(closed, terminationGraceMs, timeout);
    return { ...afterTermination, launchError, timedOut: true };
  }

  signalProcessGroup(child.pid, "SIGKILL");
  const killGraceMs = options.killGraceMs ?? DEFAULT_KILL_GRACE_MS;
  const groupExited = await waitForProcessGroupExit(child.pid, killGraceMs);
  const afterKill = await waitForLeaderClose(closed, killGraceMs, timeout);
  if (groupExited) {
    return { ...afterKill, launchError, timedOut: true };
  }

  child.unref();
  return { launchError, signal: "SIGKILL", status: null, timedOut: true };
}

async function waitForLeaderClose(closed, milliseconds, timeout) {
  const closeDeadline = deadline(milliseconds, timeout);
  const result = await Promise.race([closed, closeDeadline.promise]);
  closeDeadline.cancel();
  return result === timeout ? { signal: "SIGKILL", status: null } : result;
}

async function waitForProcessGroupExit(pid, milliseconds) {
  if (pid === undefined) return true;
  const expiresAt = Date.now() + milliseconds;
  while (processGroupExists(pid)) {
    if (Date.now() >= expiresAt) return false;
    await new Promise((resolve) => setTimeout(resolve, Math.min(20, expiresAt - Date.now())));
  }
  return true;
}

function processGroupExists(pid) {
  try {
    process.kill(-pid, 0);
    return true;
  } catch (error) {
    if (error?.code === "ESRCH") return false;
    if (error?.code === "EPERM") return true;
    throw error;
  }
}

function signalProcessGroup(pid, signal) {
  if (pid === undefined) return;
  try {
    process.kill(-pid, signal);
  } catch (error) {
    if (error?.code !== "ESRCH") throw error;
  }
}

function deadline(milliseconds, value) {
  let handle;
  const promise = new Promise((resolve) => {
    handle = setTimeout(() => resolve(value), milliseconds);
  });
  return {
    cancel() {
      clearTimeout(handle);
    },
    promise
  };
}
