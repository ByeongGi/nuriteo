import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

import {
  evaluatePureExpression,
  findNestedTernaries,
  flattenNestedTernaries,
  listTypeScriptFiles
} from "./nested-ternary.ts";

const webRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "../..");
const sourceRoot = path.join(webRoot, "src");

testWebSourceHasNoNestedConditionalTernary();
testFlattenPreservesTrickyValues();

function testWebSourceHasNoNestedConditionalTernary(): void {
  const hits = listTypeScriptFiles(sourceRoot).flatMap((filePath) =>
    findNestedTernaries(filePath, readFileSync(filePath, "utf8"))
  );
  assert.deepEqual(hits, [], hits.map((hit) => `${hit.file}:${hit.line}`).join("\n"));
  console.log("nested conditional ternaries: 0");
}

function testFlattenPreservesTrickyValues(): void {
  const cases = [
    {
      expression: `level === "error" ? "error" : level === "warning" || level === "warn" ? "warning" : "info"`,
      bindings: { level: "warn" }
    },
    {
      expression: `(ready ? "ok" : null) ?? (failed ? "bad" : "pending")`,
      bindings: { ready: false, failed: false }
    },
    {
      expression: `left && right ? nested ? 1 : 2 : 3`,
      bindings: { left: true, right: true, nested: false }
    },
    {
      expression: `label === "" ? fallback : label === "create" ? "새 항목" : label`,
      bindings: { label: "create", fallback: "기본" }
    }
  ];
  for (const item of cases) {
    const source = `export const value = ${item.expression};`;
    const flattened = flattenNestedTernaries("fixture.ts", source);
    const flattenedExpression = flattened.replace(/^export const value = /u, "").replace(/;$/u, "");
    assert.equal(findNestedTernaries("fixture.ts", flattened).length, 0);
    assert.equal(
      evaluatePureExpression(flattenedExpression, item.bindings),
      evaluatePureExpression(item.expression, item.bindings)
    );
  }
}
