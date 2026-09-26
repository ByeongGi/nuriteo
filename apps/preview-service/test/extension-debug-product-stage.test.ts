import assert from "node:assert/strict";

import { FixtureDebugAdapter } from "../src/lib/dapServer.ts";
import type { DapEvent, DapRequest, DapResponse } from "../src/lib/dapProtocol.ts";
import { ExtensionWorkerServer } from "../src/lib/extensionWorkerServer.ts";
import {
  assertExtensionCapability,
  BUILTIN_WORKSPACE_TOOLS_MANIFEST,
  verifyExtensionManifest
} from "../src/lib/extensionManifest.ts";
import type { JsonRpcMessage, JsonRpcResponse } from "../src/lib/lspProtocol.ts";

await verifyExtensionManifest(BUILTIN_WORKSPACE_TOOLS_MANIFEST);
await assert.rejects(
  verifyExtensionManifest({ ...BUILTIN_WORKSPACE_TOOLS_MANIFEST, version: "1.0.1" }),
  /signature is invalid/
);
await assert.rejects(
  verifyExtensionManifest({ ...BUILTIN_WORKSPACE_TOOLS_MANIFEST, integrity: "sha256-tampered" }),
  /integrity mismatch/
);
assert.throws(
  () => assertExtensionCapability(BUILTIN_WORKSPACE_TOOLS_MANIFEST, "workspace.write"),
  /was not granted/
);

const extensionOutput: JsonRpcMessage[] = [];
const extensionServer = new ExtensionWorkerServer((message) => extensionOutput.push(message));
extensionServer.receive({
  jsonrpc: "2.0",
  id: 1,
  method: "extensionHost/activate",
  params: {
    id: BUILTIN_WORKSPACE_TOOLS_MANIFEST.id,
    entrypoint: BUILTIN_WORKSPACE_TOOLS_MANIFEST.entrypoint,
    capabilities: BUILTIN_WORKSPACE_TOOLS_MANIFEST.capabilities
  }
});
assert.deepEqual(
  ((extensionOutput.at(-1) as JsonRpcResponse).result as { contributions: { commands: string[] } }).contributions.commands,
  ["cargo.workspaceTools.hello"]
);
extensionServer.receive({
  jsonrpc: "2.0",
  id: 2,
  method: "workspace/executeCommand",
  params: { command: "cargo.workspaceTools.hello" }
});
assert.match(((extensionOutput.at(-1) as JsonRpcResponse).result as { message: string }).message, /isolated Workspace Tools/);
extensionServer.receive({ jsonrpc: "2.0", id: 3, method: "extensionHost/deactivate", params: {} });
assert.equal(((extensionOutput.at(-1) as JsonRpcResponse).result as { deactivated: boolean }).deactivated, true);
assert.equal(
  extensionServer.receive({ jsonrpc: "2.0", id: 4, method: "extensionHost/crash", params: {} }),
  "close"
);

const dapOutput: Array<DapResponse | DapEvent> = [];
const adapter = new FixtureDebugAdapter((message) => dapOutput.push(message));
let sequence = 1;
const request = (command: string, args?: unknown) => {
  const message: DapRequest = { seq: sequence++, type: "request", command, ...(args === undefined ? {} : { arguments: args }) };
  adapter.receive(message);
};

request("initialize");
request("launch", { program: "file:///workspace/debug-fixture.ts" });
request("setBreakpoints", { breakpoints: [{ line: 3 }] });
request("configurationDone");
await new Promise((resolve) => setTimeout(resolve, 0));
assert.ok(dapOutput.some((message) => message.type === "event" && message.event === "initialized"));
assert.ok(dapOutput.some((message) => message.type === "event" && message.event === "stopped"));
request("stackTrace", { threadId: 1 });
assert.equal(
  ((dapOutput.at(-1) as DapResponse).body as { stackFrames: Array<{ line: number }> }).stackFrames[0]?.line,
  3
);
request("scopes", { frameId: 100 });
assert.equal(((dapOutput.at(-1) as DapResponse).body as { scopes: Array<{ name: string }> }).scopes[0]?.name, "Locals");
request("variables", { variablesReference: 200 });
assert.equal(((dapOutput.at(-1) as DapResponse).body as { variables: Array<{ value: string }> }).variables[0]?.value, "3");
request("next", { threadId: 1 });
request("continue", { threadId: 1 });
request("terminate");
await new Promise((resolve) => setTimeout(resolve, 0));
assert.ok(dapOutput.some((message) => message.type === "event" && message.event === "terminated"));

console.log("preview-service extension host and DAP product-stage contract ok");
