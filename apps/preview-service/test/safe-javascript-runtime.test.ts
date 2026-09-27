import assert from "node:assert/strict";

import { SafeJavaScriptRuntime } from "../src/lib/safeJavaScriptRuntime.ts";

const output: string[] = [];
const runtime = new SafeJavaScriptRuntime(
  "file:///workspace/src/program.ts",
  [
    "function add(left: number, right: number) { return left + right; }",
    "let total = 0;",
    "for (let index = 0; index < 3; index++) { total += 1; }",
    "const answer = add(total, 2);",
    "console.log(answer);",
    ""
  ].join("\n"),
  (text) => output.push(text)
);

assert.deepEqual(runtime.instructions.map((instruction) => instruction.line), [2, 3, 4, 5]);
runtime.instructions.forEach((_instruction, index) => runtime.execute(index));
assert.deepEqual(
  runtime.variables().map(({ name, value }) => ({ name, value })),
  [{ name: "answer", value: "5" }, { name: "index", value: "3" }, { name: "total", value: "3" }]
);
assert.deepEqual(output, ["5"]);
assert.equal(runtime.evaluate("answer === 5"), true);
assert.throws(() => runtime.evaluate("answer = 9"), /Assignment is not allowed/);
assert.equal(runtime.evaluate("answer = 9", true), 9);
assert.equal(runtime.setVariable("total", "10"), 10);

assert.throws(
  () => new SafeJavaScriptRuntime("file:///outside/program.ts", "let value = 1;"),
  /inside file:\/\/\/workspace/
);
assert.throws(
  () => new SafeJavaScriptRuntime("file:///workspace/empty.ts", "export interface Empty {}"),
  /no executable top-level statements/
);

console.log("preview-service safe workspace JavaScript runtime ok");
