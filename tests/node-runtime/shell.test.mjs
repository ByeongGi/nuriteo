import assert from "node:assert/strict";

import { createShellRuntime, createTerminalSession, ShellSyntaxError } from "../../packages/node-runtime/src/index.ts";

const shell = createShellRuntime({
  cwd: "/workspace/my app",
  env: {
    PATH: "/workspace/my app/node_modules/.bin:/bin",
    NAME: "cargo"
  },
  files: {
    "/workspace/my app/node_modules/.bin/hello": "#!/usr/bin/env node\nconsole.log('from-bin')\n"
  },
  commands: {
    echo({ argv }) {
      return { stdout: `${argv.slice(1).join(" ")}\n`, stderr: "", exitCode: 0 };
    },
    cat({ stdin }) {
      return { stdout: stdin, stderr: "", exitCode: 0 };
    },
    envcheck({ env, cwd }) {
      return { stdout: `${env.NAME}:${cwd}\n`, stderr: "", exitCode: 0 };
    },
    false() {
      return { stdout: "", stderr: "nope\n", exitCode: 2 };
    },
    "/bin/upper"({ stdin }) {
      return { stdout: stdin.toUpperCase(), stderr: "", exitCode: 0 };
    }
  }
});

assert.deepEqual(
  await shell.run("echo 'hello world' | upper"),
  {
    stdout: "HELLO WORLD\n",
    stderr: "",
    exitCode: 0,
    files: {
      "/workspace/my app/node_modules/.bin/hello": "#!/usr/bin/env node\nconsole.log('from-bin')\n"
    }
  }
);

const redirected = await shell.run("echo ok > 'out file.txt'");
assert.equal(redirected.exitCode, 0);
assert.equal(redirected.stdout, "");
assert.equal(redirected.files["/workspace/my app/out file.txt"], "ok\n");

const env = await shell.run("envcheck");
assert.equal(env.stdout, "cargo:/workspace/my app\n");

const failed = await shell.run("false && echo skipped");
assert.equal(failed.exitCode, 2);
assert.equal(failed.stdout, "");
assert.equal(failed.stderr, "nope\n");

const sh = await shell.run("sh -c \"echo nested\"");
assert.equal(sh.stdout, "nested\n");

const outputChunks = [];
const pipedOutput = await shell.run("echo 'stream me' | upper", {
  onOutput(chunk) {
    outputChunks.push(chunk);
  }
});
assert.equal(pipedOutput.stdout, "STREAM ME\n");
assert.deepEqual(outputChunks, [{ stream: "stdout", data: "STREAM ME\n" }]);

const nestedOutputChunks = [];
const nestedOutput = await shell.run("sh -c \"echo nested-output\"", {
  onOutput(chunk) {
    nestedOutputChunks.push(chunk);
  }
});
assert.equal(nestedOutput.stdout, "nested-output\n");
assert.deepEqual(nestedOutputChunks, [{ stream: "stdout", data: "nested-output\n" }]);

const bin = await shell.run("hello");
assert.equal(bin.stdout, "from-bin\n");

await assert.rejects(() => shell.run("echo ok || echo nope"), ShellSyntaxError);

const chunks = [];
const terminal = createTerminalSession({
  now: (() => {
    let tick = 1000;
    return () => {
      tick += 10;
      return tick;
    };
  })(),
  onChunk(chunk) {
    chunks.push(chunk);
  },
  commands: {
    echo({ argv }) {
      return { stdout: `${argv.slice(1).join(" ")}\n`, stderr: "", exitCode: 0 };
    },
    wait({ signal }) {
      return new Promise((resolve) => {
        signal?.addEventListener(
          "abort",
          () => resolve({ stdout: "", stderr: "stopped\n", exitCode: 130 }),
          { once: true }
        );
      });
    }
  }
});

const terminalRun = await terminal.run("echo terminal");
assert.equal(terminalRun.stdout, "terminal\n");
assert.equal(terminalRun.entry.command, "echo terminal");
assert.equal(terminalRun.entry.status, "completed");
assert.equal(terminalRun.entry.exitCode, 0);
assert.deepEqual(terminal.history(), ["echo terminal"]);
assert.equal(terminal.transcript()[0].stdout, "terminal\n");
assert.deepEqual(chunks, [{ entryId: 1, stream: "stdout", data: "terminal\n" }]);

const pendingRun = terminal.run("wait");
assert.equal(terminal.activeEntry?.command, "wait");
assert.equal(terminal.cancel(), true);
const cancelledRun = await pendingRun;
assert.equal(cancelledRun.exitCode, 130);
assert.equal(cancelledRun.entry.status, "cancelled");
assert.equal(terminal.activeEntry, null);

const pendingRestartRun = terminal.run("wait");
assert.equal(terminal.activeEntry?.command, "wait");
terminal.restart();
const restartedRun = await pendingRestartRun;
assert.equal(restartedRun.entry.status, "cancelled");
const afterRestartRun = await terminal.run("echo after-restart");
assert.equal(afterRestartRun.stdout, "after-restart\n");
assert.equal(afterRestartRun.entry.status, "completed");

console.log("node shell test ok");
