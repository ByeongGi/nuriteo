import assert from "node:assert/strict";

import { createShellRuntime, createTerminalSession, ShellSyntaxError } from "../../node-runtime/src/index.ts";

const shell = createShellRuntime({
  cwd: "/workspace/my app",
  env: {
    PATH: "/workspace/my app/node_modules/.bin:/bin",
    NAME: "nuriteo"
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
assert.equal(env.stdout, "nuriteo:/workspace/my app\n");

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
for (const command of [
  "echo ok; echo injected",
  "echo ok & echo background",
  "echo ok >> stolen",
  "echo ok < secret",
  "echo `pwd`"
]) {
  await assert.rejects(() => shell.run(command), ShellSyntaxError);
}
await assert.rejects(
  () => shell.run("echo $(pwd)"),
  (error) => error instanceof ShellSyntaxError && error.code === "ERR_NURITEO_UNSUPPORTED_SHELL_SYNTAX" && /command substitution/.test(error.message)
);
assert.equal((await shell.run("echo '$() & ; ||'" )).stdout, "$() & ; ||\n");
assert.equal((await shell.run("echo 'value;not-an-operator'" )).stdout, "value;not-an-operator\n");

await shell.run("cd packages/../src");
await shell.run("export MODE=development");
assert.equal(shell.cwd, "/workspace/my app/src");
assert.equal(shell.env.MODE, "development");

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
    },
    streamonly({ output }) {
      output?.({ stream: "stdout", data: "first\n" });
      output?.({ stream: "stderr", data: "second\n" });
      return { stdout: "", stderr: "", exitCode: 0 };
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

const streamOnlyRun = await terminal.run("streamonly");
assert.equal(streamOnlyRun.entry.stdout, "first\n");
assert.equal(streamOnlyRun.entry.stderr, "second\n");

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

const controls = [];
const interactive = createTerminalSession({
  cwd: "/workspace/one",
  env: { SESSION: "one" },
  commands: {
    interactive({ terminal, signal }) {
      return new Promise((resolve) => {
        const stopInput = terminal.onInput((data) => controls.push(["input", data]));
        const stopResize = terminal.onResize((size) => controls.push(["resize", size]));
        signal.addEventListener("abort", () => {
          controls.push(["signal", signal.reason]);
          stopInput();
          stopResize();
          resolve({ stdout: "", stderr: "interrupted\n", exitCode: 130 });
        }, { once: true });
      });
    }
  }
});
const interactiveRun = interactive.run("interactive");
assert.equal(interactive.write("hello\n"), true);
assert.deepEqual(interactive.resize(132, 40), { cols: 132, rows: 40 });
assert.equal(interactive.signal("SIGINT"), true);
await interactiveRun;
assert.deepEqual(controls, [
  ["input", "hello\n"],
  ["resize", { cols: 132, rows: 40 }],
  ["signal", "SIGINT"]
]);
assert.deepEqual(interactive.snapshot().size, { cols: 132, rows: 40 });

const terminated = createTerminalSession({
  commands: {
    wait({ signal }) {
      return new Promise((resolve) => signal.addEventListener("abort", () => resolve({ stdout: "", stderr: "", exitCode: 0 }), { once: true }));
    }
  }
});
const terminatedRun = terminated.run("wait");
terminated.signal("SIGTERM");
assert.equal((await terminatedRun).exitCode, 143);

const isolated = createTerminalSession({ cwd: "/workspace/two", env: { SESSION: "two" } });
await isolated.run("cd child");
await isolated.run("export FLAG=yes");
assert.equal(isolated.snapshot().cwd, "/workspace/two/child");
assert.equal(isolated.snapshot().env.FLAG, "yes");
assert.equal(interactive.snapshot().cwd, "/workspace/one");
assert.equal(interactive.snapshot().env.FLAG, undefined);

const bounded = createTerminalSession({
  maxInputChunkBytes: 4,
  maxOutputBytes: 8,
  commands: {
    flood({ terminal, signal }) {
      terminal?.onInput(() => undefined);
      return new Promise((resolve) => signal?.addEventListener("abort", () => resolve({
        stdout: "1234567890",
        stderr: "",
        exitCode: 130
      }), { once: true }));
    }
  }
});
const boundedRun = bounded.run("flood");
assert.equal(bounded.write("1234"), true);
assert.equal(bounded.write("12345"), false);
bounded.cancel();
const boundedResult = await boundedRun;
assert.equal(new TextEncoder().encode(boundedResult.stdout).byteLength, 8);
assert.equal(boundedResult.outputTruncatedBytes, 9);
assert.equal(boundedResult.entry.outputTruncatedBytes, 9);

console.log("node shell test ok");
