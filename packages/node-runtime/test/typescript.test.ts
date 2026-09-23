import assert from "node:assert/strict";
import fs from "node:fs";

import { originalPositionFor, transpileTypeScript } from "../../node-runtime/src/transforms/index.ts";

const fixtureUrl = new URL("../../../tests/fixtures/modules/source-map-input.ts", import.meta.url);
const source = fs.readFileSync(fixtureUrl, "utf8");
const output = transpileTypeScript(source, {
  fileName: "/workspace/source-map-input.ts"
});

assert.equal(output.diagnostics.length, 0);
assert.equal(output.map.version, 3);
assert.ok(output.map.sources.includes("source-map-input.ts"));
assert.ok(output.map.sourcesContent[0].includes("SourceRecord"));
assert.ok(!output.code.includes(": SourceRecord"));
assert.ok(output.code.includes("describeSource"));

const generatedLines = output.code.split("\n");
const returnLineIndex = generatedLines.findIndex((line) => line.includes("return `${record.name}:${record.count}`"));
assert.ok(returnLineIndex >= 0, "generated return line exists");
const original = originalPositionFor(output.map, returnLineIndex + 1, generatedLines[returnLineIndex].indexOf("return"));
assert.equal(original.source, "source-map-input.ts");
assert.equal(original.line, 7);

const bad = transpileTypeScript("export const broken: = 1;", {
  fileName: "/workspace/broken.ts"
});
assert.ok(bad.diagnostics.length > 0);
assert.equal(bad.diagnostics[0].fileName, "/workspace/broken.ts");
assert.equal(bad.diagnostics[0].line, 1);

console.log("node typescript transform test ok");
