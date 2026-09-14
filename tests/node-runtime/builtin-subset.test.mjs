import assert from "node:assert/strict";

import {
  Buffer as RuntimeBuffer,
  createBuiltinLoader,
  EventEmitter,
  utilBuiltin
} from "../../packages/node-runtime/src/index.ts";
import { runUnsafeCommonJsForLocalTests } from "../../packages/node-runtime/src/bootstrap.ts";

function exerciseBuiltins({ Buffer, EventEmitter, util }) {
  const fromUtf8 = Buffer.from("hello", "utf8");
  assert.equal(fromUtf8.toString("hex"), "68656c6c6f");
  assert.equal(Buffer.from("6869", "hex").toString(), "hi");
  assert.equal(Buffer.from("aGk=", "base64").toString(), "hi");

  const allocated = Buffer.alloc(4, "a");
  assert.equal(allocated.toString(), "aaaa");
  assert.equal(Buffer.byteLength("hé"), 3);
  assert.equal(Buffer.concat([Buffer.from("he"), Buffer.from("llo")]).toString(), "hello");
  assert.equal(Buffer.isBuffer(fromUtf8), true);

  const sliced = fromUtf8.slice(1, 3);
  sliced[0] = 65;
  assert.equal(fromUtf8.toString(), "hAllo");
  const target = Buffer.alloc(5);
  assert.equal(Buffer.from("abc").copy(target, 1), 3);
  assert.equal(target.slice(1, 4).toString(), "abc");
  assert.equal(Buffer.from("abc").equals(Buffer.from("abc")), true);

  const emitter = new EventEmitter();
  const events = [];
  function listener(value) {
    events.push(`on:${value}:${this === emitter}`);
  }
  emitter.on("data", listener);
  emitter.once("data", (value) => events.push(`once:${value}`));
  assert.equal(emitter.emit("data", 1), true);
  assert.equal(emitter.emit("data", 2), true);
  assert.equal(emitter.listenerCount("data"), 1);
  emitter.off("data", listener);
  assert.equal(emitter.emit("data", 3), false);
  assert.deepEqual(events, ["on:1:true", "once:1", "on:2:true"]);
  assert.throws(() => new EventEmitter().emit("error", new Error("boom")), /boom/);

  assert.equal(util.format("value:%s %d %%", "x", "4"), "value:x 4 %");
  assert.match(util.inspect({ a: 1, b: "x" }), /a: 1/);
  function Parent() {}
  Parent.prototype.kind = "parent";
  function Child() {}
  util.inherits(Child, Parent);
  assert.equal(new Child().kind, "parent");
  assert.equal(util.types.isDate(new Date()), true);
  assert.equal(util.types.isTypedArray(new Uint8Array()), true);

  return true;
}

exerciseBuiltins({
  Buffer,
  EventEmitter: (await import("node:events")).EventEmitter,
  util: await import("node:util")
});

exerciseBuiltins({
  Buffer: RuntimeBuffer,
  EventEmitter,
  util: utilBuiltin
});

const requireBuiltin = createBuiltinLoader({});
const bufferBuiltin = requireBuiltin("node:buffer");
assert.equal(bufferBuiltin.Buffer.from("ok").toString(), "ok");
assert.equal(typeof requireBuiltin("events"), "function");
assert.equal(requireBuiltin("events").EventEmitter, EventEmitter);
assert.equal(requireBuiltin("util").format("x:%s", "y"), "x:y");

const result = runUnsafeCommonJsForLocalTests(`
  const { Buffer } = require("node:buffer");
  const EventEmitterModule = require("node:events");
  const { EventEmitter } = EventEmitterModule;
  const util = require("node:util");
  const emitter = new EventEmitter();
  let count = 0;
  emitter.once("tick", () => { count += 1; });
  emitter.emit("tick");
  emitter.emit("tick");
  module.exports = {
    text: Buffer.from("6869", "hex").toString("utf8"),
    eventsDefaultIsConstructor: typeof EventEmitterModule === "function",
    count,
    formatted: util.format("%s:%d", "v", 2)
  };
`, { syncChannel: new SharedArrayBuffer(1024 * 1024 + 4096) });

assert.deepEqual(result.exports, {
  text: "hi",
  eventsDefaultIsConstructor: true,
  count: 1,
  formatted: "v:2"
});

console.log("node builtin subset test ok");
