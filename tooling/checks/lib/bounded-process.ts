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
  const terminationDeadline = deadline(
    options.terminationGraceMs ?? DEFAULT_TERMINATION_GRACE_MS,
    timeout
  );
  const afterTermination = await Promise.race([
    closed,
    terminationDeadline.promise
  ]);
  terminationDeadline.cancel();
  if (afterTermination !== timeout) {
    return { ...afterTermination, launchError, timedOut: true };
  }

  signalProcessGroup(child.pid, "SIGKILL");
  const killDeadline = deadline(options.killGraceMs ?? DEFAULT_KILL_GRACE_MS, timeout);
  const afterKill = await Promise.race([
    closed,
    killDeadline.promise
  ]);
  killDeadline.cancel();
  if (afterKill !== timeout) {
    return { ...afterKill, launchError, timedOut: true };
  }

  child.unref();
  return { launchError, signal: "SIGKILL", status: null, timedOut: true };
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
