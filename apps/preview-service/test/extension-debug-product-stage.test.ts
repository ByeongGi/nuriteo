import assert from "node:assert/strict";

import { BrowserExtensionHost } from "../src/lib/browserExtensionHost.ts";
import { BrowserExtensionManager } from "../src/lib/browserExtensionManager.ts";
import { WorkspaceDebugAdapter } from "../src/lib/dapServer.ts";
import type { DapEvent, DapRequest, DapResponse } from "../src/lib/dapProtocol.ts";
import { ExtensionWorkerServer } from "../src/lib/extensionWorkerServer.ts";
import {
  assertExtensionCapability,
  BUILTIN_CODE_HEALTH_MANIFEST,
  BUILTIN_EXTENSION_MANIFESTS,
  BUILTIN_WORKSPACE_TOOLS_MANIFEST,
  verifyExtensionManifest
} from "../src/lib/extensionManifest.ts";
import type { JsonRpcTransport } from "../src/lib/jsonRpcClient.ts";
import type { JsonRpcMessage, JsonRpcResponse } from "../src/lib/lspProtocol.ts";
import { DEBUG_FIXTURE_SOURCE_MAP, DEBUG_FIXTURE_SOURCE_URI, RuntimeSourceMap } from "../src/lib/sourceMap.ts";

await verifyExtensionManifest(BUILTIN_WORKSPACE_TOOLS_MANIFEST);
await verifyExtensionManifest(BUILTIN_CODE_HEALTH_MANIFEST);
await assert.rejects(
  verifyExtensionManifest({ ...BUILTIN_WORKSPACE_TOOLS_MANIFEST, version: "1.0.1" }),
  /signature is invalid/
);
await assert.rejects(
  verifyExtensionManifest({ ...BUILTIN_WORKSPACE_TOOLS_MANIFEST, integrity: "sha256-tampered" }),
  /integrity mismatch/
);
assert.throws(
  () => assertExtensionCapability(BUILTIN_CODE_HEALTH_MANIFEST, "workspace.write"),
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
  ["cargo.workspaceTools.hello", "cargo.workspaceTools.sortLines"]
);
extensionServer.receive({
  jsonrpc: "2.0",
  id: 2,
  method: "workspace/executeCommand",
  params: { command: "cargo.workspaceTools.hello" }
});
assert.match(((extensionOutput.at(-1) as JsonRpcResponse).result as { message: string }).message, /isolated Workspace Tools/);
extensionServer.receive({
  jsonrpc: "2.0",
  id: 3,
  method: "workspace/executeCommand",
  params: {
    command: "cargo.workspaceTools.sortLines",
    document: { uri: "file:///workspace/example.ts", languageId: "typescript", version: 1, text: "z\na\n" }
  }
});
assert.equal(
  ((extensionOutput.at(-1) as JsonRpcResponse).result as { edit: { text: string } }).edit.text,
  "a\nz\n"
);
extensionServer.receive({ jsonrpc: "2.0", id: 4, method: "extensionHost/deactivate", params: {} });
assert.equal(((extensionOutput.at(-1) as JsonRpcResponse).result as { deactivated: boolean }).deactivated, true);
assert.equal(
  extensionServer.receive({ jsonrpc: "2.0", id: 5, method: "extensionHost/crash", params: {} }),
  "close"
);

const manager = new BrowserExtensionManager(
  BUILTIN_EXTENSION_MANIFESTS,
  {},
  (manifest, grants) => new BrowserExtensionHost(manifest, grants, async () => loopbackExtensionTransport())
);
await manager.start();
assert.equal(manager.snapshot.extensions.find((extension) => extension.id === BUILTIN_WORKSPACE_TOOLS_MANIFEST.id)?.state, "active");
assert.equal(manager.snapshot.extensions.find((extension) => extension.id === BUILTIN_CODE_HEALTH_MANIFEST.id)?.state, "stopped");
const hello = await manager.executeCommand("cargo.workspaceTools.hello");
assert.match(hello.message ?? "", /isolated Workspace Tools/);
const extensionDiagnostics = await manager.provideDiagnostics({
  uri: "file:///workspace/example.ts",
  languageId: "typescript",
  version: 1,
  text: "console.log('remove me');\n"
});
assert.equal(extensionDiagnostics[0]?.code, "cargo-code-health-console");
assert.equal(manager.snapshot.extensions.find((extension) => extension.id === BUILTIN_CODE_HEALTH_MANIFEST.id)?.state, "active");
await manager.recover(BUILTIN_WORKSPACE_TOOLS_MANIFEST.id);
assert.equal(manager.snapshot.extensions.find((extension) => extension.id === BUILTIN_WORKSPACE_TOOLS_MANIFEST.id)?.recoveryCount, 1);
await manager.dispose();

const dapOutput: Array<DapResponse | DapEvent> = [];
const adapter = new WorkspaceDebugAdapter((message) => dapOutput.push(message));
const debugProgram = "file:///workspace/src/debug.ts";
const debugSource = [
  "let counter = 0;",
  "counter += 1;",
  "counter += 1;",
  "counter += 1;",
  "console.log(counter);",
  ""
].join("\n");
let sequence = 1;
const request = (command: string, args?: unknown) => {
  const message: DapRequest = { seq: sequence++, type: "request", command, ...(args === undefined ? {} : { arguments: args }) };
  adapter.receive(message);
};

request("initialize");
request("launch", { program: debugProgram, source: debugSource });
request("setBreakpoints", {
  source: { path: debugProgram },
  breakpoints: [{ line: 3, condition: "counter >= 1" }, { line: 5 }]
});
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
assert.equal(((dapOutput.at(-1) as DapResponse).body as { scopes: Array<{ name: string }> }).scopes[0]?.name, "Module");
request("variables", { variablesReference: 200 });
assert.equal(((dapOutput.at(-1) as DapResponse).body as { variables: Array<{ value: string }> }).variables[0]?.value, "1");
request("evaluate", { expression: "counter + 1", context: "watch" });
assert.equal(((dapOutput.at(-1) as DapResponse).body as { result: string }).result, "2");
request("next", { threadId: 1 });
request("stackTrace", { threadId: 1 });
assert.equal(((dapOutput.at(-1) as DapResponse).body as { stackFrames: Array<{ line: number }> }).stackFrames[0]?.line, 4);
request("setVariable", { variablesReference: 200, name: "counter", value: "7" });
assert.equal(((dapOutput.at(-1) as DapResponse).body as { value: string }).value, "7");
request("continue", { threadId: 1 });
await new Promise((resolve) => setTimeout(resolve, 0));
request("stackTrace", { threadId: 1 });
assert.equal(((dapOutput.at(-1) as DapResponse).body as { stackFrames: Array<{ line: number }> }).stackFrames[0]?.line, 5);
request("evaluate", { expression: "counter + 1", context: "watch" });
assert.equal(((dapOutput.at(-1) as DapResponse).body as { result: string }).result, "9");
request("continue", { threadId: 1 });
await new Promise((resolve) => setTimeout(resolve, 0));
assert.ok(dapOutput.some((message) => message.type === "event" && message.event === "terminated"));
assert.ok(dapOutput.some((message) => message.type === "event" && message.event === "output" && (message.body as { output: string }).output === "8\n"));

const sourceMap = new RuntimeSourceMap(DEBUG_FIXTURE_SOURCE_MAP);
assert.deepEqual(sourceMap.generatedPositionFor(DEBUG_FIXTURE_SOURCE_URI, 3), { line: 5, column: 0 });
assert.deepEqual(sourceMap.originalPositionFor(6), { uri: DEBUG_FIXTURE_SOURCE_URI, line: 4, column: 0 });

console.log("preview-service extension host and DAP product-stage contract ok");

function loopbackExtensionTransport(): JsonRpcTransport {
  let listener: ((message: JsonRpcMessage) => void) | null = null;
  const server = new ExtensionWorkerServer((message) => queueMicrotask(() => listener?.(message)));
  return {
    send(message) {
      server.receive(message);
    },
    subscribe(next) {
      listener = next;
      return () => {
        listener = null;
      };
    },
    dispose() {
      listener = null;
    }
  };
}
