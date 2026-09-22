import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const contract = JSON.parse(fs.readFileSync(path.join(root, "compat/service-backend-production.json"), "utf8"));
assert.equal(contract.schemaVersion, 1);
assert.equal(contract.status, "candidate");
for (const [name, enabled] of Object.entries(contract.capabilities)) {
  if (name !== "billing") assert.equal(enabled, true, `${name} must be enabled`);
}
assert.equal(contract.capabilities.billing, false);
assert.ok(contract.externalRequirements.length >= 3);
for (const relative of [
  "packages/service-backend/src/production-types.ts",
  "packages/service-backend/src/production-adapters.ts",
  "packages/service-backend/src/production-service.ts",
  "packages/service-backend/src/production-api.ts",
  "apps/preview-service/src/lib/cloudProjects.ts",
  "apps/preview-service/src/components/CloudProjectsDialog.tsx",
  "tests/service-backend/production-backend.test.mjs",
  "tests/preview-service/cloud-project-resume.test.mjs"
]) assert.ok(fs.existsSync(path.join(root, relative)), `missing ${relative}`);

await import("../tests/service-backend/production-backend.test.mjs");
await import("../tests/preview-service/cloud-project-resume.test.mjs");
console.log("service-backend production gate ok");
