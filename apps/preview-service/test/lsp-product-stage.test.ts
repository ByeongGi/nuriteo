import assert from "node:assert/strict";

import { JsonRpcClient, type JsonRpcTransport } from "../src/lib/jsonRpcClient.ts";
import type { JsonRpcMessage, JsonRpcNotification, JsonRpcResponse } from "../src/lib/lspProtocol.ts";
import { BrowserLspServer } from "../src/lib/lspServer.ts";
import { applyLspWorkspaceEdit } from "../src/lib/workspaceEdit.ts";

const output: JsonRpcMessage[] = [];
const server = new BrowserLspServer((message) => output.push(message));

const initialize = await request(1, "initialize", { rootUri: "file:///workspace" });
const capabilities = (initialize.result as {
  capabilities: {
    textDocumentSync: { change: number };
    hoverProvider: boolean;
    referencesProvider: boolean;
    semanticTokensProvider: { full: boolean };
  };
}).capabilities;
assert.equal(capabilities.textDocumentSync.change, 2);
assert.equal(capabilities.hoverProvider, true);
assert.equal(capabilities.referencesProvider, true);
assert.equal(capabilities.semanticTokensProvider.full, true);

server.receive({ jsonrpc: "2.0", method: "initialized", params: {} });
server.receive({
  jsonrpc: "2.0",
  method: "textDocument/didOpen",
  params: {
    textDocument: {
      uri: "file:///workspace/source.ts",
      languageId: "typescript",
      version: 1,
      text: "export const cargoAnswer: number = 42; // FIXME\nexport function add(left: number, right: number) { return left + right; }\n"
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
      text: "import { add, cargoAnswer } from './source';\nconst value: string = cargoAnswer;\nadd(1, 2);\ncar"
    }
  }
});

const published = output.filter(
  (message): message is JsonRpcNotification => "method" in message && message.method === "textDocument/publishDiagnostics"
);
const sourceDiagnostics = published.find((message) => (message.params as { uri: string }).uri.endsWith("source.ts"));
assert.ok((sourceDiagnostics?.params as { diagnostics: Array<{ code: string }> }).diagnostics.some((entry) => entry.code === "cargo-lsp-fixme"));
const consumerDiagnostics = published.find((message) => (message.params as { uri: string }).uri.endsWith("consumer.ts"));
assert.ok((consumerDiagnostics?.params as { diagnostics: Array<{ code: number }> }).diagnostics.some((entry) => entry.code === 2322));

const completion = await request(2, "textDocument/completion", {
  textDocument: { uri: "file:///workspace/consumer.ts" },
  position: { line: 3, character: 3 }
});
assert.ok((completion.result as Array<{ label: string }>).some((item) => item.label === "cargoAnswer"));

const definition = await request(3, "textDocument/definition", {
  textDocument: { uri: "file:///workspace/consumer.ts" },
  position: { line: 1, character: 24 }
});
assert.equal((definition.result as Array<{ uri: string }>)[0]?.uri, "file:///workspace/source.ts");

const references = await request(4, "textDocument/references", {
  textDocument: { uri: "file:///workspace/consumer.ts" },
  position: { line: 1, character: 24 },
  context: { includeDeclaration: true }
});
assert.ok((references.result as unknown[]).length >= 2);

const hover = await request(5, "textDocument/hover", {
  textDocument: { uri: "file:///workspace/consumer.ts" },
  position: { line: 1, character: 24 }
});
assert.match((hover.result as { contents: { value: string } }).contents.value, /cargoAnswer/);

const signature = await request(6, "textDocument/signatureHelp", {
  textDocument: { uri: "file:///workspace/consumer.ts" },
  position: { line: 2, character: 6 }
});
assert.match((signature.result as { signatures: Array<{ label: string }> }).signatures[0]?.label ?? "", /left: number/);

const rename = await request(7, "textDocument/rename", {
  textDocument: { uri: "file:///workspace/consumer.ts" },
  position: { line: 1, character: 24 },
  newName: "renamedAnswer"
});
const changes = (rename.result as { changes: Record<string, unknown[]> }).changes;
assert.ok((changes["file:///workspace/source.ts"]?.length ?? 0) >= 1);
assert.ok((changes["file:///workspace/consumer.ts"]?.length ?? 0) >= 1);
const workspaceFiles = new Map([
  ["/workspace/source.ts", "export const cargoAnswer: number = 42; // FIXME\nexport function add(left: number, right: number) { return left + right; }\n"],
  ["/workspace/consumer.ts", "import { add, cargoAnswer } from './source';\nconst value: string = cargoAnswer;\nadd(1, 2);\ncar"]
]);
assert.deepEqual(applyLspWorkspaceEdit(rename.result as { changes: Record<string, never[]> }, {
  root: "/workspace",
  read: (path) => workspaceFiles.get(path) ?? assert.fail(`missing ${path}`),
  write: (path, text) => workspaceFiles.set(path, text)
}).sort(), ["/workspace/consumer.ts", "/workspace/source.ts"]);
assert.match(workspaceFiles.get("/workspace/source.ts") ?? "", /renamedAnswer/);
assert.match(workspaceFiles.get("/workspace/consumer.ts") ?? "", /renamedAnswer/);

const symbols = await request(8, "textDocument/documentSymbol", {
  textDocument: { uri: "file:///workspace/source.ts" }
});
assert.ok((symbols.result as Array<{ name: string }>).some((symbol) => symbol.name === "add"));

const formatted = await request(9, "textDocument/formatting", {
  textDocument: { uri: "file:///workspace/source.ts" },
  options: { tabSize: 2, insertSpaces: true }
});
assert.ok(Array.isArray(formatted.result));

const semantic = await request(10, "textDocument/semanticTokens/full", {
  textDocument: { uri: "file:///workspace/source.ts" }
});
assert.ok((semantic.result as { data: number[] }).data.length > 0);

server.receive({
  jsonrpc: "2.0",
  method: "textDocument/didOpen",
  params: {
    textDocument: {
      uri: "file:///workspace/fix.ts",
      languageId: "typescript",
      version: 1,
      text: "import { add } from './source';\nconst result = addd(1, 2);\n"
    }
  }
});
const quickFix = await request(11, "textDocument/codeAction", {
  textDocument: { uri: "file:///workspace/fix.ts" },
  range: { start: { line: 1, character: 15 }, end: { line: 1, character: 19 } },
  context: { diagnostics: [{ code: 2552 }] }
});
assert.match((quickFix.result as Array<{ title: string }>)[0]?.title ?? "", /Change spelling to 'add'/);

server.receive({
  jsonrpc: "2.0",
  method: "textDocument/didChange",
  params: {
    textDocument: { uri: "file:///workspace/source.ts", version: 2 },
    contentChanges: [{
      range: { start: { line: 0, character: 42 }, end: { line: 0, character: 47 } },
      rangeLength: 5,
      text: "DONE"
    }]
  }
});
const clearedDiagnostics = output.at(-1) as JsonRpcNotification;
assert.equal((clearedDiagnostics.params as { version: number }).version, 2);
assert.ok(!(clearedDiagnostics.params as { diagnostics: Array<{ code: string }> }).diagnostics.some((entry) => entry.code === "cargo-lsp-fixme"));

server.receive({
  jsonrpc: "2.0",
  method: "textDocument/didChange",
  params: {
    textDocument: { uri: "file:///workspace/source.ts", version: 1 },
    contentChanges: [{ text: "stale" }]
  }
});
assert.equal((output.at(-1) as JsonRpcNotification).params, clearedDiagnostics.params, "stale document versions must be ignored");

server.receive({
  jsonrpc: "2.0",
  method: "textDocument/didClose",
  params: { textDocument: { uri: "file:///workspace/source.ts" } }
});
assert.deepEqual(((output.at(-1) as JsonRpcNotification).params as { diagnostics: unknown[] }).diagnostics, []);
const shutdown = await request(12, "shutdown");
assert.equal(shutdown.result, null);
server.receive({ jsonrpc: "2.0", method: "exit" });

class LoopbackTransport implements JsonRpcTransport {
  listener: ((message: JsonRpcMessage) => void) | null = null;
  disposed = false;
  messages: JsonRpcMessage[] = [];

  send(message: JsonRpcMessage): void {
    this.messages.push(message);
    if (!("id" in message) || !("method" in message) || message.method === "cargo/slow") return;
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
const abort = new AbortController();
const slow = client.request("cargo/slow", {}, 10_000, abort.signal);
abort.abort(new Error("cancelled by test"));
await assert.rejects(slow, /cancelled by test/);
assert.ok(transport.messages.some((message) => "method" in message && message.method === "$/cancelRequest"));
client.dispose();
assert.equal(transport.disposed, true);
await assert.rejects(client.request("after/dispose"), /disposed/);

console.log("preview-service compiler LSP product contract ok");

async function request(id: number, method: string, params?: unknown): Promise<JsonRpcResponse> {
  server.receive({ jsonrpc: "2.0", id, method, ...(params === undefined ? {} : { params }) });
  await Promise.resolve();
  const response = output.find((message): message is JsonRpcResponse => "id" in message && message.id === id && !("method" in message));
  assert.ok(response, `missing response for ${method}`);
  if (response.error) assert.fail(`${method} failed: ${response.error.message}`);
  return response;
}
