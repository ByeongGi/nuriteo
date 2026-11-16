import assert from "node:assert/strict";
import { readFileSync } from "node:fs";

import { loadContainerCase } from "./load-case.ts";
import {
  caseDirectory,
  filesWithPrefix,
  MISSING_PATH,
  publishedExamplePath,
  REPLACED_ENTRY,
  scriptSrcFromHtml,
  writeFilesInOrder
} from "./load-patterns.ts";
import { listWorkspace, memoryFilesystem, workspacePath } from "./memory-filesystem.ts";
import { MOUNT_CASE_BOOT_MS, mountCaseSource } from "./mount-source.ts";
import { containerCaseKinds, type ContainerCaseKind } from "./types.ts";

const markers: Record<ContainerCaseKind, string> = {
  spa: "spa-ready",
  next: "next-ready"
};

for (const kind of containerCaseKinds) {
  const project = await loadContainerCase(kind);
  assert.equal(project.kind, kind);
  const entry = project.files.find((file) => file.path === project.entry);
  assert.ok(entry, `${kind} entry`);
  assert.match(entry.contents, new RegExp(markers[kind]));
  assert.equal(project.files.some((file) => file.path.startsWith("/")), false);
}

const spa = await loadContainerCase("spa");
const next = await loadContainerCase("next");
assert.equal(spa.previewScript, null);
assert.equal(next.previewScript, "pnpm dev");
assert.match(mountCaseSource, /loadContainerCase\(kind\)/);
assert.match(mountCaseSource, /memoryFilesystem\(files\)/);
assert.match(mountCaseSource, /timeoutMs: 20_000/);
assert.match(mountCaseSource, /const status = container\.status;\nawait container\.teardown\(\)/);
assert.equal(MOUNT_CASE_BOOT_MS, 20_000);

const spaHtml = spa.files.find((file) => file.path === "index.html");
const nextLayout = next.files.find((file) => file.path === "app/layout.tsx");
assert.ok(spaHtml);
assert.ok(nextLayout);
assert.equal(scriptSrcFromHtml(spaHtml.contents), "src/main.js");
assert.equal(scriptSrcFromHtml(nextLayout.contents), null);
assert.equal(caseDirectory("spa"), "src/");
assert.equal(caseDirectory("next"), "app/");
assert.deepEqual(filesWithPrefix(spa.files, "src/").map((file) => file.path), ["src/main.js"]);
assert.deepEqual(filesWithPrefix(next.files, caseDirectory("next")).map((file) => file.path), ["app/layout.tsx", "app/page.tsx"]);
assert.equal(filesWithPrefix(spa.files, "src/").some((file) => file.path === "package.json"), false);

const scratch = new Map<string, string>();
const scratchFs = memoryFilesystem(scratch);
const written = await writeFilesInOrder(scratchFs, spa.files);
assert.deepEqual(written, spa.files.map((file) => workspacePath(file.path)));
const spaRoot = await scratchFs.readdir("/workspace");
assert.deepEqual(spaRoot.map((entry) => entry.path), ["/workspace/index.html", "/workspace/package.json", "/workspace/src"]);
assert.equal(spaRoot.find((entry) => entry.path === "/workspace/src")?.type, "directory");

let missingError: unknown;
try {
  await scratchFs.readFile(MISSING_PATH);
} catch (error) {
  missingError = error;
}
if (!(missingError instanceof Error)) throw new Error("missing path did not reject");
assert.equal(missingError.message, MISSING_PATH);
assert.equal(REPLACED_ENTRY, "replaced-entry\n");

for (const kind of containerCaseKinds) {
  const project = await loadContainerCase(kind);
  for (const file of project.files) {
    const published = publishedExamplePath(kind, file.path);
    const disk = readFileSync(new URL(`../../../public/${published}`, import.meta.url), "utf8");
    assert.equal(disk, file.contents, published);
  }
}

const files = new Map(next.files.map((file) => [workspacePath(file.path), file.contents]));
const filesystem = memoryFilesystem(files);
const page = await filesystem.readFile(workspacePath(next.entry));
assert.match(String(page), /next-ready/);
const root = await filesystem.readdir("/workspace");
assert.deepEqual(root.map((entry) => entry.path), ["/workspace/app", "/workspace/package.json"]);
assert.equal(root.find((entry) => entry.path === "/workspace/app")?.type, "directory");
const app = await filesystem.readdir("/workspace/app");
assert.deepEqual(app.map((entry) => `${entry.type}:${entry.path}`), [
  "file:/workspace/app/layout.tsx",
  "file:/workspace/app/page.tsx"
]);
assert.deepEqual(listWorkspace(files, "/workspace/src"), []);

console.log("container cases ok");
