import { spawnSync } from "node:child_process";
import { fileURLToPath } from "node:url";
import path from "node:path";

const repositoryRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "../..");
const node = process.execPath;
const tsc = path.join(repositoryRoot, "node_modules/typescript/bin/tsc");
const next = path.join(repositoryRoot, "node_modules/next/dist/bin/next");
const commonEnvironment = {
  ...process.env,
  CI: "true",
  NEXT_TELEMETRY_DISABLED: "1"
};

const phases = [
  nodePhase("baseline manifest", "tooling/checks/check-self-hosted-baseline.ts"),
  nodePhase("legacy production boundary", "tooling/checks/check-legacy-production-boundaries.ts"),
  nodePhase("workspace skeleton", "tooling/checks/check-workspace.ts"),
  nodePhase("self-hosted task graph", "tooling/checks/check-self-hosted-task-graph.ts"),
  commandPhase("Rust format", "cargo", ["fmt", "--all", "--", "--check"], 60_000),
  commandPhase(
    "Rust Clippy",
    "cargo",
    ["clippy", "--workspace", "--all-targets", "--all-features", "--offline", "--", "-D", "warnings"],
    300_000
  ),
  commandPhase(
    "Rust tests",
    "cargo",
    ["test", "--workspace", "--all-features", "--offline"],
    300_000
  ),
  ...["tsconfig.json", "tsconfig.test.json", "tsconfig.tools.json", "tsconfig.migrated.json"].map(
    (configuration) =>
      commandPhase(`TypeScript ${configuration}`, node, [tsc, "-p", configuration], 180_000)
  ),
  commandPhase(
    "legacy browser acceptance",
    node,
    ["tests/system/browser/run.ts"],
    300_000
  ),
  commandPhase(
    "Web request isolation",
    node,
    ["--conditions=react-server", "test/run.ts"],
    60_000,
    "apps/web"
  ),
  commandPhase("Web typecheck", node, [tsc, "-p", "tsconfig.json", "--noEmit"], 120_000, "apps/web"),
  commandPhase("Web production build", node, [next, "build"], 180_000, "apps/web"),
  commandPhase("Web bundle boundary", node, ["test/bundle-boundary.test.ts"], 60_000, "apps/web")
];

for (const phase of phases) {
  process.stdout.write(`\n[g0] ${phase.name}\n`);
  const result = spawnSync(phase.command, phase.arguments, {
    cwd: path.join(repositoryRoot, phase.workingDirectory),
    env: commonEnvironment,
    stdio: "inherit",
    timeout: phase.timeoutMs
  });

  if (result.error) {
    const reason = result.error.code === "ETIMEDOUT" ? "timed out" : "could not start";
    console.error(`[g0] FAIL ${phase.name}: ${reason}`);
    process.exit(1);
  }
  if (result.status !== 0) {
    console.error(`[g0] FAIL ${phase.name}: exit ${result.status ?? "signal"}`);
    process.exit(1);
  }
  console.log(`[g0] PASS ${phase.name}`);
}

console.log(`\nself-hosted G0 ok (${phases.length} bounded phases)`);

function nodePhase(name, script) {
  return commandPhase(name, node, [script], 60_000);
}

function commandPhase(
  name,
  command,
  arguments_,
  timeoutMs,
  workingDirectory = "."
) {
  return {
    name,
    command,
    arguments: arguments_,
    timeoutMs,
    workingDirectory
  };
}
