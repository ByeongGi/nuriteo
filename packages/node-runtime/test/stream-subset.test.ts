import assert from "node:assert/strict";

import {
  createBuiltinLoader,
  PassThrough as RuntimePassThrough,
  Readable as RuntimeReadable,
  Transform as RuntimeTransform,
  Writable as RuntimeWritable,
  finished as runtimeFinished,
  pipeline as runtimePipeline,
  streamPromisesBuiltin
} from "../../node-runtime/src/index.ts";
import { runUnsafeCommonJsForLocalTests } from "../../node-runtime/src/bootstrap.ts";

async function collect(readable) {
  const chunks = [];
  for await (const chunk of readable) chunks.push(String(chunk));
  return chunks;
}

async function exerciseStreams({ Readable, Writable, Transform, PassThrough, finished, pipeline, promises }) {
  assert.deepEqual(await collect(Readable.from(["a", "b", "c"])), ["a", "b", "c"]);

  const passThrough = new PassThrough();
  const passed = [];
  passThrough.on("data", (chunk) => passed.push(String(chunk)));
  passThrough.write("x");
  passThrough.end("y");
  assert.deepEqual(passed, ["x", "y"]);

  const upper = new Transform({
    transform(chunk, _encoding, callback) {
      callback(null, String(chunk).toUpperCase());
    },
    flush(callback) {
      callback(null, "!");
    }
  });
  const transformed = [];
  upper.on("data", (chunk) => transformed.push(String(chunk)));
  upper.write("a");
  upper.end("b");
  assert.deepEqual(transformed, ["A", "B", "!"]);

  const sinkOutput = [];
  const sink = new Writable({
    write(chunk, _encoding, callback) {
      sinkOutput.push(String(chunk));
      callback();
    }
  });
  Readable.from(["h", "i"]).pipe(sink);
  await finished(sink);
  assert.deepEqual(sinkOutput, ["h", "i"]);

  const pipelineOutput = [];
  await promises.pipeline(
    Readable.from(["o", "k"]),
    new Transform({
      transform(chunk, _encoding, callback) {
        callback(null, `${chunk}.`);
      }
    }),
    new Writable({
      write(chunk, _encoding, callback) {
        pipelineOutput.push(String(chunk));
        callback();
      }
    })
  );
  assert.deepEqual(pipelineOutput, ["o.", "k."]);

  await new Promise((resolve, reject) => {
    pipeline(
      Readable.from(["z"]),
      new Writable({
        write(chunk, _encoding, callback) {
          assert.equal(String(chunk), "z");
          callback();
        }
      }),
      (error) => error ? reject(error) : resolve()
    );
  });
}

const nodeStream = await import("node:stream");
const nodeStreamPromises = await import("node:stream/promises");
await exerciseStreams({
  Readable: nodeStream.Readable,
  Writable: nodeStream.Writable,
  Transform: nodeStream.Transform,
  PassThrough: nodeStream.PassThrough,
  finished: nodeStreamPromises.finished,
  pipeline: nodeStream.pipeline,
  promises: nodeStreamPromises
});

await exerciseStreams({
  Readable: RuntimeReadable,
  Writable: RuntimeWritable,
  Transform: RuntimeTransform,
  PassThrough: RuntimePassThrough,
  finished: runtimeFinished,
  pipeline: runtimePipeline,
  promises: streamPromisesBuiltin
});

const encoded = new RuntimeReadable();
const encodedChunks = [];
encoded.setEncoding("utf8");
encoded.on("data", (chunk) => encodedChunks.push(chunk));
encoded.push(new TextEncoder().encode("hi"));
encoded.push(null);
assert.deepEqual(encodedChunks, ["hi"]);

const binary = new RuntimeReadable();
binary.push(new Uint8Array([1, 2, 3]));
binary.push(null);
const binaryChunks = [];
for await (const chunk of binary) binaryChunks.push(chunk);
assert.equal(typeof binaryChunks[0].copy, "function");
assert.equal(binaryChunks[0].toString("hex"), "010203");

const latePipeReadable = new RuntimeReadable();
latePipeReadable.push("late");
latePipeReadable.push(null);
const latePipeOutput = [];
latePipeReadable.pipe(new RuntimeWritable({
  write(chunk, _encoding, callback) {
    latePipeOutput.push(String(chunk));
    callback();
  }
}));
assert.deepEqual(latePipeOutput, ["late"]);

class PullReadable extends RuntimeReadable {
  reads = 0;

  _read() {
    this.reads += 1;
    this.push("pulled");
    this.push(null);
  }
}

const pullReadable = new PullReadable({ objectMode: true });
const pulled = [];
pullReadable.on("data", (chunk) => pulled.push(String(chunk)));
await new Promise((resolve) => pullReadable.once("end", resolve));
assert.deepEqual(pulled, ["pulled"]);
assert.equal(pullReadable.reads, 1);

const requireBuiltin = createBuiltinLoader({});
const LegacyReadable = requireBuiltin("node:stream").Readable;
assert.equal(LegacyReadable.prototype, RuntimeReadable.prototype);
const legacyReadableTarget = Object.create(LegacyReadable.prototype);
LegacyReadable.call(legacyReadableTarget, { highWaterMark: 64 * 1024 });
assert.equal(legacyReadableTarget._readableState.highWaterMark, 64 * 1024);
assert.equal(typeof legacyReadableTarget.push, "function");
assert.equal(typeof requireBuiltin("stream"), "function");
assert.equal(requireBuiltin("stream").Stream, requireBuiltin("stream"));
assert.equal(new RuntimePassThrough() instanceof requireBuiltin("stream"), true);
const legacyStream = new (requireBuiltin("stream"))();
const legacyListener = () => undefined;
legacyStream.on("readable", legacyListener);
assert.equal(legacyStream.listenerCount("readable"), 1);
assert.deepEqual(legacyStream.listeners("readable"), [legacyListener]);
legacyStream.removeAllListeners("readable");
assert.equal(legacyStream.listenerCount("readable"), 0);
assert.equal(requireBuiltin("stream/promises").pipeline, streamPromisesBuiltin.pipeline);
assert.equal(requireBuiltin("node:zlib").Z_SYNC_FLUSH, 2);
assert.equal(typeof requireBuiltin("zlib").createGunzip().write, "function");
assert.equal(requireBuiltin("zlib").createDeflate() instanceof requireBuiltin("zlib").Deflate, true);
const streamCompressed = requireBuiltin("zlib").gzipSync(new TextEncoder().encode("streamed-tarball"));
const streamGunzip = requireBuiltin("zlib").createGunzip();
const streamInflated = [];
streamGunzip.on("data", (chunk) => streamInflated.push(chunk));
assert.equal(streamGunzip.writable, true);
streamGunzip.write(streamCompressed.subarray(0, 5));
streamGunzip.end(streamCompressed.subarray(5));
assert.equal(streamGunzip.writable, false);
assert.equal(new TextDecoder().decode(requireBuiltin("buffer").Buffer.concat(streamInflated)), "streamed-tarball");

const result = runUnsafeCommonJsForLocalTests(`
  const { Readable, Transform, Writable } = require("node:stream");
  const { pipeline } = require("node:stream/promises");
  const output = [];
  module.exports = pipeline(
    Readable.from(["a", "b"]),
    new Transform({
      transform(chunk, _encoding, callback) {
        callback(null, String(chunk).toUpperCase());
      }
    }),
    new Writable({
      write(chunk, _encoding, callback) {
        output.push(String(chunk));
        callback();
      }
    })
  ).then(() => output.join(""));
`, { syncChannel: new SharedArrayBuffer(1024 * 1024 + 4096) });

assert.equal(await result.exports, "AB");

console.log("node stream subset test ok");
