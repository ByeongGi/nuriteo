import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";

import { runBoundedProcess } from "../lib/bounded-process.ts";

const fixtureDirectory = fs.mkdtempSync(path.join(os.tmpdir(), "nuriteo-bounded-process-"));
const cleanupMarker = path.join(fixtureDirectory, "cleanup-marker");
const processIds = path.join(fixtureDirectory, "process-ids.json");
const mixedProcessIds = path.join(fixtureDirectory, "mixed-process-ids.json");
const earlyExitProcessIds = path.join(fixtureDirectory, "early-exit-process-ids.json");
const earlyExitReady = path.join(fixtureDirectory, "early-exit-ready");

try {
  await verifiesGracefulProcessGroupCleanup();
  await verifiesHardProcessGroupDeadline();
  await verifiesClosedLeaderDoesNotHideTermIgnoringDescendant();
  await verifiesSuccessfulLeaderDoesNotHideTermIgnoringDescendant();
  console.log("bounded process runner tests ok");
} finally {
  fs.rmSync(fixtureDirectory, { force: true, recursive: true });
}

async function verifiesSuccessfulLeaderDoesNotHideTermIgnoringDescendant() {
  const descendantSource = `
    const fs = require("node:fs");
    process.on("SIGTERM", () => {});
    fs.writeFileSync(${JSON.stringify(earlyExitReady)}, "ready");
    setInterval(() => {}, 1000);
  `;
  const source = `
    const { spawn } = require("node:child_process");
    const fs = require("node:fs");
    const descendant = spawn(process.execPath, ["-e", ${JSON.stringify(descendantSource)}], { stdio: "ignore" });
    fs.writeFileSync(${JSON.stringify(earlyExitProcessIds)}, JSON.stringify([descendant.pid]));
    const readiness = setInterval(() => {
      if (!fs.existsSync(${JSON.stringify(earlyExitReady)})) return;
      clearInterval(readiness);
      process.exit(0);
    }, 5);
  `;
  const terminationGraceMs = 150;
  const startedAt = Date.now();
  const result = await runBoundedProcess({
    arguments: ["-e", source],
    command: process.execPath,
    environment: process.env,
    killGraceMs: 500,
    terminationGraceMs,
    timeoutMs: 1_000,
    workingDirectory: fixtureDirectory
  });
  const elapsedMs = Date.now() - startedAt;

  assert.equal(result.status, 0, "cleanup must preserve the successful leader status");
  assert.equal(result.signal, null, "cleanup must preserve the successful leader signal");
  assert.equal(result.timedOut, false);
  assert.equal(result.cleanupEscalated, true, "TERM-ignoring descendant must require SIGKILL");
  assert.equal(result.cleanupFailed, false);
  assert.ok(elapsedMs >= terminationGraceMs, "runner did not honor the TERM cleanup grace");
  assert.ok(elapsedMs < 1_500, "successful-leader cleanup exceeded its hard bound");
  for (const pid of JSON.parse(fs.readFileSync(earlyExitProcessIds, "utf8"))) {
    assert.equal(isAlive(pid), false, `process ${pid} survived successful-leader cleanup`);
  }
}

async function verifiesClosedLeaderDoesNotHideTermIgnoringDescendant() {
  const source = `
    const { spawn } = require("node:child_process");
    const fs = require("node:fs");
    const descendant = spawn(process.execPath, ["-e", "process.on('SIGTERM', () => {}); setInterval(() => {}, 1000)"], { stdio: "ignore" });
    fs.writeFileSync(${JSON.stringify(mixedProcessIds)}, JSON.stringify([process.pid, descendant.pid]));
    process.on("SIGTERM", () => process.exit(0));
    setInterval(() => {}, 1000);
  `;
  const startedAt = Date.now();
  const result = await runBoundedProcess({
    arguments: ["-e", source],
    command: process.execPath,
    environment: process.env,
    killGraceMs: 500,
    terminationGraceMs: 150,
    timeoutMs: 100,
    workingDirectory: fixtureDirectory
  });

  assert.equal(result.timedOut, true);
  assert.equal(result.cleanupFailed, false);
  assert.ok(Date.now() - startedAt < 1_500, "mixed process cleanup exceeded its hard bound");
  for (const pid of JSON.parse(fs.readFileSync(mixedProcessIds, "utf8"))) {
    assert.equal(isAlive(pid), false, `process ${pid} survived mixed process-group termination`);
  }
}

async function verifiesGracefulProcessGroupCleanup() {
  const source = `
    const { spawn } = require("node:child_process");
    const fs = require("node:fs");
    spawn(process.execPath, ["-e", "setInterval(() => {}, 1000)"], { stdio: "ignore" });
    process.on("SIGTERM", () => {
      fs.writeFileSync(${JSON.stringify(cleanupMarker)}, "cleaned");
      process.exit(0);
    });
    setInterval(() => {}, 1000);
  `;
  const startedAt = Date.now();
  const result = await runBoundedProcess({
    arguments: ["-e", source],
    command: process.execPath,
    environment: process.env,
    killGraceMs: 500,
    terminationGraceMs: 500,
    timeoutMs: 100,
    workingDirectory: fixtureDirectory
  });

  assert.equal(result.timedOut, true);
  assert.equal(result.cleanupFailed, false);
  assert.ok(Date.now() - startedAt < 1_500, "graceful cleanup exceeded its hard bound");
  assert.equal(fs.readFileSync(cleanupMarker, "utf8"), "cleaned");
}

async function verifiesHardProcessGroupDeadline() {
  const source = `
    const { spawn } = require("node:child_process");
    const fs = require("node:fs");
    process.on("SIGTERM", () => {});
    const descendant = spawn(process.execPath, ["-e", "process.on('SIGTERM', () => {}); setInterval(() => {}, 1000)"], { stdio: "ignore" });
    fs.writeFileSync(${JSON.stringify(processIds)}, JSON.stringify([process.pid, descendant.pid]));
    setInterval(() => {}, 1000);
  `;
  const startedAt = Date.now();
  const result = await runBoundedProcess({
    arguments: ["-e", source],
    command: process.execPath,
    environment: process.env,
    killGraceMs: 500,
    terminationGraceMs: 150,
    timeoutMs: 100,
    workingDirectory: fixtureDirectory
  });

  assert.equal(result.timedOut, true);
  assert.equal(result.cleanupEscalated, true);
  assert.equal(result.cleanupFailed, false);
  assert.ok(Date.now() - startedAt < 1_500, "SIGKILL escalation exceeded its hard bound");
  for (const pid of JSON.parse(fs.readFileSync(processIds, "utf8"))) {
    assert.equal(isAlive(pid), false, `process ${pid} survived process-group termination`);
  }
}

function isAlive(pid) {
  try {
    process.kill(pid, 0);
    return true;
  } catch (error) {
    if (error?.code === "ESRCH") return false;
    throw error;
  }
}
