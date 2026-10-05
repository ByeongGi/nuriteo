import fs from "node:fs";

function assert(condition: unknown, message: string): asserts condition {
  if (!condition) throw new Error(message);
}

const graphPath = "docs/implementation/self-hosted/tasks/v1-release-task-graph.json";
const graphDocumentPath = "docs/implementation/self-hosted/V1-TASK-GRAPH.md";
const statusPath = "docs/implementation/self-hosted/V1-STATUS.md";

const graph = JSON.parse(fs.readFileSync(graphPath, "utf8")) as {
  schemaVersion: number;
  prerequisite: string;
  nodes: Array<{
    id: string;
    stage: "BETA" | "RC" | "GA";
    lane: string;
    batch: string | null;
    dependsOn: string[];
  }>;
};
const graphDocument = fs.readFileSync(graphDocumentPath, "utf8");
const status = fs.readFileSync(statusPath, "utf8");

assert(graph.schemaVersion === 1, "unexpected v1 task graph schema version");
assert(graph.prerequisite === "GATE-004", "v1 graph must consume the Alpha aggregate gate");
assert(Array.isArray(graph.nodes), "v1 task graph nodes must be an array");
assert(graph.nodes.length === 90, `expected 90 v1 task nodes, got ${graph.nodes.length}`);

const stages = new Set(["BETA", "RC", "GA"]);
const lanes = new Set(Array.from({ length: 8 }, (_, index) => `L${index}`));
const batches = new Set(Array.from({ length: 27 }, (_, index) => `B${index + 21}`));
const nodesById = new Map<string, (typeof graph.nodes)[number]>();

for (const node of graph.nodes) {
  assert(/^[A-Z0-9]+-[0-9]{3}$/u.test(node.id), `invalid v1 task id: ${node.id}`);
  assert(!nodesById.has(node.id), `duplicate v1 task id: ${node.id}`);
  assert(stages.has(node.stage), `${node.id}: invalid stage ${node.stage}`);
  assert(lanes.has(node.lane), `${node.id}: invalid lane ${node.lane}`);
  assert(node.batch === null || batches.has(node.batch), `${node.id}: invalid batch ${node.batch}`);
  assert(Array.isArray(node.dependsOn), `${node.id}: dependsOn must be an array`);
  nodesById.set(node.id, node);
}

for (const node of graph.nodes) {
  const dependencies = new Set(node.dependsOn);
  assert(dependencies.size === node.dependsOn.length, `${node.id}: duplicate dependency`);
  assert(!dependencies.has(node.id), `${node.id}: self dependency`);
  for (const dependency of dependencies) {
    assert(nodesById.has(dependency), `${node.id}: unknown dependency ${dependency}`);
  }
}

const visiting = new Set<string>();
const visited = new Set<string>();
function visit(id: string): void {
  assert(!visiting.has(id), `v1 dependency cycle detected at ${id}`);
  if (visited.has(id)) return;
  visiting.add(id);
  for (const dependency of nodesById.get(id)?.dependsOn ?? []) visit(dependency);
  visiting.delete(id);
  visited.add(id);
}
for (const id of nodesById.keys()) visit(id);

const roots = graph.nodes.filter((node) => node.dependsOn.length === 0).map((node) => node.id);
assert(roots.length === 1 && roots[0] === "BETA-001", `unexpected v1 roots: ${roots.join(", ")}`);

const gateByStage = new Map([
  ["BETA", { gate: "GATE-005", previous: undefined }],
  ["RC", { gate: "GATE-006", previous: "GATE-005" }],
  ["GA", { gate: "GATE-007", previous: "GATE-006" }]
] as const);
for (const [stage, definition] of gateByStage) {
  const expected = graph.nodes
    .filter((node) => node.stage === stage && node.id !== definition.gate)
    .map((node) => node.id);
  if (definition.previous !== undefined) expected.push(definition.previous);
  expected.sort();
  const actual = [...(nodesById.get(definition.gate)?.dependsOn ?? [])].sort();
  assert(JSON.stringify(actual) === JSON.stringify(expected), `${definition.gate}: incomplete stage dependencies`);
}

for (const id of nodesById.keys()) {
  assert(graphDocument.includes(`\`${id}\``), `${id}: missing from V1-TASK-GRAPH.md`);
}
assert(status.includes("후속 DAG: 90개 작업"), "V1-STATUS.md must declare the 90-node graph");

const counts = Object.fromEntries(
  [...stages].map((stage) => [stage, graph.nodes.filter((node) => node.stage === stage).length])
);
console.log(`self-hosted v1 task graph ok (${graph.nodes.length} nodes, root ${roots[0]}, ${JSON.stringify(counts)})`);
