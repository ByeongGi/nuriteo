import fs from "node:fs";

function assert(condition, message) {
  if (!condition) throw new Error(message);
}

const playbook = JSON.parse(fs.readFileSync("compat/incident-playbook.json", "utf8"));
const document = fs.readFileSync("docs/release/incident-playbook.md", "utf8");
const responsePolicy = JSON.parse(fs.readFileSync(playbook.responsePolicy, "utf8"));
const supportBundlePolicy = JSON.parse(fs.readFileSync(playbook.supportBundlePolicy, "utf8"));

assert(playbook.schemaVersion === 1, "unexpected incident playbook schema");
assert(playbook.status === "self-hosted-v1", "incident playbook must target self-hosted v1");
assert(playbook.supportBundleRequired === true, "support bundle must be required for incidents");
assert(responsePolicy.taskId === "SUP-004", "incident playbook must reference the current response policy");
assert(supportBundlePolicy.taskId === "SUP-002", "incident playbook must reference the current support bundle policy");
for (const id of playbook.requiredIncidentTypes) {
  const incident = playbook.incidents.find((item) => item.id === id);
  assert(incident, `missing incident type: ${id}`);
  assert(incident.owner, `missing incident owner: ${id}`);
  assert(incident.mitigation.length > 0, `missing mitigation: ${id}`);
  assert(incident.userCommsTemplate.length > 40, `missing user comms template: ${id}`);
  assert(document.includes(id), `incident document missing ${id}`);
}
assert(playbook.responseTargets.critical.includes("4 hours"), "critical response target must be explicit");
assert(document.includes("NURITEO redacted Support Bundle"), "incident document must require the redacted support bundle");
assert(document.includes("vulnerability-and-incident-response.md"), "incident document must link the response policy");

console.log("incident playbook ok");
