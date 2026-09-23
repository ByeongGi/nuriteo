import fs from "node:fs";

function assert(condition, message) {
  if (!condition) throw new Error(message);
}

const playbook = JSON.parse(fs.readFileSync("compat/incident-playbook.json", "utf8"));
const document = fs.readFileSync("docs/release/incident-playbook.md", "utf8");

assert(playbook.schemaVersion === 1, "unexpected incident playbook schema");
assert(playbook.supportBundleRequired === true, "support bundle must be required for incidents");
for (const id of playbook.requiredIncidentTypes) {
  const incident = playbook.incidents.find((item) => item.id === id);
  assert(incident, `missing incident type: ${id}`);
  assert(incident.owner, `missing incident owner: ${id}`);
  assert(incident.mitigation.length > 0, `missing mitigation: ${id}`);
  assert(incident.userCommsTemplate.length > 40, `missing user comms template: ${id}`);
  assert(document.includes(id), `incident document missing ${id}`);
}
assert(playbook.responseTargets.critical.includes("4 hours"), "critical response target must be explicit");
assert(document.includes("Runtime support bundle"), "incident document must require support bundle");

console.log("incident playbook ok");
