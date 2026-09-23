import fs from "node:fs";

function assert(condition, message) {
  if (!condition) throw new Error(message);
}

const policy = JSON.parse(fs.readFileSync("compat/native-fallback-policy.json", "utf8"));
const source = fs.readFileSync("packages/node-runtime/src/package-managers/native-fallback.ts", "utf8");
const executionPolicy = fs.readFileSync("packages/node-runtime/src/package-managers/execution-policy.ts", "utf8");
const test = fs.readFileSync("tests/compatibility/package-managers/native-fallback-policy.test.ts", "utf8");

assert(policy.schemaVersion === 1, "unexpected native fallback policy schema");
for (const pattern of policy.classification.patterns) {
  assert(source.includes(pattern), `native fallback source missing pattern: ${pattern}`);
}
for (const action of policy.classification.actions) {
  assert(source.includes(`"${action}"`), `native fallback source missing action: ${action}`);
}
assert(policy.classification.unsupportedErrorCode === "ERR_PM_NATIVE_ADDON_UNSUPPORTED", "unexpected unsupported error code");
assert(executionPolicy.includes("nativeFallbackPolicy.classify"), "package execution policy must classify native fallback");
for (const decision of policy.supportedDecisions) {
  assert(test.includes(decision.package), `native fallback fixture missing package: ${decision.package}`);
  assert(test.includes(decision.action), `native fallback fixture missing action: ${decision.action}`);
}
assert(policy.requirements.packageNameInference === true, "package name inference must be required");
assert(policy.requirements.packageExecutionPolicyIntegration === true, "package execution integration must be required");
assert(policy.requirements.unsupportedMustRemainDiagnostic === true, "unsupported native fallback must remain diagnostic");

console.log("native fallback policy ok");
