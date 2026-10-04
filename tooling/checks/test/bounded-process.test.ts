import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";

import { runBoundedProcess } from "../lib/bounded-process.ts";

const fixtureDirectory = fs.mkdtempSync(path.join(os.tmpdir(), "nuriteo-bounded-process-"));
const cleanupMarker = path.join(fixtureDirectory, "cleanup-marker");
const processIds = path.join(fixtureDirectory, "process-ids.json");

try {
  await verifiesGracefulProcessGroupCleanup();
  await verifiesHardProcessGroupDeadline();
  console.log("bounded process runner tests ok");
} finally {
  fs.rmSync(fixtureDirectory, { force: true, recursive: true });
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
