#!/usr/bin/env node

import assert from "node:assert/strict";
import crypto from "node:crypto";
import fs from "node:fs";
import path from "node:path";
import { spawnSync } from "node:child_process";
import { fileURLToPath } from "node:url";

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "../..");

export function loadPlan(planPath) {
  const plan = JSON.parse(fs.readFileSync(planPath, "utf8"));
  const manifestPath = path.resolve(root, plan.compatibilityManifest);
  assert.equal(sha256(manifestPath), plan.compatibilityManifestSha256, "compatibility manifest digest drift");
  const manifest = JSON.parse(fs.readFileSync(manifestPath, "utf8"));
  const targetManifestPath = path.resolve(root, plan.targetReleaseManifest);
  assert.equal(sha256(targetManifestPath), plan.targetReleaseManifestSha256, "target release manifest digest drift");
  const targetManifest = JSON.parse(fs.readFileSync(targetManifestPath, "utf8"));
  validatePlan(plan, manifest, targetManifest);
  return { plan, manifestPath, targetManifestPath };
}

export function validatePlan(plan, manifest, targetManifest) {
  assert.equal(plan.schemaVersion, 1, "unsupported upgrade plan schema");
  assert.equal(manifest.schemaVersion, 1, "unsupported compatibility manifest schema");
  assert.equal(plan.upgrade.direction, "forward-only", "downgrade is not supported");
  assert.equal(plan.upgrade.failurePolicy, "stop-before-mutation", "unsafe failure policy");
  assert.equal(manifest.support.downgrade, "not-supported", "manifest must forbid downgrade");
  assert.equal(plan.source.release, manifest.support.upgradeFrom, "unsupported source release");
  assert.equal(plan.target.release, manifest.support.upgradeTo, "unexpected target release");
  assert.equal(targetManifest.schemaVersion, 1, "unsupported target release manifest schema");
  assert.equal(targetManifest.releaseLineage, manifest.releaseLineage, "target release lineage drift");
  assert.equal(targetManifest.release, plan.target.release, "target release identity drift");
  assert.equal(targetManifest.images.identity, "sha256-digest", "target images must use digest identity");
  assert.equal(targetManifest.images.setPolicy, "complete-release-set", "target images must be a complete release set");
  assert.equal(plan.source.migration, manifest.schema.sourceMigration, "source migration drift");
  assert.ok(plan.target.migration >= plan.source.migration, "target migration must be forward-only");
  assert.deepEqual(plan.objects.readFormats, manifest.objects.readFormats, "object read format drift");
  assert.equal(plan.objects.writeFormat, manifest.objects.writeFormat, "object write format drift");
  assert.equal(plan.objects.existingObjectPolicy, "read-in-place", "objects must remain in place");
  assert.equal(plan.objects.rewritePolicy, "forbidden-during-upgrade", "upgrade must not rewrite objects");
  assert.equal(plan.rollback.applicationRelease, plan.source.release, "rollback must select the supported source application");
  assert.ok(targetManifest.rollback.compatibleApplications.includes(plan.source.release), "target release does not permit source application rollback");
  assert.equal(plan.rollback.schemaMinimum, plan.source.migration, "rollback schema minimum drift");
  assert.ok(plan.rollback.schemaMaximum >= plan.target.migration, "source application does not support target schema");
  assert.ok(plan.rollback.objectFormats.includes(plan.objects.writeFormat), "source application cannot read current objects");
  assert.equal(plan.rollback.database, "preserve-current-schema", "rollback must preserve the database schema");
  assert.equal(plan.rollback.downMigration, "forbidden", "automatic down migration is forbidden");
  for (const field of ["schemaMinimum", "schemaMaximum", "database", "downMigration"]) {
    assert.equal(plan.rollback[field], targetManifest.rollback[field], `rollback ${field} drift`);
  }
  assert.deepEqual(plan.rollback.objectFormats, targetManifest.rollback.objectFormats, "rollback object format drift");
  for (const release of [plan.source, plan.target]) {
    for (const key of ["serverImage", "webImage"]) assert.match(release[key], /@sha256:[a-f0-9]{64}$/u, `${key} must be digest-pinned`);
  }
  assert.notEqual(plan.source.serverImage, plan.target.serverImage, "target server must be a new release image");
  assert.notEqual(plan.source.webImage, plan.target.webImage, "target web must be a new release image");
  const roles = Object.fromEntries(manifest.images.roles.map(({ name, digest }) => [name, digest]));
  assert.ok(plan.source.serverImage.endsWith(`@${roles.server}`), "source server digest drift");
  assert.ok(plan.source.webImage.endsWith(`@${roles.web}`), "source web digest drift");
  const targetRoles = Object.fromEntries(targetManifest.images.roles.map(({ name, digest }) => [name, digest]));
  assert.equal(targetManifest.images.roles.length, 2, "target release must not contain duplicate or extra roles");
  assert.deepEqual(Object.keys(targetRoles).sort(), ["server", "web"], "target release must contain exactly server and web roles");
  for (const digest of Object.values(targetRoles)) assert.match(digest, /^sha256:[a-f0-9]{64}$/u, "invalid target role digest");
  assert.ok(plan.target.serverImage.endsWith(`@${targetRoles.server}`), "target server digest drift");
  assert.ok(plan.target.webImage.endsWith(`@${targetRoles.web}`), "target web digest drift");
}

export function execute(action, planPath, runner) {
  const { plan, manifestPath, targetManifestPath } = loadPlan(planPath);
  if (!new Set(["upgrade", "rollback"]).has(action)) throw new Error("usage: upgrade.mjs <upgrade|rollback> <plan.json>");
  const from = action === "upgrade" ? plan.source : plan.target;
  const to = action === "upgrade" ? plan.target : plan.source;
  runner.assertWorkloads(from);

  // The current candidate performs the read-only schema/config check for both
  // directions. Rollback is an application compatibility decision, never a DB downgrade.
  const preflightRelease = action === "rollback" ? plan.target : to;
  runner.compose(preflightRelease, ["run", "--rm", "--no-deps", "migrate", "upgrade-preflight"]);
  if (action === "upgrade") {
    runner.compose(to, ["run", "--rm", "--no-deps", "storage-check"]);
    runner.compose(to, ["run", "--rm", "--no-deps", "migrate", "migrate"]);
  }
  try {
    runner.compose(to, ["up", "--detach", "--no-deps", "core"]);
    runner.waitHealthy("core");
    runner.compose(to, ["up", "--detach", "--no-deps", "web"]);
    runner.waitWebReady();
  } catch (error) {
    // Migration is intentionally not reversed. The plan proves the source app
    // supports the target schema/object format before this compensating switch.
    runner.compose(plan.source, ["up", "--detach", "--no-deps", "core"]);
    runner.waitHealthy("core");
    runner.compose(plan.source, ["up", "--detach", "--no-deps", "web"]);
    runner.waitWebReady();
    throw error;
  }
  return {
    action,
    from: from.release,
    to: to.release,
    compatibilityManifestSha256: sha256(manifestPath),
    targetReleaseManifestSha256: sha256(targetManifestPath)
  };
}

class ProcessRunner {
  constructor() {
    this.command = (process.env.NURITEO_COMPOSE_COMMAND || "docker compose").trim().split(/\s+/u);
    this.composeFile = process.env.NURITEO_COMPOSE_FILE || "deploy/compose/compose.yaml";
    this.projectName = process.env.NURITEO_COMPOSE_PROJECT_NAME || "";
  }
  invoke(args, release) {
    const [command, ...prefix] = this.command;
    const result = spawnSync(command, [...prefix, "-f", this.composeFile, ...args], {
      cwd: root,
      env: { ...process.env, NURITEO_SERVER_IMAGE: release.serverImage, NURITEO_WEB_IMAGE: release.webImage },
      stdio: "inherit"
    });
    if (result.error) throw result.error;
    if (result.status !== 0) throw new Error(`compose step failed (${args.join(" ")})`);
  }
  compose(release, args) { this.invoke(args, release); }
  container(service) {
    if (this.engine() === "podman" && this.projectName) {
      const result = spawnSync("podman", [
        "ps", "--all",
        "--filter", `label=com.docker.compose.project=${this.projectName}`,
        "--filter", `label=com.docker.compose.service=${service}`,
        "--format", "{{.ID}}",
      ], { cwd: root, encoding: "utf8" });
      const containers = result.stdout.trim().split("\n").filter(Boolean);
      if (result.status !== 0 || containers.length !== 1) throw new Error(`${service} workload is not present`);
      return containers[0];
    }
    const [command, ...prefix] = this.command;
    const result = spawnSync(command, [...prefix, "-f", this.composeFile, "ps", "--quiet", service], { cwd: root, encoding: "utf8", env: process.env });
    if (result.status !== 0 || !result.stdout.trim()) throw new Error(`${service} workload is not present`);
    return result.stdout.trim();
  }
  inspect(service, format) {
    const result = spawnSync(this.engine(), ["inspect", "--format", format, this.container(service)], { cwd: root, encoding: "utf8" });
    if (result.status !== 0) throw new Error(`cannot inspect ${service}`);
    return result.stdout.trim();
  }
  assertWorkloads(release) {
    for (const [service, key] of [["core", "serverImage"], ["web", "webImage"]]) {
      assert.equal(this.inspect(service, "{{.State.Status}}"), "running", `${service} must be running before change`);
      assert.equal(this.inspect(service, "{{.Config.Image}}"), release[key], `${service} image does not match source release`);
    }
    assert.equal(
      this.inspect("core", "{{if .State.Health}}{{.State.Health.Status}}{{else}}missing{{end}}"),
      "healthy",
      "core must be healthy before change"
    );
  }
  waitHealthy(service) {
    for (let attempt = 0; attempt < 60; attempt += 1) {
      if (this.inspect(service, "{{if .State.Health}}{{.State.Health.Status}}{{else}}{{.State.Status}}{{end}}") === "healthy") return;
      Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, 1000);
    }
    throw new Error(`${service} did not become healthy`);
  }
  waitWebReady() {
    const probe = "fetch('http://127.0.0.1:3000/sign-in',{redirect:'manual',signal:AbortSignal.timeout(2000)}).then(r=>{if(r.status<200||r.status>=400)process.exit(1)}).catch(()=>process.exit(1))";
    for (let attempt = 0; attempt < 30; attempt += 1) {
      const container = this.container("web");
      const status = spawnSync(this.engine(), ["inspect", "--format", "{{.State.Status}}", container], { cwd: root, encoding: "utf8" });
      if (status.status === 0 && status.stdout.trim() === "running") {
        const result = spawnSync(this.engine(), ["exec", container, "node", "-e", probe], { cwd: root, stdio: "ignore", timeout: 3000 });
        if (result.status === 0) return;
      }
      Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, 1000);
    }
    throw new Error("web /sign-in did not become ready");
  }
  engine() { return this.command.join(" ").includes("podman") ? "podman" : "docker"; }
}

function sha256(file) { return crypto.createHash("sha256").update(fs.readFileSync(file)).digest("hex"); }

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  try {
    const report = execute(process.argv[2], path.resolve(process.argv[3] || ""), new ProcessRunner());
    console.log(JSON.stringify({ status: "complete", ...report }));
  } catch (error) {
    console.error(`compose upgrade stopped (${error instanceof Error ? error.message : "unknown"})`);
    process.exitCode = 1;
  }
}
