import sqlite3InitModule from "/node_modules/@sqlite.org/sqlite-wasm/dist/index.mjs";

self.addEventListener("message", async (event) => {
  const { id, action, database = "project", phase, projectId = "fixture", values = ["committed"] } = event.data || {};
  try {
    if (!/^[a-zA-Z0-9][a-zA-Z0-9._-]{0,127}$/.test(projectId) || !/^[a-zA-Z0-9][a-zA-Z0-9._-]{0,127}$/.test(database)) {
      throw new Error("Invalid project-scoped SQLite namespace");
    }
    const databasePath = `/nuriteo-${projectId}-${database}.sqlite3`;
    const diagnostics = [];
    const originalWarn = console.warn;
    const originalError = console.error;
    console.warn = (...args) => diagnostics.push(args.map(String).join(" "));
    console.error = (...args) => diagnostics.push(args.map(String).join(" "));
    const sqlite3 = await sqlite3InitModule({
      print() {},
      printErr(...args) {
        diagnostics.push(args.map(String).join(" "));
      }
    });
    console.warn = originalWarn;
    console.error = originalError;
    if (typeof sqlite3.oo1?.OpfsDb !== "function") {
      const capabilities = JSON.stringify({
        crossOriginIsolated: globalThis.crossOriginIsolated,
        sharedArrayBuffer: typeof SharedArrayBuffer,
        storageDirectory: typeof navigator.storage?.getDirectory,
        syncAccessHandle: typeof globalThis.FileSystemFileHandle?.prototype?.createSyncAccessHandle
      });
      throw new Error(`SQLite OPFS VFS is unavailable: ${diagnostics.join(" | ") || "no diagnostic"}; ${capabilities}`);
    }

    const shouldWrite = action === "replace-values" || phase === "write";
    const db = new sqlite3.oo1.OpfsDb(databasePath, shouldWrite ? "c" : undefined);
    try {
      if (shouldWrite) {
        db.exec("DROP TABLE IF EXISTS durability_fixture");
        db.exec("CREATE TABLE durability_fixture (value TEXT NOT NULL)");
        db.exec("BEGIN");
        for (const value of values) db.exec({ sql: "INSERT INTO durability_fixture VALUES (?)", bind: [String(value)] });
        db.exec("COMMIT");
        db.exec("BEGIN; INSERT INTO durability_fixture VALUES ('rolled-back'); ROLLBACK;");
      }
      const rows = [];
      db.exec({
        sql: "SELECT value FROM durability_fixture ORDER BY rowid",
        rowMode: "object",
        callback(row) {
          rows.push(row.value);
        }
      });
      self.postMessage({ id, ok: true, rows, sqliteVersion: sqlite3.version.libVersion, databasePath });
    } finally {
      db.close();
    }
  } catch (error) {
    self.postMessage({ id, ok: false, error: error instanceof Error ? error.message : String(error) });
  }
});
