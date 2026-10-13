import fs from "node:fs";

function assert(condition, message) {
  if (!condition) throw new Error(message);
}

const graphPath = "docs/implementation/self-hosted/tasks/task-graph.json";
const blueprintPath = "docs/productization/self-hosted-implementation-blueprint.md";
const graphDocumentPath = "docs/implementation/self-hosted/TASK-GRAPH.md";
const statusPath = "docs/implementation/self-hosted/STATUS.md";

const graph = JSON.parse(fs.readFileSync(graphPath, "utf8"));
const blueprint = fs.readFileSync(blueprintPath, "utf8");
const graphDocument = fs.readFileSync(graphDocumentPath, "utf8");
const status = fs.readFileSync(statusPath, "utf8");

assert(graph.schemaVersion === 1, "unexpected task graph schema version");
assert(Array.isArray(graph.nodes), "task graph nodes must be an array");
assert(graph.nodes.length === 102, `expected 102 task nodes, got ${graph.nodes.length}`);

const allowedMilestones = new Set(["M0", "M1", "M2", "M3", "M4"]);
const allowedLanes = new Set(["L0", "L1", "L2", "L3", "L4", "L5", "L6", "L7"]);
const allowedBatches = new Set(Array.from({ length: 20 }, (_, index) => `B${String(index + 1).padStart(2, "0")}`));
const nodesById = new Map();

for (const node of graph.nodes) {
  assert(/^[A-Z0-9]+-[0-9]{3}$/.test(node.id), `invalid task id: ${node.id}`);
  assert(!nodesById.has(node.id), `duplicate task id: ${node.id}`);
  assert(allowedMilestones.has(node.milestone), `${node.id}: invalid milestone ${node.milestone}`);
  assert(allowedLanes.has(node.lane), `${node.id}: invalid lane ${node.lane}`);
  assert(node.batch === null || allowedBatches.has(node.batch), `${node.id}: invalid batch ${node.batch}`);
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

const visiting = new Set();
const visited = new Set();

function visit(id) {
  assert(!visiting.has(id), `dependency cycle detected at ${id}`);
  if (visited.has(id)) return;
  visiting.add(id);
  for (const dependency of nodesById.get(id).dependsOn) visit(dependency);
  visiting.delete(id);
  visited.add(id);
}

for (const id of nodesById.keys()) visit(id);

const roots = graph.nodes.filter((node) => node.dependsOn.length === 0).map((node) => node.id);
assert(roots.length === 1 && roots[0] === "BASE-001", `unexpected roots: ${roots.join(", ")}`);

const gateByMilestone = new Map([
  ["M0", "BASE-004"],
  ["M1", "GATE-001"],
  ["M2", "GATE-002"],
  ["M3", "GATE-003"],
  ["M4", "GATE-004"]
]);

for (const [milestone, gateId] of gateByMilestone) {
  const expected = graph.nodes
    .filter((node) => node.milestone === milestone && node.id !== gateId)
    .map((node) => node.id)
    .sort();
  if (gateId === "GATE-004") expected.push("GATE-001", "GATE-002", "GATE-003");
  expected.sort();
  const actual = [...nodesById.get(gateId).dependsOn].sort();
  assert(JSON.stringify(actual) === JSON.stringify(expected), `${gateId}: gate dependencies are incomplete or unexpected`);
}

const catalog = blueprint.split("## 6. Task Catalog")[1]?.split("## 7. 권장 Merge Batch")[0] ?? "";
const blueprintIds = new Set([...catalog.matchAll(/^\| `([A-Z0-9]+-[0-9]{3})` \|/gm)].map((match) => match[1]));
assert(blueprintIds.size === nodesById.size, `blueprint has ${blueprintIds.size} tasks, graph has ${nodesById.size}`);
for (const id of nodesById.keys()) {
  assert(blueprintIds.has(id), `${id}: missing from implementation blueprint`);
  assert(graphDocument.includes(id), `${id}: missing from TASK-GRAPH.md`);
}

assert(status.includes("전체 102개 작업"), "STATUS.md must declare the complete task graph");

const counts = Object.fromEntries(
  [...allowedMilestones].map((milestone) => [milestone, graph.nodes.filter((node) => node.milestone === milestone).length])
);

console.log(`self-hosted task graph ok (${graph.nodes.length} nodes, root ${roots[0]}, ${JSON.stringify(counts)})`);
