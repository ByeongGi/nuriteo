import assert from "node:assert/strict";

import {
  createPreviewShellSession,
  createPreviewWorkflowController
} from "../../../packages/preview-service/src/index.ts";

const controller = createPreviewWorkflowController();
await controller.runShellCommand("cd projects/one", "terminal-one");
await controller.runShellCommand("export COLOR=blue", "terminal-one");
const first = await controller.runShellCommand("pwd", "terminal-one");
const second = await controller.runShellCommand("pwd", "terminal-two");
const empty = await controller.runShellCommand("   ", "terminal-two");
assert.equal(first.entry.cwd, "/workspace/app/projects/one");
assert.equal(first.stdout, "/workspace/app/projects/one\n");
assert.equal(second.entry.cwd, "/workspace/app");
assert.equal(empty.entry.cwd, "/workspace/app");
assert.equal(empty.exitCode, 0);

const chunks = [];
await controller.runShellCommand("echo streamed", "terminal-one", (chunk) => chunks.push(chunk));
assert.deepEqual(chunks, [{ stream: "stdout", data: "streamed\n" }]);
assert.equal(controller.closeShell("terminal-one"), true);
assert.equal(controller.closeShell("terminal-one"), false);
assert.deepEqual(controller.listShellProcesses(), []);
assert.equal(controller.closeShell("terminal-two"), true);

const calls = [];
const shell = createPreviewShellSession({
  getCwd: () => "/workspace/app",
  getProject: () => null,
  install: async () => ({ stdout: "", stderr: "", exitCode: 0 }),
  runDev: async (args = []) => {
    calls.push(["dev", args]);
    return { stdout: "dev\n", stderr: "", exitCode: 0 };
  },
  runBuild: async (args = []) => {
    calls.push(["build", args]);
    return { stdout: "build\n", stderr: "", exitCode: 0 };
  },
  restartDev: async (args = []) => {
    calls.push(["restart", args]);
    return { stdout: "restart\n", stderr: "", exitCode: 0 };
  }
});
await shell.run("pnpm run dev -- --host 0.0.0.0");
await shell.run("npm run build -- --watch");
assert.deepEqual(calls, [
  ["dev", ["--", "--host", "0.0.0.0"]],
  ["build", ["--", "--watch"]]
]);

console.log("preview-service terminal session control ok");
