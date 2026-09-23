import fs from "node:fs";

function assert(condition, message) {
  if (!condition) throw new Error(message);
}

const policy = JSON.parse(fs.readFileSync("compat/release-policy.json", "utf8"));
const document = fs.readFileSync("docs/release/release-policy.md", "utf8");

assert(policy.schemaVersion === 1, "unexpected release policy schema");
assert(policy.versioning.sdk.scheme === "semver", "SDK versioning must be semver");
assert(policy.versioning.runtimeAbi.current === 1, "runtime ABI baseline must be 1");
assert(policy.supportWindows.node.baseline === "22.23.0", "unexpected Node support baseline");
assert(policy.supportWindows.npm.baseline === "10.9.2", "unexpected npm support baseline");
assert(policy.supportWindows.pnpm.baseline === "9.15.9", "unexpected pnpm support baseline");
assert(policy.supportWindows.browser.baseline.includes("SharedArrayBuffer"), "browser support must require SharedArrayBuffer");
assert(policy.endOfSupport.noticeDays >= 90, "support notice must be at least 90 days");
assert(policy.channels.some((channel) => channel.id === "stable" && channel.externalPublish === true), "stable channel must define external publish");
assert(policy.channels.every((channel) => channel.promotionCriteria.length > 0), "each release channel must define promotion criteria");
assert(policy.candidateRehearsal.length >= 4, "candidate rehearsal steps are incomplete");
assert(document.includes("Candidate Rehearsal"), "release policy document must include candidate rehearsal");
assert(document.includes("지원 종료"), "release policy document must include support end policy");

console.log("release policy ok");
