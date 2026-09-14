import assert from "node:assert/strict";

import { createShellRuntime, ShellSyntaxError } from "../../packages/node-runtime/src/index.ts";

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

const bin = await shell.run("hello");
assert.equal(bin.stdout, "from-bin\n");

await assert.rejects(() => shell.run("echo ok || echo nope"), ShellSyntaxError);

console.log("node shell test ok");
