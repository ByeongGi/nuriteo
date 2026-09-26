import assert from "node:assert/strict";

import { JsonRpcClient, type JsonRpcTransport } from "../src/lib/jsonRpcClient.ts";
import type { JsonRpcMessage, JsonRpcNotification, JsonRpcResponse } from "../src/lib/lspProtocol.ts";
import { BrowserLspServer } from "../src/lib/lspServer.ts";

const output: JsonRpcMessage[] = [];
const server = new BrowserLspServer((message) => output.push(message));

server.receive({ jsonrpc: "2.0", id: 1, method: "initialize", params: { rootUri: "file:///workspace" } });
const initialize = output.shift() as JsonRpcResponse;
assert.equal(initialize.id, 1);
assert.deepEqual((initialize.result as { capabilities: { textDocumentSync: number } }).capabilities.textDocumentSync, 1);

server.receive({ jsonrpc: "2.0", method: "initialized", params: {} });
server.receive({
  jsonrpc: "2.0",
  method: "textDocument/didOpen",
  params: {
    textDocument: {
      uri: "file:///workspace/source.ts",
      languageId: "typescript",
      version: 1,
      text: "export const cargoAnswer = 42; // FIXME\n"
    }
  }
});
server.receive({
  jsonrpc: "2.0",
  method: "textDocument/didOpen",
  params: {
    textDocument: {
      uri: "file:///workspace/consumer.ts",
      languageId: "typescript",
      version: 1,
      text: "console.log(cargoAnswer);\n"
    }
  }
});

const diagnostics = output.find(
  (message): message is JsonRpcNotification => "method" in message && message.method === "textDocument/publishDiagnostics"
);
assert.equal((diagnostics?.params as { diagnostics: Array<{ code: string }> }).diagnostics[0]?.code, "cargo-lsp-fixme");

server.receive({
  jsonrpc: "2.0",
  id: 2,
  method: "textDocument/completion",
  params: { textDocument: { uri: "file:///workspace/consumer.ts" }, position: { line: 0, character: 1 } }
});
const completion = output.find((message): message is JsonRpcResponse => "id" in message && message.id === 2);
assert.ok((completion?.result as Array<{ label: string }>).some((item) => item.label === "cargoAnswer"));

server.receive({
  jsonrpc: "2.0",
  id: 3,
  method: "textDocument/definition",
  params: { textDocument: { uri: "file:///workspace/consumer.ts" }, position: { line: 0, character: 18 } }
});
const definition = output.find((message): message is JsonRpcResponse => "id" in message && message.id === 3);
assert.equal((definition?.result as Array<{ uri: string }>)[0]?.uri, "file:///workspace/source.ts");

server.receive({
  jsonrpc: "2.0",
  id: 4,
  method: "textDocument/rename",
  params: {
    textDocument: { uri: "file:///workspace/consumer.ts" },
    position: { line: 0, character: 18 },
    newName: "renamedAnswer"
  }
});
const rename = output.find((message): message is JsonRpcResponse => "id" in message && message.id === 4);
const changes = (rename?.result as { changes: Record<string, unknown[]> }).changes;
assert.equal(changes["file:///workspace/source.ts"]?.length, 1);
assert.equal(changes["file:///workspace/consumer.ts"]?.length, 1);

server.receive({
  jsonrpc: "2.0",
  method: "textDocument/didChange",
  params: {
    textDocument: { uri: "file:///workspace/source.ts", version: 2 },
    contentChanges: [{ text: "export const cargoAnswer = 42;\n" }]
  }
});
const clearedDiagnostics = output.at(-1) as JsonRpcNotification;
assert.deepEqual((clearedDiagnostics.params as { diagnostics: unknown[] }).diagnostics, []);
server.receive({
  jsonrpc: "2.0",
  method: "textDocument/didClose",
  params: { textDocument: { uri: "file:///workspace/source.ts" } }
});
assert.deepEqual(((output.at(-1) as JsonRpcNotification).params as { diagnostics: unknown[] }).diagnostics, []);
server.receive({ jsonrpc: "2.0", id: 5, method: "shutdown" });
assert.equal((output.at(-1) as JsonRpcResponse).result, null);
server.receive({ jsonrpc: "2.0", method: "exit" });

class LoopbackTransport implements JsonRpcTransport {
  listener: ((message: JsonRpcMessage) => void) | null = null;
  disposed = false;

  send(message: JsonRpcMessage): void {
    if (!("id" in message) || !("method" in message)) return;
    queueMicrotask(() => this.listener?.({ jsonrpc: "2.0", id: message.id, result: message.method }));
  }

  subscribe(listener: (message: JsonRpcMessage) => void): () => void {
    this.listener = listener;
    return () => {
      this.listener = null;
    };
  }

  dispose(): void {
    this.disposed = true;
  }
}

const transport = new LoopbackTransport();
const client = new JsonRpcClient(transport);
assert.equal(await client.request("cargo/ping"), "cargo/ping");
client.dispose();
assert.equal(transport.disposed, true);
await assert.rejects(client.request("after/dispose"), /disposed/);

console.log("preview-service LSP product-stage contract ok");
