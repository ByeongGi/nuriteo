import assert from "node:assert/strict";

import { awaitWorkspaceStart } from "../src/runtime/workspace-start.ts";

{
  const controller = new AbortController();
  let revisionObservedAbort = false;
  let contentObservedAbort = false;
  const waiting = (mark: () => void) => new Promise<never>((_resolve, reject) => {
    controller.signal.addEventListener("abort", () => {
      mark();
      reject(new DOMException("aborted", "AbortError"));
    }, { once: true });
  });
  await assert.rejects(awaitWorkspaceStart(controller, {
    runtime: Promise.reject(new Error("runtime module failed")),
    revision: waiting(() => { revisionObservedAbort = true; }),
    content: waiting(() => { contentObservedAbort = true; })
  }), /runtime module failed/u);
  assert.equal(controller.signal.aborted, true);
  assert.equal(revisionObservedAbort, true);
  assert.equal(contentObservedAbort, true);
}

{
  const controller = new AbortController();
  assert.deepEqual(await awaitWorkspaceStart(controller, {
    runtime: Promise.resolve("runtime"),
    revision: Promise.resolve("revision"),
    content: Promise.resolve("content")
  }), ["runtime", "revision", "content"]);
  assert.equal(controller.signal.aborted, false);
}
