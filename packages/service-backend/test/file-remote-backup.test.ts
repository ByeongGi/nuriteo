import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";

import {
  FILE_REMOTE_BACKUP_SCHEMA_VERSION,
  FileRemoteBackup,
  ServiceBackendError
} from "../src/index.ts";
import type { ProjectSnapshot } from "../src/index.ts";

const testDirectory = fs.mkdtempSync(
  path.join(os.tmpdir(), "nuriteo-file-remote-backup-")
);
const persistPath = path.join(testDirectory, "nested", "remote-backup.json");

const snapshot = (projectId: string, generation: number, content: string): ProjectSnapshot => ({
  schemaVersion: 1,
  projectId,
  generation,
  files: [{ path: "/src/main.ts", content }],
  savedAt: `2026-09-22T00:00:0${generation}.000Z`,
  byteSize: Buffer.byteLength(content),
  extensions: {}
});

try {
  const first = new FileRemoteBackup({ persistPath });
  const original = snapshot("project-b", 1, "export default 1;\n");
  await first.pushSnapshot("project-b", original, "owner-a");
  await first.pushSnapshot("project-a", snapshot("project-a", 1, "a\n"), "owner-a");

  // Both write and read boundaries must isolate adapter state from callers.
  assert.ok(original.files[0]);
  original.files[0].content = "mutated after push";
  const pulled = await first.pullSnapshot("project-b");
  assert.ok(pulled);
  assert.ok(pulled.files[0]);
  assert.equal(pulled.files[0].content, "export default 1;\n");
  pulled.files[0].content = "mutated after pull";
  const pulledAgain = await first.pullSnapshot("project-b");
  assert.ok(pulledAgain);
  assert.ok(pulledAgain.files[0]);
  assert.equal(
    pulledAgain.files[0].content,
    "export default 1;\n"
  );
  assert.deepEqual(await first.listRemoteProjectIds("owner-a"), [
    "project-a",
    "project-b"
  ]);

  // A new adapter instance recovers snapshots and the owner index from disk.
  const restarted = new FileRemoteBackup({ persistPath });
  const restartedSnapshot = await restarted.pullSnapshot("project-b");
  assert.ok(restartedSnapshot);
  assert.equal(restartedSnapshot.generation, 1);
  assert.deepEqual(await restarted.listRemoteProjectIds("owner-a"), [
    "project-a",
    "project-b"
  ]);

  // Overwrite replaces data and transfers ownership without stale index entries.
  await restarted.pushSnapshot(
    "project-b",
    snapshot("project-b", 2, "export default 2;\n"),
    "owner-b"
  );
  const overwritten = await restarted.pullSnapshot("project-b");
  assert.ok(overwritten);
  assert.equal(overwritten.generation, 2);
  assert.deepEqual(await restarted.listRemoteProjectIds("owner-a"), ["project-a"]);
  assert.deepEqual(await restarted.listRemoteProjectIds("owner-b"), ["project-b"]);

  await restarted.deleteProject("project-b");
  assert.equal(await restarted.pullSnapshot("project-b"), null);
  assert.deepEqual(await restarted.listRemoteProjectIds("owner-b"), []);
  assert.equal(
    fs.readdirSync(path.dirname(persistPath)).some((name) => name.endsWith(".tmp")),
    false
  );

  const persisted = JSON.parse(fs.readFileSync(persistPath, "utf8")) as {
    schemaVersion: number;
    kind: string;
    entries: Array<{ projectId: string }>;
  };
  assert.equal(persisted.schemaVersion, FILE_REMOTE_BACKUP_SCHEMA_VERSION);
  assert.equal(persisted.kind, "nuriteo.remote-backup");
  assert.deepEqual(persisted.entries.map((entry) => entry.projectId), ["project-a"]);

  const corruptPath = path.join(testDirectory, "corrupt.json");
  fs.writeFileSync(corruptPath, "{not json", "utf8");
  assert.throws(
    () => new FileRemoteBackup({ persistPath: corruptPath }),
    (error) =>
      error instanceof ServiceBackendError &&
      error.code === "EINVALID" &&
      error.message.includes("invalid file remote backup")
  );

  const unsupportedPath = path.join(testDirectory, "unsupported.json");
  fs.writeFileSync(
    unsupportedPath,
    JSON.stringify({
      schemaVersion: 999,
      kind: "nuriteo.remote-backup",
      entries: []
    }),
    "utf8"
  );
  assert.throws(
    () => new FileRemoteBackup({ persistPath: unsupportedPath }),
    (error) =>
      error instanceof ServiceBackendError &&
      error.code === "EINVALID" &&
      error.message.includes("unsupported schemaVersion 999")
  );

  await assert.rejects(
    () =>
      restarted.pushSnapshot(
        "wrong-project",
        snapshot("different-project", 1, "bad\n"),
        "owner-a"
      ),
    (error) => error instanceof ServiceBackendError && error.code === "EINVALID"
  );
} finally {
  fs.rmSync(testDirectory, { recursive: true, force: true });
}

console.log("service-backend file remote backup test ok");
