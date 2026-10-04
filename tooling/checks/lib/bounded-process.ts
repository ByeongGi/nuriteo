import { spawn } from "node:child_process";

const DEFAULT_TERMINATION_GRACE_MS = 5_000;
const DEFAULT_KILL_GRACE_MS = 2_000;

// cleanupFailed is independent of the leader result: callers must reject it even
// when the preserved leader status is zero and timedOut is false.
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
    const cleanup = await cleanupProcessGroup(
      child.pid,
      options.terminationGraceMs ?? DEFAULT_TERMINATION_GRACE_MS,
      options.killGraceMs ?? DEFAULT_KILL_GRACE_MS
    );
    return { ...first, ...cleanup, launchError, timedOut: false };
  }

  const terminationGraceMs = options.terminationGraceMs ?? DEFAULT_TERMINATION_GRACE_MS;
  const killGraceMs = options.killGraceMs ?? DEFAULT_KILL_GRACE_MS;
  const cleanup = await cleanupProcessGroup(child.pid, terminationGraceMs, killGraceMs);
  const afterCleanup = await readSettledLeaderResult(closed);

  if (cleanup.cleanupFailed) child.unref();
  return { ...afterCleanup, ...cleanup, launchError, timedOut: true };
}

async function cleanupProcessGroup(pid, terminationGraceMs, killGraceMs) {
  if (pid === undefined || !processGroupExists(pid)) {
    return { cleanupEscalated: false, cleanupFailed: false };
  }

  signalProcessGroup(pid, "SIGTERM");
  if (await waitForProcessGroupExit(pid, terminationGraceMs)) {
    return { cleanupEscalated: false, cleanupFailed: false };
  }

  signalProcessGroup(pid, "SIGKILL");
  const groupExited = await waitForProcessGroupExit(pid, killGraceMs);
  return { cleanupEscalated: true, cleanupFailed: !groupExited };
}

async function readSettledLeaderResult(closed) {
  const pending = Symbol("pending");
  const result = await Promise.race([closed, Promise.resolve(pending)]);
  return result === pending ? { signal: null, status: null } : result;
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
