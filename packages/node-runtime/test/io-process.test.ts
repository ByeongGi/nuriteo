import assert from "node:assert/strict";

import {
  BrokenPipeError,
  BoundedPipe,
  spawnRuntimeChild,
  startRuntimeThread,
  WouldBlockError
} from "../../node-runtime/src/index.ts";

const pipe = new BoundedPipe(3);
assert.equal(pipe.write(new Uint8Array([0, 1, 255, 4])), 3);
assert.throws(() => pipe.write(new Uint8Array([9])), WouldBlockError);
assert.deepEqual([...pipe.read(2)], [0, 1]);
assert.equal(pipe.write(new Uint8Array([4])), 1);
assert.deepEqual([...pipe.read(8)], [255, 4]);

pipe.closeReader();
assert.throws(() => pipe.write(new Uint8Array([1])), BrokenPipeError);

const child = spawnRuntimeChild({
  pid: 10,
  parent: 1,
  stdioCapacity: 4,
  entrypoint({ process, stdio }) {
    const written = stdio.stdout.write(new Uint8Array([65, 66, 67, 68, 69]));
    process.exit(written);
  }
});
const childResult = await child.wait();
assert.equal(childResult.exitCode, 4);
assert.throws(() => child.stdio.stdout.write(new Uint8Array([90])), WouldBlockError);
assert.deepEqual([...child.stdio.stdout.read(4)], [65, 66, 67, 68]);

let parentBlocked = true;
const blockedParentChild = spawnRuntimeChild({
  pid: 11,
  parent: 1,
  entrypoint({ process }) {
    process.exit(parentBlocked ? 0 : 1);
  }
});
const threadRun = startRuntimeThread({
  pid: 11,
  entrypoint({ threadId, pid }) {
    return { threadId, pid };
  }
});
const blockedResult = await blockedParentChild.wait();
const threadResult = await threadRun.completion;
parentBlocked = false;

assert.equal(blockedResult.exitCode, 0);
assert.equal(threadRun.thread.pid, 11);
assert.notEqual(threadResult.threadId, threadResult.pid);
assert.equal(threadResult.pid, 11);

const syncChild = spawnRuntimeChild({
  pid: 12,
  entrypoint({ process }) {
    process.exit(12);
  }
});
const syncWait = await syncChild.waitSync();
assert.equal(syncWait.exitCode, 12);

console.log("node io process test ok");
