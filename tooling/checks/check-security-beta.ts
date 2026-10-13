import fs from "node:fs";
import path from "node:path";
import { pathToFileURL } from "node:url";

function readJson(file) {
  return JSON.parse(fs.readFileSync(file, "utf8"));
}

function assert(condition, message) {
  if (!condition) throw new Error(message);
}

const checklist = readJson("compat/security-beta-checklist.json");

assert(checklist.schemaVersion === 1, "unexpected security beta checklist schema");
assert(checklist.gate === "SG27", "security beta checklist must target SG27");
assert(checklist.status === "pass", "security beta checklist status must be pass");
assert(Array.isArray(checklist.unresolvedHighRisk) && checklist.unresolvedHighRisk.length === 0, "unresolved high-risk items must be empty");
assert(Array.isArray(checklist.items) && checklist.items.length >= 7, "security beta checklist must include core items");

for (const item of checklist.items) {
  assert(item.status === "pass", `checklist item not pass: ${item.id}`);
  assert(item.risk !== "high" || item.status === "pass", `high-risk item unresolved: ${item.id}`);
  assert(Array.isArray(item.evidence) && item.evidence.length > 0, `checklist item missing evidence: ${item.id}`);
  for (const evidence of item.evidence) {
    assert(fs.existsSync(path.resolve(evidence)), `missing evidence path for ${item.id}: ${evidence}`);
  }
}

for (const requiredPath of checklist.requiredPaths) {
  assert(fs.existsSync(path.resolve(requiredPath)), `missing required security path: ${requiredPath}`);
}

const headersSource = fs.readFileSync("packages/browser-host/src/security/headers.ts", "utf8");
assert(headersSource.includes("validateRuntimeHeaders"), "CSP/COOP/COEP validator export missing");
assert(headersSource.includes("Cross-Origin-Opener-Policy") || headersSource.includes("cross-origin-opener-policy"), "COOP validation missing");
assert(headersSource.includes("Cross-Origin-Embedder-Policy") || headersSource.includes("cross-origin-embedder-policy"), "COEP validation missing");
assert(headersSource.includes("content-security-policy") || headersSource.includes("Content-Security-Policy"), "CSP validation missing");

const credentialsSource = fs.readFileSync("packages/browser-host/src/security/credentials.ts", "utf8");
assert(credentialsSource.includes("redactSecrets"), "credential redaction helper missing");
assert(credentialsSource.includes("stripSensitiveHeadersForRedirect"), "redirect credential stripping missing");
assert(credentialsSource.includes("snapshot"), "credential store redacted snapshot missing");

const permissionsSource = fs.readFileSync("packages/browser-host/src/security/permissions.ts", "utf8");
assert(permissionsSource.includes("auditLog"), "permission audit log missing");
assert(permissionsSource.includes("network"), "network permission scope missing");

const catalogSource = fs.readFileSync("packages/browser-host/src/security/permission-catalog.ts", "utf8");
assert(catalogSource.includes("lifecycle"), "lifecycle permission catalog entry missing");
assert(catalogSource.includes("ERR_PM_LIFECYCLE_BLOCKED"), "lifecycle diagnostic code missing from catalog");

const abuseSource = fs.readFileSync("packages/browser-host/src/security/abuse-limits.ts", "utf8");
assert(abuseSource.includes("maxWorkerSpawn"), "abuse policy missing maxWorkerSpawn");
assert(abuseSource.includes("maxArchiveBytes"), "abuse policy missing maxArchiveBytes");
assert(abuseSource.includes("maxLoopIterations"), "abuse policy missing maxLoopIterations");
assert(abuseSource.includes("maxMemoryGrowthBytes"), "abuse policy missing maxMemoryGrowthBytes");
assert(abuseSource.includes("checkAbuse"), "checkAbuse function missing");
assert(abuseSource.includes("assertAbuseAllowed"), "assertAbuseAllowed helper missing");

const zipSource = fs.readFileSync("packages/browser-host/src/onboarding/zip-adapter.ts", "utf8");
assert(zipSource.includes("checkAbuse"), "zip import must call checkAbuse");
assert(zipSource.includes('kind: "archive"') || zipSource.includes("kind: \"archive\""), "zip import must check archive abuse kind");

const spawnSource = fs.readFileSync("packages/browser-host/src/process/spawn.ts", "utf8");
assert(spawnSource.includes("assertAbuseAllowed"), "HostProcessTable must call assertAbuseAllowed");
assert(spawnSource.includes('kind: "worker-spawn"') || spawnSource.includes("kind: \"worker-spawn\""), "HostProcessTable must check worker-spawn abuse");

const reliabilitySource = fs.readFileSync("packages/workspace-runtime/src/reliability.ts", "utf8");
assert(reliabilitySource.includes("assertAbuseAllowed"), "preview reliability must call assertAbuseAllowed");
assert(reliabilitySource.includes("guardLoopIterations"), "preview reliability must guard loop iterations");
assert(reliabilitySource.includes("guardMemoryGrowth") || reliabilitySource.includes("memory-growth"), "preview reliability must guard memory growth");
const supportBundleSource = fs.readFileSync("packages/browser-host/src/observability/support-bundle.ts", "utf8");
assert(supportBundleSource.includes("cookie"), "support bundle redaction must cover cookies");
assert(supportBundleSource.includes("redactRuntimeLog"), "support bundle log redaction missing");

const previewRelaySource = fs.readFileSync("packages/preview/src/relay.ts", "utf8");
assert(previewRelaySource.includes("ESTALESESSION"), "preview forgery defense missing ESTALESESSION");
assert(previewRelaySource.includes("origin"), "preview relay must bind origin");

const security = await import(pathToFileURL(path.resolve("packages/browser-host/src/security/index.ts")).href);
const observability = await import(pathToFileURL(path.resolve("packages/browser-host/src/observability/support-bundle.ts")).href);

assert.equal = (actual, expected, message) => assert(actual === expected, message || `expected ${expected}, got ${actual}`);

const denied = security.checkAbuse({
  kind: "worker-spawn",
  workerSpawnCount: security.DEFAULT_ABUSE_LIMIT_POLICY.maxWorkerSpawn + 1,
  projectId: "project-a"
});
assert(denied.decision === "deny", "abuse check must deny over-limit worker spawn");
assert(denied.diagnostic?.code === "ERR_ABUSE_WORKER_SPAWN", "abuse deny diagnostic code mismatch");

const allowed = security.checkAbuse({
  kind: "archive",
  archiveBytes: security.DEFAULT_ABUSE_LIMIT_POLICY.maxArchiveBytes
});
assert(allowed.decision === "allow", "abuse check must allow archive at limit");
assert(allowed.diagnostic === null, "allowed abuse check must not attach diagnostic");

assert(security.redactSecrets("token=npm_secret_token", ["npm_secret_token"]) === "token=[REDACTED]", "redactSecrets inline assertion failed");

const headers = security.createRuntimeHeaderSet();
const validation = security.validateRuntimeHeaders({
  url: "https://app.example/",
  headers
});
assert(validation.status === "pass", "shipped runtime headers must validate");

const lifecycle = security.createLifecyclePermissionDiagnostic({
  command: "node-gyp rebuild",
  path: "/workspace/packages/native"
});
assert(lifecycle.code === "ERR_PM_LIFECYCLE_BLOCKED", "lifecycle diagnostic must use blocked code");
assert(lifecycle.catalogId === "lifecycle-script-run", "lifecycle diagnostic must reference UI catalog");

const store = security.createRegistryCredentialStore();
store.setToken({
  registryOrigin: "https://registry.npmjs.org",
  token: "npm_pipeline_secret"
});
assert(!JSON.stringify(store.snapshot()).includes("npm_pipeline_secret"), "credential snapshot must redact tokens");

const bundle = observability.createRuntimeSupportBundle({
  logs: [
    "Authorization=Bearer npm_pipeline_secret",
    "Cookie: sid=super-secret",
    "cookie=session=abc123",
    "_auth=registry-basic-auth"
  ],
  environment: {
    NPM_TOKEN: "npm_pipeline_secret",
    COOKIE: "sid=super-secret",
    registryAuth: "Bearer npm_pipeline_secret"
  }
});
const serialized = JSON.stringify(bundle);
assert(!serialized.includes("npm_pipeline_secret"), "support bundle must redact registry tokens");
assert(!serialized.includes("super-secret"), "support bundle must redact cookies");
assert(!serialized.includes("registry-basic-auth"), "support bundle must redact registry auth");
assert(bundle.environment.NPM_TOKEN === "[REDACTED]", "NPM_TOKEN env must be redacted");
assert(bundle.environment.COOKIE === "[REDACTED]", "COOKIE env must be redacted");

console.log(
  `security beta checklist ok items=${checklist.items.length} unresolvedHighRisk=${checklist.unresolvedHighRisk.length}`
);
