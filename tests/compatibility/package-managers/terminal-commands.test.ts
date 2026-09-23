import assert from "node:assert/strict";

import {
  createPackageManagerTerminalCommands,
  createTerminalSession
} from "../../../packages/node-runtime/src/index.ts";

const calls = [];
const results = [];
const npm = createFakeRunner("npm", calls);
const pnpm = createFakeRunner("pnpm", calls);
const yarn = createFakeRunner("yarn", calls);
const chunks = [];
const terminal = createTerminalSession({
  cwd: "/workspace/app",
  commands: createPackageManagerTerminalCommands({
    cwd: "/workspace/app",
    npm,
    pnpm,
    yarn,
    onResult(result) {
      results.push(result);
    }
  }),
  onChunk(chunk) {
    chunks.push(chunk);
  }
});

const install = await terminal.run("npm install --ignore-scripts");
assert.equal(install.exitCode, 0);
assert.equal(install.stdout, "npm install: ok\n");
assert.deepEqual(calls[0], {
  manager: "npm",
  method: "install",
  cwd: "/workspace/app",
  args: ["--ignore-scripts"]
});
assert.equal(results[0].result.commandKind, "install");
assert.equal(chunks[0].data, "npm install: ok\n");
assert.equal(chunks.filter((chunk) => chunk.data === "npm install: ok\n").length, 1);

const build = await terminal.run("pnpm run build -- --watch");
assert.equal(build.exitCode, 0);
assert.equal(build.stdout, "pnpm run build: -- --watch\n");
assert.deepEqual(calls[1], {
  manager: "pnpm",
  method: "runScript",
  cwd: "/workspace/app",
  script: "build",
  args: ["--", "--watch"]
});

const exec = await terminal.run("npm exec -- fixture-hello --flag");
assert.equal(exec.stdout, "npm exec fixture-hello: --flag\n");
assert.deepEqual(calls[2], {
  manager: "npm",
  method: "exec",
  cwd: "/workspace/app",
  command: "fixture-hello",
  args: ["--flag"]
});

const missingExec = await terminal.run("pnpm exec");
assert.equal(missingExec.exitCode, 1);
assert.match(missingExec.stderr, /missing exec command/);
assert.equal(chunks.filter((chunk) => chunk.data.includes("missing exec command")).length, 1);

const yarnInstall = await terminal.run("yarn");
assert.equal(yarnInstall.exitCode, 0);
assert.deepEqual(calls[3], {
  manager: "yarn",
  method: "install",
  cwd: "/workspace/app",
  args: []
});

const yarnShorthand = await terminal.run("yarn build --watch");
assert.equal(yarnShorthand.exitCode, 0);
assert.deepEqual(calls[4], {
  manager: "yarn",
  method: "runScript",
  cwd: "/workspace/app",
  script: "build",
  args: ["--watch"]
});

assert.deepEqual(terminal.history(), [
  "npm install --ignore-scripts",
  "pnpm run build -- --watch",
  "npm exec -- fixture-hello --flag",
  "pnpm exec",
  "yarn",
  "yarn build --watch"
]);

console.log("package manager terminal commands test ok");

function createFakeRunner(manager, calls) {
  return {
    version(cwd) {
      calls.push({ manager, method: "version", cwd, args: [] });
      return result(manager, cwd, ["--version"], "version", `${manager}-version\n`, 0);
    },
    install(cwd, args = []) {
      calls.push({ manager, method: "install", cwd, args });
      return result(manager, cwd, ["install", ...args], "install", `${manager} install: ok\n`, 0);
    },
    runScript(cwd, script, args = []) {
      calls.push({ manager, method: "runScript", cwd, script, args });
      return result(manager, cwd, ["run", script, ...args], "run-script", `${manager} run ${script}: ${args.join(" ")}\n`, 0);
    },
    exec(cwd, command, args = []) {
      calls.push({ manager, method: "exec", cwd, command, args });
      return result(manager, cwd, ["exec", command, ...args], "exec", `${manager} exec ${command}: ${args.join(" ")}\n`, 0);
    },
    ci(cwd, args = []) {
      calls.push({ manager, method: "ci", cwd, args });
      return result(manager, cwd, ["ci", ...args], "ci", `${manager} ci: ok\n`, 0);
    }
  };
}

function result(manager, cwd, args, commandKind, stdout, exitCode) {
  return {
    stdout,
    stderr: "",
    exitCode,
    entry: manager,
    args,
    cwd,
    runtime: "browser-guest-node-runtime",
    commandKind
  };
}
