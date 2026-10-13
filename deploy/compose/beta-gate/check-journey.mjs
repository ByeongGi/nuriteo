#!/usr/bin/env node
import fs from "node:fs";

const file = process.argv[2];
if (!file) throw new Error("usage: check-journey.mjs <journey.json>");
const journey = JSON.parse(fs.readFileSync(file, "utf8"));
const required = [
  "local-administrator", "oidc-provider-administration", "oidc-user", "mfa-policy",
  "team-collaboration", "instance-policy", "notifications", "audit-and-operations",
  "access-tokens", "git-integration", "registry-integration", "published-example",
  "published-preview"
];
const missing = required.filter((stage) => !Array.isArray(journey[stage]) || journey[stage].length === 0);
if (missing.length > 0) {
  console.error(`GATE-005 live journey is incomplete: ${missing.join(", ")}`);
  process.exit(3);
}
for (const stage of required) {
  if (journey[stage].some((assertion) => assertion?.status !== "PASS")) {
    throw new Error(`${stage} contains a non-passing assertion`);
  }
}
