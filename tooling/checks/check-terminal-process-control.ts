import fs from "node:fs";

function assert(condition, message) {
  if (!condition) throw new Error(message);
}

const contract = JSON.parse(fs.readFileSync("compat/terminal-process-control.json", "utf8"));
const document = fs.readFileSync("docs/productization/terminal-process-control.md", "utf8");

assert(contract.schemaVersion === 1, "unexpected terminal/process contract schema");
assert(contract.status === "supported", "terminal/process control is not supported");
for (const capability of [
  "isolatedSessions",
  "cwdAndEnvironment",
  "streamingStdio",
  "terminalResize",
  "longRunningProcess",
  "processListAndKill",
  "portListAndStop",
  "packageScriptArguments",
  "projectLocalBin"
]) {
  assert(contract.capabilities[capability] === "supported", `missing terminal capability: ${capability}`);
  assert(document.includes(capability), `terminal documentation missing capability: ${capability}`);
}
for (const signal of ["SIGINT", "SIGTERM", "SIGKILL"]) {
  assert(contract.capabilities.signals.includes(signal), `missing signal contract: ${signal}`);
  assert(document.includes(signal), `terminal documentation missing signal: ${signal}`);
}
assert(contract.shellGrammar.diagnosticCode === "ERR_CARGO_CONTAINER_UNSUPPORTED_SHELL_SYNTAX", "shell diagnostic code changed");
for (const test of contract.tests) assert(fs.existsSync(test), `terminal test missing: ${test}`);

console.log("terminal/process control contract ok");
