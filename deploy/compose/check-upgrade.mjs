import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import { execute, loadPlan, validatePlan } from "./upgrade.mjs";

const planPath = path.resolve("deploy/compose/fixtures/upgrade-plan-v1.json");
const { plan } = loadPlan(planPath);
const helperSource = fs.readFileSync("deploy/compose/upgrade.mjs", "utf8");
const rehearsalContainerfile = fs.readFileSync("deploy/compose/fixtures/upgrade-rehearsal/Containerfile", "utf8");
const rehearsalNode = fs.readFileSync("deploy/compose/fixtures/upgrade-rehearsal/fixture-node.sh", "utf8");
const actualRehearsal = fs.readFileSync("deploy/compose/run-upgrade-rehearsal.sh", "utf8");

assert.match(helperSource, /fetch\('http:\/\/127\.0\.0\.1:3000\/sign-in'/u, "helper must probe Web /sign-in");
assert.match(rehearsalContainerfile, /COPY --chmod=0555 fixture-node\.sh \/usr\/local\/bin\/node/u, "rehearsal must install an executable Node probe adapter");
assert.match(rehearsalNode, /http:\/\/127\.0\.0\.1:3000\/sign-in/u, "rehearsal adapter must implement the production readiness endpoint");
assert.equal(plan.source.migration, 46, "qualification must start at the frozen Beta migration");
assert.equal(plan.target.migration, 50, "qualification must target the current RC migration");
assert.match(actualRehearsal, /FIXTURE_PREFLIGHT_FAIL=true/u, "actual rehearsal must inject a preflight stop");
assert.match(actualRehearsal, /project-bundle-v1:preserve-me/u, "actual rehearsal must preserve an object sentinel");

class FakeRunner {
  constructor(failAt = "") { this.calls = []; this.failAt = failAt; this.current = plan.source.release; }
  assertWorkloads(release) { this.calls.push(`assert:${release.release}`); assert.equal(release.release, this.current); }
  compose(release, args) {
    const call = `${release.release}:${args.join(" ")}`;
    this.calls.push(call);
    if (this.failAt && call.includes(this.failAt)) throw new Error("injected failure");
    if (args[0] === "up") this.current = release.release;
  }
  waitHealthy(service) {
    this.calls.push(`healthy:${service}`);
    if (this.failAt === `healthy:${service}`) {
      this.failAt = "";
      throw new Error("injected readiness failure");
    }
  }
  waitWebReady() {
    this.calls.push("ready:web:/sign-in");
    if (this.failAt === "ready:web:/sign-in") {
      this.failAt = "";
      throw new Error("injected web readiness failure");
    }
  }
}

const success = new FakeRunner();
execute("upgrade", planPath, success);
assert.deepEqual(success.calls.slice(0, 4), [
  `assert:${plan.source.release}`,
  `${plan.target.release}:run --rm --no-deps migrate upgrade-preflight`,
  `${plan.target.release}:run --rm --no-deps storage-check`,
  `${plan.target.release}:run --rm --no-deps migrate migrate`
]);
assert.equal(success.calls.at(-1), "ready:web:/sign-in", "upgrade completes only after Web HTTP readiness");

for (const boundary of ["migrate upgrade-preflight", "storage-check", "migrate migrate"]) {
  const failed = new FakeRunner(boundary);
  assert.throws(() => execute("upgrade", planPath, failed), /injected failure/u);
  assert.equal(failed.current, plan.source.release, `${boundary} must preserve the previous workload`);
  assert.ok(!failed.calls.some((call) => call.includes(":up --detach")), `${boundary} must stop before workload mutation`);
}

const readiness = new FakeRunner("healthy:core");
assert.throws(() => execute("upgrade", planPath, readiness), /injected readiness failure/u);
assert.equal(readiness.current, plan.source.release, "readiness failure must restore the compatible source application");
assert.equal(readiness.calls.filter((call) => call.includes("migrate migrate")).length, 1, "readiness rollback must not run a down migration");

const webReadiness = new FakeRunner("ready:web:/sign-in");
assert.throws(() => execute("upgrade", planPath, webReadiness), /injected web readiness failure/u);
assert.equal(webReadiness.current, plan.source.release, "Web readiness failure must restore both source workloads");
assert.equal(webReadiness.calls.filter((call) => call.includes("migrate migrate")).length, 1, "Web readiness rollback must not rerun migration");
assert.ok(webReadiness.calls.filter((call) => call === `healthy:core`).length >= 2, "source Core must become healthy after Web readiness failure");
assert.ok(webReadiness.calls.filter((call) => call === "ready:web:/sign-in").length >= 2, "source Web /sign-in must become ready after rollback");
assert.ok(webReadiness.calls.includes(`${plan.source.release}:up --detach --no-deps core`), "Web failure must restore source Core");
assert.ok(webReadiness.calls.includes(`${plan.source.release}:up --detach --no-deps web`), "Web failure must restore source Web");

const rollback = new FakeRunner();
rollback.current = plan.target.release;
execute("rollback", planPath, rollback);
assert.ok(rollback.calls.some((call) => call.includes("upgrade-preflight")), "rollback needs compatibility preflight");
assert.ok(!rollback.calls.some((call) => call.endsWith("migrate migrate")), "rollback must not run migrations");

for (const mutate of [
  (copy) => { copy.upgrade.direction = "backward"; },
  (copy) => { copy.rollback.downMigration = "allowed"; },
  (copy) => { copy.rollback.schemaMaximum = 49; },
  (copy) => { copy.target.serverImage = "registry.example.invalid/server:latest"; },
  (copy) => { copy.objects.rewritePolicy = "allowed"; }
]) {
  const copy = structuredClone(plan);
  mutate(copy);
  const files = await import("node:fs/promises");
  const manifest = JSON.parse(await files.readFile("compat/self-hosted-upgrade-compatibility-v1.json", "utf8"));
  const targetManifest = JSON.parse(await files.readFile("deploy/compose/fixtures/target-release-set-v1.json", "utf8"));
  assert.throws(() => validatePlan(copy, manifest, targetManifest));
}

{
  const copy = structuredClone(plan);
  copy.target.serverImage = copy.target.serverImage.replace(/a{64}$/u, "c".repeat(64));
  const files = await import("node:fs/promises");
  const manifest = JSON.parse(await files.readFile("compat/self-hosted-upgrade-compatibility-v1.json", "utf8"));
  const targetManifest = JSON.parse(await files.readFile("deploy/compose/fixtures/target-release-set-v1.json", "utf8"));
  assert.throws(() => validatePlan(copy, manifest, targetManifest), /target server digest drift/u);
}

console.log("compose upgrade contract ok (preflight -> object check -> migrate -> workload, stop and no-down-migration rollback)");
