import assert from "node:assert/strict";

import {
  createPreviewShellSession,
  createPreviewWorkflowController
} from "../../../packages/workspace-runtime/src/index.ts";
import { createMemoryOpfs, createProjectWorkspaceStore } from "../../../packages/browser-host/src/index.ts";
import { readWorkspacePackageScript } from "../../../packages/workspace-runtime/src/package-script.ts";

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
assert.equal(controller.closeShell("terminal-one"), true);
const restarted = await controller.runShellCommand("pwd", "terminal-one");
assert.equal(restarted.stdout, "/workspace/app\n");

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
  runScript: async (name, args = []) => {
    calls.push([name, args]);
    return { stdout: `${name}\n`, stderr: "", exitCode: 0 };
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

const project = createProjectWorkspaceStore({
  projectId: "terminal-project",
  root: "/workspace/app",
  opfs: createMemoryOpfs()
});
project.writeText("src/App.tsx", "export default function App() {\n  return <main>Hello</main>;\n}\n");
project.writeText(".env", "MODE=development\n");
const projectShell = createPreviewShellSession({
  getCwd: () => project.root,
  getProject: () => project,
  install: async () => ({ stdout: "", stderr: "", exitCode: 0 }),
  runScript: async () => ({ stdout: "", stderr: "", exitCode: 0 }),
  restartDev: async () => ({ stdout: "", stderr: "", exitCode: 0 })
});
await projectShell.run("cd src");
assert.equal((await projectShell.run("pwd")).stdout, "/workspace/app/src\n");
assert.equal((await projectShell.run("ls -la")).stdout, "App.tsx\n");
assert.equal((await projectShell.run("grep -n return App.tsx")).stdout, "2:  return <main>Hello</main>;\n");
assert.equal((await projectShell.run("cat App.tsx | grep Hello")).stdout, "  return <main>Hello</main>;\n");
assert.equal((await projectShell.run("find . -name '*.tsx'")).stdout, "./App.tsx\n");
assert.equal((await projectShell.run("cp App.tsx App.copy.tsx")).exitCode, 0);
assert.equal(project.readText("src/App.copy.tsx"), project.readText("src/App.tsx"));
assert.equal((await projectShell.run("printf 'created\\n' > generated.txt")).exitCode, 0);
assert.equal(project.readText("src/generated.txt"), "created\n");
assert.equal((await projectShell.run("ls ../../")).exitCode, 1);
assert.equal((await projectShell.run("cd ../../")).exitCode, 1);
assert.equal((await projectShell.run("pwd")).stdout, "/workspace/app/src\n");

const scriptController = createPreviewWorkflowController();
scriptController.loadViteReactTemplate();
const scriptSnapshot = scriptController.getSnapshot();
const packageJson = JSON.parse(scriptSnapshot.project!.readText("package.json"));
packageJson.scripts.check = "node scripts/check.cjs";
packageJson.scripts.chain = "node scripts/pre.cjs && node scripts/post.cjs";
packageJson.scripts.pipe = "node scripts/emit.cjs | node scripts/upper.cjs > piped.txt";
packageJson.scripts.serve = "vite --host 0.0.0.0";
packageJson.scripts.bundle = "vite build";
scriptController.saveTextFile("package.json", `${JSON.stringify(packageJson, null, 2)}\n`);
scriptController.createTextFile(
  "scripts/check.cjs",
  "const fs = require('node:fs');\nfs.writeFileSync('generated.txt', process.argv[2]);\nconsole.log('script:' + process.argv[2]);\n"
);
scriptController.createTextFile(
  "scripts/pre.cjs",
  "const fs = require('node:fs');\nfs.writeFileSync('chain.txt', 'pre');\nconsole.log('pre');\n"
);
scriptController.createTextFile(
  "scripts/post.cjs",
  "const fs = require('node:fs');\nfs.appendFileSync('chain.txt', ':' + process.argv[2]);\nconsole.log('post:' + process.argv[2]);\n"
);
scriptController.createTextFile("scripts/emit.cjs", "process.stdout.write('pipeline');\n");
scriptController.createTextFile(
  "scripts/upper.cjs",
  "let value = '';\nprocess.stdin.on('data', (chunk) => { value += chunk; });\nprocess.stdin.on('end', () => process.stdout.write(value.toUpperCase()));\n"
);
assert.equal((await scriptController.runShellCommand("pnpm install", "script-terminal")).exitCode, 0);
const scriptResult = await scriptController.runShellCommand("pnpm run check -- alpha", "script-terminal");
assert.equal(scriptResult.exitCode, 0, scriptResult.stderr);
assert.equal(scriptResult.stdout, "script:alpha\n");
assert.equal(scriptController.getSnapshot().project!.readText("generated.txt"), "alpha");
const redirectedFile = await scriptController.runShellCommand(
  "printf 'body { color: red; }\\n' > src/terminal-preview.css",
  "script-terminal"
);
assert.equal(redirectedFile.exitCode, 0, redirectedFile.stderr);
assert.equal(
  scriptController.getSnapshot().workflow!.workspace.readText("/workspace/app/src/terminal-preview.css"),
  "body { color: red; }\n"
);
assert.equal((await scriptController.runShellCommand("mv src/terminal-preview.css src/terminal-renamed.css", "script-terminal")).exitCode, 0);
assert.throws(
  () => scriptController.getSnapshot().workflow!.workspace.readText("/workspace/app/src/terminal-preview.css"),
  /No such file/u
);
assert.equal((await scriptController.runShellCommand("rm src/terminal-renamed.css", "script-terminal")).exitCode, 0);
assert.throws(
  () => scriptController.getSnapshot().workflow!.workspace.readText("/workspace/app/src/terminal-renamed.css"),
  /No such file/u
);
const chainResult = await scriptController.runShellCommand("pnpm run chain -- browser", "script-terminal");
assert.equal(chainResult.exitCode, 0, chainResult.stderr);
assert.equal(chainResult.stdout, "pre\npost:browser\n");
assert.equal(scriptController.getSnapshot().project!.readText("chain.txt"), "pre:browser");
const pipeResult = await scriptController.runShellCommand("npm run pipe", "script-terminal");
assert.equal(pipeResult.exitCode, 0, pipeResult.stderr);
assert.equal(pipeResult.stdout, "");
assert.equal(scriptController.getSnapshot().project!.readText("piped.txt"), "PIPELINE");
const buildAliasResult = await scriptController.runShellCommand("npm run bundle", "script-terminal");
assert.equal(buildAliasResult.exitCode, 0, buildAliasResult.stderr);
assert.match(buildAliasResult.stdout, /^build ok files=/);
assert.match(scriptController.getSnapshot().project!.readText("dist/index.html"), /<!doctype html>/i);
assert.equal(readWorkspacePackageScript(scriptController.getSnapshot().workflow!, "serve").kind, "dev");
scriptController.dispose();

const never = () => new Promise<{ stdout: string; stderr: string; exitCode: number }>(() => undefined);
const firstLong = createPreviewShellSession({
  getCwd: () => "/workspace/first",
  getProject: () => null,
  install: never,
  runScript: never,
  restartDev: never
});
const secondLong = createPreviewShellSession({
  getCwd: () => "/workspace/second",
  getProject: () => null,
  install: never,
  runScript: never,
  restartDev: never
});
await firstLong.run("export SESSION=first");
assert.equal(firstLong.session.snapshot().env.SESSION, "first");
assert.equal(secondLong.session.snapshot().env.SESSION, undefined);
firstLong.session.resize(132, 40);
secondLong.session.resize(90, 25);
assert.deepEqual(firstLong.session.snapshot().size, { cols: 132, rows: 40 });
assert.deepEqual(secondLong.session.snapshot().size, { cols: 90, rows: 25 });
const firstPending = firstLong.run("pnpm run dev");
const secondPending = secondLong.run("pnpm run dev");
assert.equal(firstLong.session.activeEntry?.cwd, "/workspace/first");
assert.equal(secondLong.session.activeEntry?.cwd, "/workspace/second");
assert.equal(firstLong.session.signal("SIGTERM"), true);
assert.equal(secondLong.session.signal("SIGKILL"), true);
assert.equal((await firstPending).exitCode, 143);
assert.equal((await secondPending).exitCode, 137);

console.log("preview-service terminal session control ok");
