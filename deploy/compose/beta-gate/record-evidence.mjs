#!/usr/bin/env node
import crypto from "node:crypto";
import fs from "node:fs";
import path from "node:path";

const [stage, assertionsPath] = process.argv.slice(2);
const required = (name) => {
  const value = process.env[name]?.trim();
  if (!value) throw new Error(`${name} is required`);
  return value;
};
if (!/^[a-z0-9-]+$/u.test(stage ?? "")) throw new Error("canonical stage name is required");
const reportFile = required("NURITEO_BETA_GATE_REPORT_FILE");
const evidenceDirectory = path.join(path.dirname(reportFile), "evidence");
const assertions = JSON.parse(fs.readFileSync(assertionsPath, "utf8"));
const assertionKinds = new Set(["api", "browser", "container", "database", "object", "process", "source"]);
if (!Array.isArray(assertions) || assertions.length === 0) throw new Error("runtime assertions are required");
if (!assertions.some((item) => ["api", "browser", "container", "database", "object", "process"].includes(item?.kind))) {
  throw new Error("at least one runtime assertion is required");
}
for (const item of assertions) {
  if (item?.status !== "PASS" || typeof item.name !== "string" || item.name.length === 0 || !assertionKinds.has(item.kind)) {
    throw new Error("only named passing assertions may be recorded");
  }
}
const evidence = {
  schemaVersion: 1,
  gate: "GATE-005",
  stage,
  status: "PASS",
  releaseCommit: required("NURITEO_BETA_GATE_RELEASE_COMMIT"),
  composeProject: required("NURITEO_BETA_GATE_COMPOSE_PROJECT"),
  databaseLineage: required("NURITEO_BETA_GATE_DATABASE_LINEAGE"),
  objectLineage: required("NURITEO_BETA_GATE_OBJECT_LINEAGE"),
  assertions
};
fs.mkdirSync(evidenceDirectory, { recursive: true, mode: 0o700 });
const relative = `evidence/${stage}.json`;
const bytes = Buffer.from(`${JSON.stringify(evidence)}\n`);
fs.writeFileSync(path.join(path.dirname(reportFile), relative), bytes, { mode: 0o600 });
process.stdout.write(JSON.stringify({
  stage,
  status: "PASS",
  evidence: relative,
  sha256: `sha256:${crypto.createHash("sha256").update(bytes).digest("hex")}`
}));
