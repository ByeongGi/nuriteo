import { spawn } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";

export async function runReferenceNode(source, options = {}) {
  const cwd = fs.mkdtempSync(path.join(os.tmpdir(), "nuriteo-ref-node-"));
  const entry = path.join(cwd, "entry.mjs");
  fs.writeFileSync(entry, source);

  const startedAt = Date.now();
  const child = spawn(process.execPath, [entry], {
    cwd,
    env: {
      ...process.env,
      ...(options.env || {})
    },
    stdio: ["ignore", "pipe", "pipe"]
  });

  const stdout = [];
  const stderr = [];
  child.stdout.on("data", (chunk) => stdout.push(chunk));
  child.stderr.on("data", (chunk) => stderr.push(chunk));

  const status = await new Promise((resolve) => {
    child.on("exit", (code) => resolve(code));
  });

  const files = {};
  for (const file of options.assertFiles || []) {
    const abs = path.join(cwd, file);
    if (fs.existsSync(abs)) {
      files[file] = fs.readFileSync(abs).toString("base64");
    }
  }

  return {
    kind: "reference-node",
    status,
    stdout: Buffer.concat(stdout),
    stderr: Buffer.concat(stderr),
    files,
    trace: [
      { event: "spawn", at: startedAt },
      { event: "exit", at: Date.now(), status }
    ],
    fingerprint: {
      node: process.version,
      platform: process.platform,
      arch: process.arch
    }
  };
}
