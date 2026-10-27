import assert from "node:assert/strict";

import { planProjectContentReplace } from "../src/projects/studio-content-replace.ts";

const files = [
  { kind: "text", path: "src/App.tsx" },
  { kind: "text", path: "src/main.tsx" },
  { kind: "binary", path: "public/logo.png" }
];
const sources = new Map([
  ["src/App.tsx", "export const title = \"Hello\";\n"],
  ["src/main.tsx", "console.log(\"hello\");\n"],
  ["public/logo.png", "Hello"]
]);

const literal = planProjectContentReplace({
  files,
  matchCase: false,
  query: "hello",
  readText: (path) => sources.get(path) ?? "",
  replacement: "안녕",
  useRegularExpression: false
});

assert.equal(literal.error, undefined);
assert.deepEqual(literal.updates, [
  { content: "export const title = \"안녕\";\n", path: "src/App.tsx", replacements: 1 },
  { content: "console.log(\"안녕\");\n", path: "src/main.tsx", replacements: 1 }
]);

const unsaved = planProjectContentReplace({
  files,
  matchCase: true,
  query: "draft",
  readText: () => "saved",
  replacement: "kept",
  selectedContent: "draft",
  selectedPath: "src/App.tsx",
  useRegularExpression: false
});

assert.deepEqual(unsaved.updates, [
  { content: "kept", path: "src/App.tsx", replacements: 1 }
]);

const invalid = planProjectContentReplace({
  files,
  matchCase: false,
  query: "(",
  readText: (path) => sources.get(path) ?? "",
  replacement: "",
  useRegularExpression: true
});

assert.equal(invalid.error, "올바른 정규식을 입력하세요.");
assert.deepEqual(invalid.updates, []);

console.log("studio content replace plans literal, unsaved, and invalid searches");
