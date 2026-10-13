import assert from "node:assert/strict";

import {
  Buffer as RuntimeBuffer,
  createBuiltinLoader,
  EventEmitter,
  IncomingMessage,
  utilBuiltin
} from "../../node-runtime/src/index.ts";
import { runUnsafeCommonJsForLocalTests } from "../../node-runtime/src/bootstrap.ts";

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
  assert.equal(Buffer.isEncoding("utf8"), true);
  assert.equal(Buffer.isEncoding("definitely-not-an-encoding"), false);

  const sliced = fromUtf8.slice(1, 3);
  sliced[0] = 65;
  assert.equal(fromUtf8.toString(), "hAllo");
  const target = Buffer.alloc(5);
  assert.equal(Buffer.from("abc").copy(target, 1), 3);
  assert.equal(target.slice(1, 4).toString(), "abc");
  assert.equal(Buffer.from("abc").equals(Buffer.from("abc")), true);
  const shared = new SharedArrayBuffer(3);
  new Uint8Array(shared).set([1, 2, 3]);
  assert.deepEqual([...Buffer.from(shared)], [1, 2, 3]);
  const numeric = Buffer.alloc(29);
  assert.equal(numeric.writeInt8(-2, 0), 1);
  assert.equal(numeric.writeInt32LE(-123456, 1), 5);
  assert.equal(numeric.writeDoubleLE(3.25, 5), 13);
  assert.equal(numeric.writeBigUInt64LE(0x0102030405060708n, 13), 21);
  assert.equal(numeric.readInt8(0), -2);
  assert.equal(numeric.readInt32LE(1), -123456);
  assert.equal(numeric.readDoubleLE(5), 3.25);
  assert.equal(numeric.readBigUInt64LE(13), 0x0102030405060708n);
  assert.equal(RuntimeBuffer.from("89504e47", "hex").readUInt32BE(0), 0x89504e47);

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
  assert.equal(util.formatWithOptions({ colors: false }, "value:%s", "x"), "value:x");
  assert.deepEqual(util.parseEnv("A=1\nexport B=\"two\\nlines\"\nC=three # comment\n# ignored"), {
    A: "1",
    B: "two\nlines",
    C: "three"
  });
  assert.equal(util.styleText("bold", "value"), "value");
  assert.equal(util.styleText(["cyan", "bold"], "value"), "value");
  assert.match(util.inspect(new Error("boom")), /Error: boom/);
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

const hostBuffer = globalThis.Buffer;
try {
  globalThis.Buffer = undefined;
  assert.equal(RuntimeBuffer.from("aGk", "base64").toString(), "hi");
  assert.equal(RuntimeBuffer.from("aGk= \n#", "base64").toString(), "hi");
  assert.equal(RuntimeBuffer.from("_w", "base64").toString("hex"), "ff");
  assert.equal(RuntimeBuffer.from("a", "base64").byteLength, 0);
} finally {
  globalThis.Buffer = hostBuffer;
}

try {
  globalThis.Buffer = RuntimeBuffer;
  assert.equal(RuntimeBuffer.from("self-hosted").toString("base64"), "c2VsZi1ob3N0ZWQ=");
  assert.equal(RuntimeBuffer.from("c2VsZi1ob3N0ZWQ=", "base64").toString(), "self-hosted");
} finally {
  globalThis.Buffer = hostBuffer;
}

const requireBuiltin = createBuiltinLoader({});
const bufferBuiltin = requireBuiltin("node:buffer");
assert.equal(bufferBuiltin.Buffer.from("ok").toString(), "ok");
assert.equal(bufferBuiltin.Blob, Blob);
assert.equal(bufferBuiltin.File, File);
const inflated = requireBuiltin("node:zlib").gunzipSync(requireBuiltin("node:zlib").gzipSync(RuntimeBuffer.from("ok")));
assert.equal(typeof inflated.copy, "function");
assert.equal(inflated.toString("utf8", 0, 2), "ok");
assert.equal(typeof requireBuiltin("events"), "function");
assert.equal(requireBuiltin("events").EventEmitter, requireBuiltin("events"));
const LegacyEventEmitter = requireBuiltin("events");
function LegacyChild() {
  LegacyEventEmitter.call(this);
}
Object.setPrototypeOf(LegacyChild.prototype, LegacyEventEmitter.prototype);
const legacyEmitter = new LegacyChild();
assert.equal(legacyEmitter instanceof requireBuiltin("events"), true);
assert.equal(new EventEmitter() instanceof requireBuiltin("events"), true);
legacyEmitter.on("tick", () => true);
assert.equal(legacyEmitter.emit("tick"), true);
assert.equal(requireBuiltin("util").format("x:%s", "y"), "x:y");
assert.equal(requireBuiltin("node:util").formatWithOptions({ colors: false }, "x:%s", "y"), "x:y");
assert.equal(requireBuiltin("node:util").styleText("bold", "x"), "x");
assert.equal(requireBuiltin("node:util").types.isProxy({}), false);

const streamBuiltin = requireBuiltin("node:stream");
const bufferedSource = new streamBuiltin.Readable();
bufferedSource.push(RuntimeBuffer.from("late"));
bufferedSource.push(null);
const bufferedTransform = bufferedSource.pipe(new streamBuiltin.Transform({
  transform(chunk, _encoding, callback) {
    callback(null, chunk);
  }
}));
let bufferedOutput = "";
await new Promise((resolve) => {
  bufferedTransform.on("data", (chunk) => {
    bufferedOutput += chunk.toString();
  });
  bufferedTransform.on("end", resolve);
});
assert.equal(bufferedOutput, "late");

const iteratedSource = new streamBuiltin.Readable();
const iteratedChunks = [];
const iterate = (async () => {
  for await (const chunk of iteratedSource) iteratedChunks.push(chunk.toString());
})();
iteratedSource.push(RuntimeBuffer.from("async"));
iteratedSource.push(null);
await iterate;
assert.deepEqual(iteratedChunks, ["async"]);

const replacedRequest = new streamBuiltin.Readable();
const clonedBody = new streamBuiltin.PassThrough();
replacedRequest.on("data", (chunk) => clonedBody.push(chunk));
replacedRequest.on("end", () => clonedBody.push(null));
replacedRequest.push(RuntimeBuffer.from("cloned"));
replacedRequest.push(null);
await Promise.resolve();
for (const key in clonedBody) replacedRequest[key] = clonedBody[key];
const replacedChunks = [];
for await (const chunk of replacedRequest) replacedChunks.push(chunk.toString());
assert.deepEqual(replacedChunks, ["cloned"]);

const incomingRequest = new IncomingMessage({
  body: RuntimeBuffer.from("[]"),
  headers: { "content-type": "text/plain;charset=UTF-8" },
  method: "POST",
  statusCode: 0,
  url: "/action"
});
const clonedIncomingBody = new streamBuiltin.PassThrough();
incomingRequest.on("data", (chunk) => clonedIncomingBody.push(chunk));
const incomingEnded = new Promise((resolve) => {
  incomingRequest.on("end", () => {
    clonedIncomingBody.push(null);
    resolve();
  });
});
await incomingEnded;
for (const key in clonedIncomingBody) {
  const value = clonedIncomingBody[key];
  incomingRequest[key] = typeof value === "function" ? value.bind(incomingRequest) : value;
}
const incomingChunks = [];
for await (const chunk of incomingRequest) incomingChunks.push(chunk);
assert.equal(RuntimeBuffer.concat(incomingChunks).toString(), "[]");

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
    formatted: util.format("%s:%d", "v", 2),
    formattedWithOptions: util.formatWithOptions({ colors: false }, "%s:%d", "v", 3)
  };
`, { syncChannel: new SharedArrayBuffer(1024 * 1024 + 4096) });

assert.deepEqual(result.exports, {
  text: "hi",
  eventsDefaultIsConstructor: true,
  count: 1,
  formatted: "v:2",
  formattedWithOptions: "v:3"
});

console.log("node builtin subset test ok");
