import { fileURLToPath } from "node:url";
import path from "node:path";

import { runBoundedProcess } from "./lib/bounded-process.ts";

const repositoryRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "../..");
const node = process.execPath;
const tsc = path.join(repositoryRoot, "node_modules/typescript/bin/tsc");
const next = path.join(repositoryRoot, "node_modules/next/dist/bin/next");
const nodeVersion = process.versions.node.split(".").map((part) => Number.parseInt(part, 10));
const [nodeMajor, nodeMinor, nodePatch] = nodeVersion;
const diffBase = process.env.NURITEO_G2_DIFF_BASE ?? "main";

if (
  nodeMajor !== 22 ||
  nodeMinor === undefined ||
  nodePatch === undefined ||
  nodeMinor < 23
) {
  console.error(`[g2] FAIL runtime: Node >=22.23.0 <23 is required, received ${process.versions.node}`);
  process.exit(1);
}

const commonEnvironment = {
  ...process.env,
  CARGO_TARGET_DIR:
    process.env.CARGO_TARGET_DIR ?? "/private/tmp/nuriteo-gate002-target",
  CI: "true",
  NEXT_TELEMETRY_DISABLED: "1",
  NURITEO_INTERNAL_API_URL: "http://127.0.0.1:8080"
};

const phases = [
  nodePhase("bounded process-group runner regression", "tooling/checks/test/bounded-process.test.ts"),
  commandPhase(
    "ACTUAL CORE: bootstrap-to-collaboration with custom-CA PostgreSQL and HTTPS RustFS",
    "./crates/nuriteo-server/tests/fixtures/gate-collaboration/run.sh",
    [],
    900_000
  ),
  commandPhase("Rust format", "cargo", ["fmt", "--all", "--", "--check"], 60_000),
  commandPhase(
    "Rust Clippy",
    "cargo",
    ["clippy", "--workspace", "--all-targets", "--all-features", "--offline", "--", "-D", "warnings"],
    600_000
  ),
  commandPhase(
    "Rust workspace tests",
    "cargo",
    ["test", "--workspace", "--all-features", "--offline"],
    600_000
  ),
  commandPhase("API client contracts", node, ["test/run.ts"], 120_000, "packages/api-client"),
  commandPhase("API client typecheck", node, [tsc, "-p", "tsconfig.json", "--noEmit"], 120_000, "packages/api-client"),
  commandPhase(
    "Web exact BFF and collaboration contracts",
    node,
    ["--conditions=react-server", "test/run.ts"],
    120_000,
    "apps/web"
  ),
  commandPhase("Web typecheck", node, [tsc, "-p", "tsconfig.json", "--noEmit"], 120_000, "apps/web"),
  commandPhase("Web production build", node, [next, "build"], 300_000, "apps/web"),
  commandPhase(
    "STATEFUL MOCK WEB: standalone Next.js two-context collaboration journey",
    node,
    ["test/collaboration-browser.test.ts"],
    300_000,
    "apps/web"
  ),
  commandPhase("Web server/client bundle boundary", node, ["test/bundle-boundary.test.ts"], 60_000, "apps/web"),
  nodePhase("workspace consistency", "tooling/checks/check-workspace.ts"),
  nodePhase("self-hosted task graph", "tooling/checks/check-self-hosted-task-graph.ts"),
  commandPhase("committed diff", "git", ["log", "--check", "--oneline", `${diffBase}..HEAD`], 60_000),
  nodePhase("working-tree diff", "tooling/checks/check-working-tree-diff.ts")
];

console.log("[g2] Evidence classes are intentionally separate:");
console.log("[g2] - ACTUAL CORE runs the production Rust binary with live PostgreSQL and RustFS.");
console.log("[g2] - STATEFUL MOCK WEB runs real Next.js/BFF/Chromium against a bounded mock Core.");

for (const phase of phases) {
  process.stdout.write(`\n[g2] ${phase.name}\n`);
  const result = await runBoundedProcess({
    arguments: phase.arguments,
    command: phase.command,
    environment: commonEnvironment,
    timeoutMs: phase.timeoutMs,
    workingDirectory: path.join(repositoryRoot, phase.workingDirectory)
  });
  if (result.launchError) {
    console.error(`[g2] FAIL ${phase.name}: could not start`);
    process.exit(1);
  }
  if (result.cleanupFailed) {
    console.error(`[g2] FAIL ${phase.name}: process group survived bounded TERM/KILL cleanup`);
    process.exit(1);
  }
  if (result.timedOut) {
    console.error(`[g2] FAIL ${phase.name}: timed out and terminated its process group`);
    process.exit(1);
  }
  if (result.status !== 0) {
    console.error(`[g2] FAIL ${phase.name}: exit ${result.status ?? "signal"}`);
    process.exit(1);
  }
  console.log(`[g2] PASS ${phase.name}`);
}

console.log(`\nself-hosted G2 ok (${phases.length} bounded phases)`);

function nodePhase(name, script) {
  return commandPhase(name, node, [script], 60_000);
}

function commandPhase(name, command, arguments_, timeoutMs, workingDirectory = ".") {
  return { name, command, arguments: arguments_, timeoutMs, workingDirectory };
}
