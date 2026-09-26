import type {
  JsonRpcMessage,
  JsonRpcNotification,
  JsonRpcRequest,
  JsonRpcResponse,
  LspCompletionItem,
  LspDiagnostic,
  LspLocation,
  LspPosition,
  LspRange,
  LspWorkspaceEdit
} from "./lspProtocol.ts";

type DocumentState = { uri: string; languageId: string; version: number; text: string };
type SymbolOccurrence = { uri: string; name: string; range: LspRange; declaration: boolean };

const DECLARATION_PATTERN = /\b(?:export\s+)?(?:const|let|var|function|class|interface|type)\s+([A-Za-z_$][\w$]*)/g;
const WORD_PATTERN = /[A-Za-z_$][\w$]*/g;
const FIXME_PATTERN = /\bFIXME\b/g;

export class BrowserLspServer {
  readonly #documents = new Map<string, DocumentState>();
  readonly #send: (message: JsonRpcMessage) => void;
  #initialized = false;
  #shutdown = false;

  constructor(send: (message: JsonRpcMessage) => void) {
    this.#send = send;
  }

  receive(message: JsonRpcMessage): void {
    if ("method" in message && "id" in message) {
      void this.#handleRequest(message);
      return;
    }
    if ("method" in message) this.#handleNotification(message);
  }

  async #handleRequest(request: JsonRpcRequest): Promise<void> {
    try {
      const result = this.#requestResult(request.method, request.params);
      this.#respond({ jsonrpc: "2.0", id: request.id, result });
    } catch (error) {
      this.#respond({
        jsonrpc: "2.0",
        id: request.id,
        error: { code: -32603, message: error instanceof Error ? error.message : String(error) }
      });
    }
  }

  #requestResult(method: string, params: unknown): unknown {
    if (method === "initialize") {
      this.#initialized = true;
      return {
        serverInfo: { name: "cargo-browser-lsp", version: "0.1" },
        capabilities: {
          textDocumentSync: 1,
          completionProvider: { resolveProvider: false },
          definitionProvider: true,
          renameProvider: true
        }
      };
    }
    if (method === "shutdown") {
      this.#shutdown = true;
      return null;
    }
    if (!this.#initialized || this.#shutdown) throw new Error("Language server is not available.");
    if (method === "textDocument/completion") return this.#completion(params);
    if (method === "textDocument/definition") return this.#definition(params);
    if (method === "textDocument/rename") return this.#rename(params);
    throw new Error(`Method not found: ${method}`);
  }

  #handleNotification(notification: JsonRpcNotification): void {
    if (notification.method === "textDocument/didOpen") {
      const params = notification.params as { textDocument: DocumentState };
      this.#documents.set(params.textDocument.uri, { ...params.textDocument });
      this.#publishDiagnostics(params.textDocument.uri);
      return;
    }
    if (notification.method === "textDocument/didChange") {
      const params = notification.params as {
        textDocument: { uri: string; version: number };
        contentChanges: Array<{ text: string }>;
      };
      const current = this.#documents.get(params.textDocument.uri);
      const text = params.contentChanges.at(-1)?.text;
      if (!current || text === undefined) return;
      this.#documents.set(current.uri, { ...current, version: params.textDocument.version, text });
      this.#publishDiagnostics(current.uri);
      return;
    }
    if (notification.method === "textDocument/didClose") {
      const params = notification.params as { textDocument: { uri: string } };
      this.#documents.delete(params.textDocument.uri);
      this.#send({
        jsonrpc: "2.0",
        method: "textDocument/publishDiagnostics",
        params: { uri: params.textDocument.uri, diagnostics: [] }
      });
    }
  }

  #completion(params: unknown): LspCompletionItem[] {
    const { uri } = textDocumentPosition(params);
    const activeDocument = this.#documents.get(uri);
    if (!activeDocument) return [];
    const names = new Set<string>();
    for (const occurrence of this.#allOccurrences()) {
      if (occurrence.declaration) names.add(occurrence.name);
    }
    return [...names].sort().map((label) => ({ label, kind: 6, detail: "workspace symbol (Cargo LSP)" }));
  }

  #definition(params: unknown): LspLocation[] {
    const { uri, position } = textDocumentPosition(params);
    const name = this.#wordAt(uri, position);
    if (!name) return [];
    return this.#allOccurrences()
      .filter((occurrence) => occurrence.declaration && occurrence.name === name)
      .map(({ uri: targetUri, range }) => ({ uri: targetUri, range }));
  }

  #rename(params: unknown): LspWorkspaceEdit {
    const parsed = params as { textDocument: { uri: string }; position: LspPosition; newName: string };
    if (!/^[A-Za-z_$][\w$]*$/.test(parsed.newName)) throw new Error("Rename target is not a valid identifier.");
    const name = this.#wordAt(parsed.textDocument.uri, parsed.position);
    if (!name) return { changes: {} };
    const changes: Record<string, Array<{ range: LspRange; newText: string }>> = {};
    for (const occurrence of this.#allOccurrences()) {
      if (occurrence.name !== name) continue;
      (changes[occurrence.uri] ||= []).push({ range: occurrence.range, newText: parsed.newName });
    }
    return { changes };
  }

  #wordAt(uri: string, position: LspPosition): string | null {
    const document = this.#documents.get(uri);
    if (!document) return null;
    const line = document.text.split("\n")[position.line] || "";
    for (const match of line.matchAll(WORD_PATTERN)) {
      const start = match.index;
      const end = start + match[0].length;
      if (start <= position.character && position.character <= end) return match[0];
    }
    return null;
  }

  #allOccurrences(): SymbolOccurrence[] {
    const occurrences: SymbolOccurrence[] = [];
    for (const document of this.#documents.values()) {
      const declarationOffsets = new Map<string, Set<number>>();
      for (const match of document.text.matchAll(DECLARATION_PATTERN)) {
        const name = match[1];
        if (!name) continue;
        const offset = match.index + match[0].lastIndexOf(name);
        let offsets = declarationOffsets.get(name);
        if (!offsets) {
          offsets = new Set<number>();
          declarationOffsets.set(name, offsets);
        }
        offsets.add(offset);
      }
      for (const match of document.text.matchAll(WORD_PATTERN)) {
        const startOffset = match.index;
        occurrences.push({
          uri: document.uri,
          name: match[0],
          range: rangeForOffset(document.text, startOffset, match[0].length),
          declaration: declarationOffsets.get(match[0])?.has(startOffset) === true
        });
      }
    }
    return occurrences;
  }

  #publishDiagnostics(uri: string): void {
    const document = this.#documents.get(uri);
    const diagnostics: LspDiagnostic[] = [];
    if (document) {
      for (const match of document.text.matchAll(FIXME_PATTERN)) {
        diagnostics.push({
          range: rangeForOffset(document.text, match.index, match[0].length),
          severity: 2,
          code: "cargo-lsp-fixme",
          source: "cargo-lsp",
          message: "FIXME marker requires attention."
        });
      }
    }
    this.#send({ jsonrpc: "2.0", method: "textDocument/publishDiagnostics", params: { uri, diagnostics } });
  }

  #respond(response: JsonRpcResponse): void {
    this.#send(response);
  }
}

function textDocumentPosition(params: unknown): { uri: string; position: LspPosition } {
  const parsed = params as { textDocument: { uri: string }; position: LspPosition };
  return { uri: parsed.textDocument.uri, position: parsed.position };
}

function rangeForOffset(text: string, offset: number, length: number): LspRange {
  const before = text.slice(0, offset);
  const lines = before.split("\n");
  const line = lines.length - 1;
  const character = lines.at(-1)?.length || 0;
  return {
    start: { line, character },
    end: { line, character: character + length }
  };
}
