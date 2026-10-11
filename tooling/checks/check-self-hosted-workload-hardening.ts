import assert from "node:assert/strict";
import fs from "node:fs";
import { spawnSync } from "node:child_process";

const policy = JSON.parse(fs.readFileSync("security/workload-hardening-policy.json", "utf8")) as {
  schemaVersion: number; taskId: string; profile: string;
  container: Record<string, unknown>; pod: Record<string, unknown>; network: Record<string, unknown>;
  requiredWorkloadTemplates: string[]; images: string[] };
assert.equal(policy.schemaVersion, 1);
assert.equal(policy.taskId, "SEC-003");
assert.equal(policy.profile, "restricted-v1");
assert.deepEqual(policy.images, ["server", "web", "operations"]);

const helpers = fs.readFileSync("charts/nuriteo/templates/_helpers.tpl", "utf8");
for (const required of ["runAsNonRoot: true", "runAsUser: 65532", "runAsGroup: 65532", "type: RuntimeDefault",
  "allowPrivilegeEscalation: false", "readOnlyRootFilesystem: true", "- ALL"])
  assert.ok(helpers.includes(required), `Helm hardening helper missing: ${required}`);

for (const template of policy.requiredWorkloadTemplates) {
  const source = fs.readFileSync(`charts/nuriteo/templates/${template}`, "utf8");
  assert.ok(source.includes("automountServiceAccountToken: false"), `${template}: service account token must be disabled`);
  assert.ok(source.includes('include "nuriteo.podSecurityContext"'), `${template}: pod security context missing`);
  assert.ok(source.includes('include "nuriteo.containerSecurityContext"'), `${template}: container security context missing`);
}

const render = spawnSync("helm", ["template", "nuriteo", "charts/nuriteo", "--namespace", "nuriteo",
  "--set", "networkPolicy.enabled=true", "--set-string", "networkPolicy.externalEgress.cidrBlocks[0]=10.40.12.0/24"],
{ encoding: "utf8" });
assert.equal(render.status, 0, render.stderr);
const yaml = render.stdout;
for (const [pattern, expected] of [
  [/runAsNonRoot: true/g, 4], [/seccompProfile:/g, 4], [/type: RuntimeDefault/g, 4],
  [/allowPrivilegeEscalation: false/g, 4], [/readOnlyRootFilesystem: true/g, 4], [/automountServiceAccountToken: false/g, 4],
] as Array<[RegExp, number]>) assert.equal((yaml.match(pattern) ?? []).length, expected, `${pattern} workload coverage`);
assert.equal((yaml.match(/^kind: NetworkPolicy$/gmu) ?? []).length, 4);
for (const prohibited of [/privileged:\s*true/u, /hostNetwork:\s*true/u, /hostPID:\s*true/u, /hostIPC:\s*true/u, /hostPath:/u])
  assert.doesNotMatch(yaml, prohibited);

const schema = JSON.parse(fs.readFileSync("charts/nuriteo/values.schema.json", "utf8")) as {
  properties: { serviceAccount: { properties: { automountServiceAccountToken: { const?: boolean } } } } };
assert.equal(schema.properties.serviceAccount.properties.automountServiceAccountToken.const, false);

const compose = fs.readFileSync("deploy/compose/compose.yaml", "utf8");
assert.ok((compose.match(/read_only: true/g) ?? []).length >= 5);
assert.ok((compose.match(/user: "65532:65532"/g) ?? []).length >= 5);
assert.ok((compose.match(/cap_drop:\n\s+- ALL/g) ?? []).length >= 5);
assert.ok((compose.match(/no-new-privileges:true/g) ?? []).length >= 8);

for (const file of ["deploy/docker/server.Dockerfile", "deploy/docker/web.Dockerfile", "deploy/docker/operations.Dockerfile"]) {
  const dockerfile = fs.readFileSync(file, "utf8");
  assert.ok(dockerfile.includes("USER 65532:65532"), `${file}: non-root runtime user missing`);
  assert.doesNotMatch(dockerfile, /ENTRYPOINT \["(?:sh|bash)"/u);
}

console.log(JSON.stringify({ status: "pass", task: policy.taskId, profile: policy.profile,
  workloadTemplates: policy.requiredWorkloadTemplates.length, networkPolicies: 4, images: policy.images.length }));
