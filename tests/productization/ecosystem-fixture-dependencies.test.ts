import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import {
  collectProjectDependencyNames,
  readProjectDependencyNames
} from "../../tooling/shared/ecosystem-fixture-dependencies.ts";

const manifest = {
  dependencies: {
    react: "^18.3.1",
    shared: "1.0.0"
  },
  devDependencies: {
    shared: "1.0.0",
    tailwindcss: "^3.4.14",
    vite: "^5.4.10"
  },
  optionalDependencies: {
    sass: "^1.80.6"
  }
};
const expectedNames = ["react", "sass", "shared", "tailwindcss"];

assert.deepEqual(collectProjectDependencyNames(manifest), expectedNames);

const fixtureDir = fs.mkdtempSync(path.join(os.tmpdir(), "ecosystem-fixture-dependencies-"));
try {
  fs.writeFileSync(path.join(fixtureDir, "package.json"), JSON.stringify(manifest));
  assert.deepEqual(readProjectDependencyNames(fixtureDir), expectedNames);
  assert.deepEqual(readProjectDependencyNames(path.join(fixtureDir, "missing")), []);
} finally {
  fs.rmSync(fixtureDir, { recursive: true, force: true });
}

console.log("ecosystem fixture dependencies test ok");
