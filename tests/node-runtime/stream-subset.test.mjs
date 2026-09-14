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
} from "../../packages/node-runtime/src/index.ts";
import { runUnsafeCommonJsForLocalTests } from "../../packages/node-runtime/src/bootstrap.ts";

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

const requireBuiltin = createBuiltinLoader({});
assert.equal(requireBuiltin("node:stream").Readable, RuntimeReadable);
assert.equal(requireBuiltin("stream/promises").pipeline, streamPromisesBuiltin.pipeline);

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
