import assert from "node:assert/strict";
import { execFile } from "node:child_process";
import { promisify } from "node:util";

import { createScheduler } from "../../node-runtime/src/scheduler.ts";

const execFileAsync = promisify(execFile);

async function referenceNodeOrder() {
  const source = `
    const events = [];
    process.nextTick(() => events.push("nextTick"));
    Promise.resolve().then(() => events.push("promise"));
    setTimeout(() => {
      events.push("timer");
      console.log(JSON.stringify(events));
    }, 0);
  `;
  const { stdout } = await execFileAsync(process.execPath, ["-e", source]);
  return JSON.parse(stdout.trim());
}

const expectedOrder = await referenceNodeOrder();
const scheduler = createScheduler();
const events = [];
scheduler.nextTick(() => events.push("nextTick"));
scheduler.queuePromiseJob(() => events.push("promise"));
scheduler.setTimeout(() => events.push("timer"), 0);
const result = await scheduler.runUntilIdle();

assert.deepEqual(events, expectedOrder);
assert.equal(result.exitCode, 0);

const exitScheduler = createScheduler();
const exitEvents = [];
exitScheduler.nextTick(() => {
  exitEvents.push("before-exit");
  exitScheduler.process.exit(7);
});
exitScheduler.setTimeout(() => exitEvents.push("after-exit"), 0);
const exitResult = await exitScheduler.runUntilIdle();
assert.deepEqual(exitEvents, ["before-exit"]);
assert.equal(exitResult.exitCode, 7);
assert.equal(exitResult.exited, true);

const errorScheduler = createScheduler();
errorScheduler.nextTick(() => {
  throw new Error("boom");
});
const errorResult = await errorScheduler.runUntilIdle();
assert.equal(errorResult.exitCode, 1);
assert.equal(errorResult.uncaughtException.message, "boom");

const unrefScheduler = createScheduler();
const unrefEvents = [];
unrefScheduler.setTimeout(() => unrefEvents.push("timer"), 10).unref();
const unrefResult = await unrefScheduler.runUntilIdle();
assert.deepEqual(unrefEvents, []);
assert.equal(unrefResult.exitCode, 0);

const immediateScheduler = createScheduler();
const immediateEvents = [];
immediateScheduler.setImmediate(() => {
  immediateEvents.push("immediate");
  immediateScheduler.nextTick(() => immediateEvents.push("nextTick-after-immediate"));
});
await immediateScheduler.runUntilIdle();
assert.deepEqual(immediateEvents, ["immediate", "nextTick-after-immediate"]);

const boundedScheduler = createScheduler({ maxCallbacksPerRun: 3, yieldEveryCallbacks: 1 });
const enqueueForever = () => boundedScheduler.nextTick(enqueueForever);
boundedScheduler.nextTick(enqueueForever);
const boundedResult = await boundedScheduler.runUntilIdle();
assert.equal(boundedResult.exitCode, 1);
assert.equal(boundedResult.uncaughtException.code, "ERR_NURITEO_SCHEDULER_LIMIT");

console.log("node scheduler test ok");
