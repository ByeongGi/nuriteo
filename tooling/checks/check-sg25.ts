import fs from "node:fs";
import path from "node:path";

function readJson(file) {
  return JSON.parse(fs.readFileSync(file, "utf8"));
}

function assert(condition, message) {
  if (!condition) throw new Error(message);
}

const fixtures = readJson("compat/ecosystem-fixtures.json");
const service = readJson("compat/service-workflow-fixture-results.json");
const actualPublic = readJson("compat/ecosystem-fixture-actual-product-results.json");
const actualFrameworks = readJson("compat/framework-actual-validation.json");
const publicMatrix = readJson("compat/public-compatibility-matrix.json");
const nextjs = readJson("compat/nextjs-compatibility.json");
const nextBrowserWorker = readJson("compat/nextjs-browser-worker-results.json");
const nextSecurity = readJson("compat/nextjs-security-baseline.json");

assert(fixtures.scope.fixtureCount === 20, "fixture catalog must have 20 entries");
assert(fixtures.fixtures.length === 20, "fixture list length must be 20");
assert(service.summary.total === 20, "service workflow results must cover 20 fixtures");
assert(service.summary.total === service.results.length, "service workflow total must match its result list");
assert(service.summary.pass === service.results.filter((result) => result.status === "pass").length, "service pass count is stale");
assert(service.summary.hold === service.results.filter((result) => result.status === "hold").length, "service hold count is stale");
assert(service.summary.passOrHold === service.summary.pass + service.summary.hold, "service pass-or-hold count is stale");
for (const result of service.results.filter((entry) => entry.source === "compat/ecosystem-fixture-actual-product-results.json")) {
  const measured = actualPublic.results.find((entry) => entry.id === result.id);
  assert(measured, `service public fixture ${result.id} is missing measured evidence`);
  assert(result.status === measured.status && result.score === measured.score, `service public fixture ${result.id} drifted from measured evidence`);
}
assert(service.summary.passOrHold >= 14, "SG25 requires >=14 pass or documented hold");
assert(service.summary.sg25 === "pass", "service workflow SG25 summary must pass");

const react = actualFrameworks.results.find((entry) => entry.framework === "vite-react");
const vue = actualFrameworks.results.find((entry) => entry.framework === "vite-vue");
const svelte = actualFrameworks.results.find((entry) => entry.framework === "vite-svelte");
const next = actualFrameworks.results.find((entry) => entry.framework === "nextjs");
const webpack = actualFrameworks.results.find((entry) => entry.framework === "webpack-dev-workflow");
const rspack = actualFrameworks.results.find((entry) => entry.framework === "rspack-dev-workflow");
assert(react?.grade === "supported", "Vite React must remain supported");
assert(vue?.validation === "actual-worker-backed", "Vue must have actual worker-backed validation");
assert(svelte?.validation === "actual-worker-backed", "Svelte must have actual worker-backed validation");
assert(vue?.grade === "supported", "Vue must be supported");
assert(svelte?.grade === "supported", "Svelte must be supported");
assert(next?.grade === "product-preview", "Next.js public grade must record the adapter preview claim");
assert(webpack?.grade === "supported" && webpack.validation === "actual-browser-worker", "Webpack must retain strict-CSP browser-worker support");
assert(rspack?.grade === "supported" && rspack.validation === "actual-browser-worker", "Rspack must retain strict-CSP browser-worker support");
assert(nextjs.publicGrade === "product-preview", "nextjs-compatibility publicGrade must be product-preview");
assert(nextjs.fullRuntimeGrade === "product-supported", "full Next.js runtime must remain product-supported");
assert(nextjs.productSupportClaim === true, "Next.js adapter product support must be claimed");
assert(nextjs.browserWorker.status === "pass", "full Next.js runtime must retain strict-CSP browser-worker evidence");
assert(nextBrowserWorker.preflight.status === "pass", "Next.js browser-worker preflight must pass");
assert(nextSecurity.status === "pass" && nextSecurity.next.releaseSecurityEligible === true, "Next.js fixture must remain on the maintained security baseline");
assert(
  nextjs.capabilities.some((entry) => entry.id === "next-app-router-dev" && entry.status === "supported"),
  "full Next.js CLI dev evidence must remain supported"
);

const vueMatrix = publicMatrix.frameworks.find((entry) => entry.name === "Vite Vue runtime");
const svelteMatrix = publicMatrix.frameworks.find((entry) => entry.name === "Vite Svelte");
const webpackMatrix = publicMatrix.frameworks.find((entry) => entry.name === "Webpack 5.111.0 dev workflow");
const rspackMatrix = publicMatrix.frameworks.find((entry) => entry.name === "Rspack 2.2.4 dev workflow");
assert(vueMatrix?.status === "supported", "public matrix Vue status must be supported");
assert(svelteMatrix?.status === "supported", "public matrix Svelte status must be supported");
assert(webpackMatrix?.status === "supported", "public matrix Webpack status must be supported");
assert(rspackMatrix?.status === "supported", "public matrix Rspack status must be supported");
assert(publicMatrix.projectFixtures.total === 20, "public matrix fixture total must be 20");
assert(publicMatrix.projectFixtures.serviceWorkflowPassOrHold >= 14, "public matrix SG25 passOrHold must be >=14");

for (const file of [
  "tests/compatibility/frameworks/vite/vite-vue-svelte-actual.test.ts",
  "compat/framework-actual-validation.json",
  "compat/framework-product-support.json",
  "compat/nextjs-browser-worker-results.json",
  "compat/nextjs-security-baseline.json",
  "compat/service-workflow-fixture-results.json",
  "docs/productization/public-compatibility-matrix.md"
]) {
  assert(fs.existsSync(path.resolve(file)), `missing SG25 artifact: ${file}`);
}

const publicDoc = fs.readFileSync("docs/productization/public-compatibility-matrix.md", "utf8");
assert(publicDoc.includes("Vite Vue runtime | supported"), "public matrix doc must list Vue as supported");
assert(publicDoc.includes("Vite Svelte | supported"), "public matrix doc must list Svelte as supported");
assert(publicDoc.includes("Webpack 5.111.0 dev workflow | supported"), "public matrix doc must list Webpack as supported");
assert(publicDoc.includes("Rspack 2.2.4 dev workflow | supported"), "public matrix doc must list Rspack as supported");
assert(publicDoc.includes("20") && publicDoc.includes("minimumPassOrHoldForSG25") || publicDoc.includes("15 pass"), "public matrix doc must describe the 20-fixture SG25 gate");

const supportDoc = fs.readFileSync("docs/release/support-matrix.md", "utf8");
assert(supportDoc.includes("Vite Vue runtime"), "support-matrix must mention Vite Vue");
assert(supportDoc.includes("Vite Svelte"), "support-matrix must mention Vite Svelte");
assert(supportDoc.includes("Next.js"), "support-matrix must mention Next.js");
assert(supportDoc.includes("product-preview"), "support-matrix must record the Next.js adapter preview grade");
assert(supportDoc.includes("candidate"), "support-matrix must record candidate grades");
assert(supportDoc.includes("hold"), "support-matrix must record hold grades");

console.log(
  `SG25 ok fixtures=${service.summary.total} passOrHold=${service.summary.passOrHold} vue=${vue.grade} svelte=${svelte.grade} next=${next.grade}`
);
