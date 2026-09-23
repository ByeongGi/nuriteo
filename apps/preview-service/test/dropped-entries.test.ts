import assert from "node:assert/strict";
import { collectDroppedEntries } from "../src/lib/droppedEntries.ts";

function fakeFile(name, contents = "") {
  return {
    name,
    size: contents.length,
    text: async () => contents,
    type: "text/plain",
  };
}

function fileEntry(name, contents = "") {
  return {
    isDirectory: false,
    isFile: true,
    name,
    file(resolve) {
      resolve(fakeFile(name, contents));
    },
  };
}

function directoryEntry(name, batches) {
  return {
    isDirectory: true,
    isFile: false,
    name,
    createReader() {
      let index = 0;
      return {
        readEntries(resolve) {
          resolve(batches[index++] || []);
        },
      };
    },
  };
}

function transferItem(entry, fallbackFile = null) {
  return {
    kind: "file",
    getAsFile: () => fallbackFile,
    webkitGetAsEntry: () => entry,
  };
}

const nested = directoryEntry("project", [
  [
    fileEntry("package.json", "{}"),
    directoryEntry("src", [
      [fileEntry("main.ts", "export {}")],
      [fileEntry("empty.ts", "")],
      [],
    ]),
  ],
  [directoryEntry("empty", [[]])],
  [],
]);

const recursive = await collectDroppedEntries({
  files: [],
  items: [
    transferItem(nested),
    transferItem(fileEntry("package.json", "first")),
    transferItem(fileEntry("package.json", "duplicate")),
  ],
});
assert.deepEqual(
  recursive.files.map(({ relativePath }) => relativePath),
  [
    "package.json",
    "project/package.json",
    "project/src/empty.ts",
    "project/src/main.ts",
  ],
);
assert.deepEqual(recursive.directories, [
  "project",
  "project/empty",
  "project/src",
]);
assert.equal(await recursive.files[2].file.text(), "");
assert.equal(await recursive.files[0].file.text(), "first");
assert.deepEqual(recursive.errors, []);

const duplicate = fakeFile("same.ts", "first");
Object.defineProperty(duplicate, "webkitRelativePath", {
  value: "folder/same.ts",
});
const duplicateAgain = fakeFile("same.ts", "second");
Object.defineProperty(duplicateAgain, "webkitRelativePath", {
  value: "folder/same.ts",
});
const traversal = fakeFile("escape.ts", "safe");
Object.defineProperty(traversal, "webkitRelativePath", {
  value: "../safe/escape.ts",
});

const fallback = await collectDroppedEntries([
  duplicate,
  duplicateAgain,
  traversal,
]);
assert.deepEqual(
  fallback.files.map(({ relativePath }) => relativePath),
  ["folder/same.ts", "safe/escape.ts"],
);
assert.equal(await fallback.files[0].file.text(), "first");

const nullEntryFallback = fakeFile("fallback.ts", "fallback");
const mixed = await collectDroppedEntries({
  files: [nullEntryFallback],
  items: [transferItem(null, nullEntryFallback)],
});
assert.deepEqual(
  mixed.files.map(({ relativePath }) => relativePath),
  ["fallback.ts"],
);

const relativeFallback = fakeFile("main.ts", "relative");
Object.defineProperty(relativeFallback, "webkitRelativePath", {
  value: "project/src/main.ts",
});
const withoutEntryApi = await collectDroppedEntries({
  files: [relativeFallback],
  items: [transferItem(null, relativeFallback)],
});
assert.deepEqual(
  withoutEntryApi.files.map(({ relativePath }) => relativePath),
  ["project/src/main.ts"],
);

console.log("preview service dropped entries ok");
