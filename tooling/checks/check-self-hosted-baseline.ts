import fs from "node:fs";

function assert(condition, message) {
  if (!condition) throw new Error(message);
}

const manifestPath = "compat/self-hosted-test-baseline.json";
const packagePath = "package.json";
const manifest = JSON.parse(fs.readFileSync(manifestPath, "utf8"));
const packageJson = JSON.parse(fs.readFileSync(packagePath, "utf8"));

assert(manifest.schemaVersion === 1, "unexpected baseline schema version");
assert(manifest.taskId === "BASE-001", "baseline must belong to BASE-001");
assert(/^[0-9a-f]{40}$/.test(manifest.baselineCommit), "baselineCommit must be a full Git SHA");
assert(/^\d{4}-\d{2}-\d{2}$/.test(manifest.recordedAt), "recordedAt must use YYYY-MM-DD");

assert(Array.isArray(manifest.cleanCheckout?.preparation), "clean checkout preparation must be an array");
assert(
  manifest.cleanCheckout.preparation.includes("pnpm install --frozen-lockfile"),
  "clean checkout must use the frozen pnpm lockfile"
);
assert(Array.isArray(manifest.cleanCheckout?.commands), "clean checkout commands must be an array");

const expectedSuites = new Map([
  ["rust", { packageScript: "test:rust", command: "pnpm test:rust" }],
  ["typescript", { packageScript: "check:types", command: "pnpm check:types" }],
  ["browser", { packageScript: "test:browser", command: "pnpm test:browser" }]
]);

assert(Array.isArray(manifest.suites), "baseline suites must be an array");
assert(manifest.suites.length === expectedSuites.size, "baseline must define exactly three canonical suites");

const seenCategories = new Set();
const seenIds = new Set();

for (const suite of manifest.suites) {
  assert(typeof suite.id === "string" && suite.id.length > 0, "suite id is required");
  assert(!seenIds.has(suite.id), `duplicate suite id: ${suite.id}`);
  seenIds.add(suite.id);

  const expected = expectedSuites.get(suite.category);
  assert(expected, `${suite.id}: unsupported category ${suite.category}`);
  assert(!seenCategories.has(suite.category), `duplicate suite category: ${suite.category}`);
  seenCategories.add(suite.category);
  assert(suite.packageScript === expected.packageScript, `${suite.id}: unexpected package script`);
  assert(suite.command === expected.command, `${suite.id}: unexpected canonical command`);
  assert(packageJson.scripts?.[suite.packageScript], `${suite.id}: package script does not exist`);
  assert(manifest.cleanCheckout.commands.includes(suite.command), `${suite.id}: missing from clean checkout commands`);
  assert(suite.workingDirectory === ".", `${suite.id}: canonical suite must run at the repository root`);
  assert(typeof suite.purpose === "string" && suite.purpose.length > 0, `${suite.id}: purpose is required`);

  const timing = suite.timingSeconds;
  assert(Array.isArray(timing?.samples) && timing.samples.length === 3, `${suite.id}: exactly three samples required`);
  assert(timing.samples.every((sample) => Number.isFinite(sample) && sample > 0), `${suite.id}: invalid timing sample`);
  const calculatedAverage = timing.samples.reduce((sum, sample) => sum + sample, 0) / timing.samples.length;
  assert(Math.abs(calculatedAverage - timing.average) <= 0.01, `${suite.id}: average does not match samples`);
  assert(typeof timing.cacheState === "string" && timing.cacheState.length > 0, `${suite.id}: cache state is required`);

  assert(
    Array.isArray(suite.externalDependencies) && suite.externalDependencies.length > 0,
    `${suite.id}: external dependencies are required`
  );
  for (const dependency of suite.externalDependencies) {
    assert(typeof dependency.name === "string" && dependency.name.length > 0, `${suite.id}: dependency name is required`);
    assert(typeof dependency.type === "string" && dependency.type.length > 0, `${suite.id}: dependency type is required`);
    assert(
      ["run", "prepare-if-cache-miss"].includes(dependency.phase),
      `${suite.id}: invalid dependency phase ${dependency.phase}`
    );
    assert(
      ["none", "loopback-only", "outbound-https"].includes(dependency.network),
      `${suite.id}: invalid dependency network ${dependency.network}`
    );
  }
}

assert(seenCategories.size === expectedSuites.size, "canonical suite categories are incomplete");
assert(
  typeof manifest.measurement?.method === "string" && manifest.measurement.method.length > 0,
  "measurement method is required"
);
assert(
  typeof manifest.measurement?.samplePolicy === "string" && manifest.measurement.samplePolicy.length > 0,
  "measurement sample policy is required"
);
assert(manifest.measurement?.environment && typeof manifest.measurement.environment === "object", "environment is required");
assert(Array.isArray(manifest.measurement?.caveats), "measurement caveats must be an array");

console.log(
  `self-hosted baseline ok (${manifest.suites.length} suites: ${manifest.suites
    .map((suite) => `${suite.category}=${suite.timingSeconds.average}s`)
    .join(", ")})`
);
