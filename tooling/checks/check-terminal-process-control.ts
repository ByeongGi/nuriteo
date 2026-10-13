import fs from "node:fs";

function assert(condition, message) {
  if (!condition) throw new Error(message);
}

const contract = JSON.parse(fs.readFileSync("compat/terminal-process-control.json", "utf8"));
const document = fs.readFileSync("docs/productization/terminal-process-control.md", "utf8");

assert(contract.schemaVersion === 4, "unexpected terminal/process contract schema");
assert(contract.status === "partial", "terminal/process status must remain partial while kernel PTY semantics are unsupported");
assert(contract.runtimeModel === "browser-worker-rust-wasm-virtual-posix", "runtime model must be explicit");
assert(contract.posixPty?.status === "partial", "virtual and host POSIX PTY scope must remain distinct");
assert(contract.posixPty?.virtual?.status === "supported", "Rust virtual POSIX PTY must be documented");
assert(contract.posixPty?.hostKernel?.status === "unsupported", "host kernel POSIX PTY must not be claimed in a browser runtime");
assert(contract.security?.executionModel === "parsed-argv-allowlist", "command execution must use parsed argv and an allowlist");
assert(contract.security?.nativeShell === false, "native shell execution must remain disabled");

const requiredCapabilities = [
  "isolatedSessions",
  "cwdAndEnvironment",
  "streamingStdio",
  "ptyLineDiscipline",
  "terminalResize",
  "foregroundProcess",
  "exitStatus",
  "lifecycleRecovery",
  "signals",
  "processListAndKill",
  "portListAndStop",
  "packageScriptArguments",
  "projectLocalBin",
  "boundedBackpressure",
  "commandSecurity"
];
for (const capability of requiredCapabilities) {
  const entry = contract.capabilities[capability];
  assert(entry && ["supported", "partial", "unsupported"].includes(entry.status), `invalid terminal capability: ${capability}`);
  assert(typeof entry.semantics === "string" && entry.semantics.length > 20, `missing terminal semantics: ${capability}`);
  assert(document.includes(`\`${capability}\``), `terminal documentation missing capability: ${capability}`);
}
for (const signal of ["SIGINT", "SIGTERM", "SIGKILL", "SIGWINCH"]) {
  assert(contract.capabilities.signals.values.includes(signal), `missing signal contract: ${signal}`);
  assert(document.includes(signal), `terminal documentation missing signal: ${signal}`);
}
for (const [name, value] of Object.entries(contract.limits)) {
  assert(Number.isSafeInteger(value) && value > 0, `invalid terminal/process limit: ${name}`);
}
assert(contract.shellGrammar.diagnosticCode === "ERR_NURITEO_UNSUPPORTED_SHELL_SYNTAX", "shell diagnostic code changed");
assert(contract.posixPty.virtual.features.length >= 8, "virtual POSIX PTY evidence is incomplete");
assert(contract.posixPty.hostKernel.unsupported.length >= 5, "host POSIX PTY limitations are incomplete");
assert(document.includes("HostProcessTable/createHostProcessShellCommand가 preview production shell의 제한된 Worker command에 연결된다"), "production Worker integration must stay documented");

const tests = new Set(contract.tests);
assert(tests.size === contract.tests.length, "duplicate terminal/process evidence tests");
for (const test of tests) assert(fs.existsSync(test), `terminal test missing: ${test}`);
for (const command of contract.reproductionCommands) assert(typeof command === "string" && command.length > 5, "invalid reproduction command");

const nodeRunner = fs.readFileSync("packages/node-runtime/test/run.ts", "utf8");
for (const name of ["shell.test.ts", "scheduler.test.ts", "secondary-builtins.test.ts"]) {
  assert(nodeRunner.includes(name), `node runtime suite does not include ${name}`);
}
const hostRunner = fs.readFileSync("packages/browser-host/test/run.ts", "utf8");
for (const name of ["process-lifecycle.test.ts", "process-terminal-command.test.ts", "process-worker-runtime.test.ts"]) {
  assert(hostRunner.includes(name), `browser host suite does not include ${name}`);
}
const runtimeRunner = fs.readFileSync("packages/workspace-runtime/test/run.ts", "utf8");
assert(runtimeRunner.includes("terminal-session-control.test.ts"), "workspace runtime suite no longer includes terminal session evidence");

const lifecycle = fs.readFileSync("packages/browser-host/test/process-lifecycle.test.ts", "utf8");
assert(lifecycle.includes("outputDroppedBytes"), "bounded output evidence missing");
assert(lifecycle.includes("stdin-ack"), "stdin credit evidence missing");
assert(lifecycle.includes("generation + 1"), "stale generation evidence missing");
const shell = fs.readFileSync("packages/node-runtime/test/shell.test.ts", "utf8");
assert(shell.includes("outputTruncatedBytes"), "bounded shell transcript evidence missing");
assert(shell.includes("ERR_NURITEO_UNSUPPORTED_SHELL_SYNTAX"), "shell injection diagnostic evidence missing");
const workerRuntime = fs.readFileSync("packages/browser-host/src/process/worker-runtime.ts", "utf8");
assert(workerRuntime.includes("writeTerminalInput"), "PTY line discipline implementation missing");
assert(workerRuntime.includes("createVirtualPty"), "system WASM PTY integration missing");
const virtualPty = fs.readFileSync("packages/browser-host/src/process/virtual-pty.ts", "utf8");
for (const operation of ["pty.open", "pty.attach", "pty.read", "pty.write", "pty.ioctl", "pty.poll", "pty.dispatchEvent"]) {
  assert(virtualPty.includes(operation), `system WASM PTY operation missing: ${operation}`);
}
const wasi = fs.readFileSync("packages/node-runtime/src/builtins/wasi.ts", "utf8");
assert(wasi.includes("_fdRead") && wasi.includes("_fdWrite") && wasi.includes("WasiStdio"), "WASI terminal stdio bridge missing");
const processWorker = fs.readFileSync("workers/process-worker.ts", "utf8");
assert(processWorker.includes("/runtime/system_wasm.wasm"), "production process Worker does not load system WASM");
assert(fs.existsSync("packages/workspace-runtime/assets/runtime/system_wasm.wasm"), "preview system WASM asset missing");

console.log("terminal/process control contract ok (Rust/WASM virtual POSIX supported; host kernel PTY unsupported)");
