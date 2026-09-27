import type {
  JsonRpcId,
  JsonRpcMessage,
  JsonRpcNotification,
  JsonRpcRequest,
  JsonRpcResponse,
  LspContentChange,
  LspDiagnostic,
  LspPosition,
  LspPublishDiagnosticsParams,
  LspRange
} from "./lspProtocol.ts";
import { TypeScriptProject } from "./typescriptProject.ts";

const FIXME_PATTERN = /\bFIXME\b/g;

export class BrowserLspServer {
  readonly #cancelledRequests = new Set<JsonRpcId>();
  readonly #project = new TypeScriptProject();
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
      await Promise.resolve();
      if (this.#cancelledRequests.delete(request.id)) {
        this.#respond({ jsonrpc: "2.0", id: request.id, error: { code: -32800, message: "Request cancelled" } });
        return;
      }
      const result = this.#requestResult(request.method, request.params);
      if (this.#cancelledRequests.delete(request.id)) {
        this.#respond({ jsonrpc: "2.0", id: request.id, error: { code: -32800, message: "Request cancelled" } });
        return;
      }
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
        serverInfo: { name: "cargo-typescript-lsp", version: "1.0" },
        capabilities: {
          textDocumentSync: { openClose: true, change: 2, save: { includeText: false } },
          completionProvider: { resolveProvider: false, triggerCharacters: [".", "\"", "'", "/", "@", "<"] },
          definitionProvider: true,
          referencesProvider: true,
          hoverProvider: true,
          signatureHelpProvider: { triggerCharacters: ["(", ",", "<"] },
          renameProvider: { prepareProvider: true },
          documentSymbolProvider: true,
          workspaceSymbolProvider: true,
          documentFormattingProvider: true,
          codeActionProvider: { codeActionKinds: ["quickfix"] },
          semanticTokensProvider: {
            full: true,
            legend: {
              tokenTypes: TypeScriptProject.semanticTokenTypes(),
              tokenModifiers: ["declaration", "static", "async", "readonly", "defaultLibrary", "local"]
            }
          }
        }
      };
    }
    if (method === "shutdown") {
      this.#shutdown = true;
      return null;
    }
    this.#assertAvailable();
    if (method === "textDocument/completion") return this.#project.completion(...textDocumentPosition(params));
    if (method === "textDocument/definition") return this.#project.definition(...textDocumentPosition(params));
    if (method === "textDocument/references") return this.#project.references(...textDocumentPosition(params));
    if (method === "textDocument/hover") return this.#project.hover(...textDocumentPosition(params));
    if (method === "textDocument/signatureHelp") return this.#project.signatureHelp(...textDocumentPosition(params));
    if (method === "textDocument/prepareRename") return this.#project.prepareRename(...textDocumentPosition(params));
    if (method === "textDocument/rename") {
      const parsed = params as { textDocument: { uri: string }; position: LspPosition; newName: string };
      return this.#project.rename(parsed.textDocument.uri, parsed.position, parsed.newName);
    }
    if (method === "textDocument/documentSymbol") return this.#project.documentSymbols(textDocumentUri(params));
    if (method === "workspace/symbol") return this.#project.workspaceSymbols((params as { query?: string }).query ?? "");
    if (method === "textDocument/formatting") return this.#project.format(textDocumentUri(params));
    if (method === "textDocument/semanticTokens/full") return this.#project.semanticTokens(textDocumentUri(params));
    if (method === "textDocument/codeAction") {
      const parsed = params as {
        textDocument: { uri: string };
        range: LspRange;
        context?: { diagnostics?: Array<{ code?: number | string }> };
      };
      const codes = (parsed.context?.diagnostics ?? [])
        .map((diagnostic) => Number(diagnostic.code))
        .filter(Number.isSafeInteger);
      return this.#project.codeActions(parsed.textDocument.uri, parsed.range, codes);
    }
    throw new Error(`Method not found: ${method}`);
  }

  #handleNotification(notification: JsonRpcNotification): void {
    if (notification.method === "$/cancelRequest") {
      const id = (notification.params as { id?: JsonRpcId } | undefined)?.id;
      if (id !== undefined) this.#cancelledRequests.add(id);
      return;
    }
    if (notification.method === "textDocument/didOpen") {
      const params = notification.params as { textDocument: { uri: string; languageId: string; version: number; text: string } };
      this.#project.open(params.textDocument);
      this.#publishProjectDiagnostics(params.textDocument.uri);
      return;
    }
    if (notification.method === "textDocument/didChange") {
      const params = notification.params as {
        textDocument: { uri: string; version: number };
        contentChanges: LspContentChange[];
      };
      if (this.#project.change(params.textDocument.uri, params.textDocument.version, params.contentChanges)) {
        this.#publishProjectDiagnostics(params.textDocument.uri);
      }
      return;
    }
    if (notification.method === "textDocument/didClose") {
      const uri = textDocumentUri(notification.params);
      this.#project.close(uri);
      this.#publishProjectDiagnostics();
      this.#send({ jsonrpc: "2.0", method: "textDocument/publishDiagnostics", params: { uri, diagnostics: [] } });
      return;
    }
    if (notification.method === "exit") this.#project.dispose();
  }

  #publishDiagnostics(uri: string): void {
    const diagnostics = this.#project.diagnostics(uri);
    const text = this.#project.text(uri);
    if (text) diagnostics.push(...fixmeDiagnostics(text));
    const params: LspPublishDiagnosticsParams = { uri, version: this.#project.version(uri), diagnostics };
    this.#send({ jsonrpc: "2.0", method: "textDocument/publishDiagnostics", params });
  }

  #publishProjectDiagnostics(lastUri?: string): void {
    const uris = this.#project.uris();
    for (const uri of uris) {
      if (uri !== lastUri) this.#publishDiagnostics(uri);
    }
    if (lastUri && uris.includes(lastUri)) this.#publishDiagnostics(lastUri);
  }

  #assertAvailable(): void {
    if (!this.#initialized || this.#shutdown) throw new Error("Language server is not available.");
  }

  #respond(response: JsonRpcResponse): void {
    this.#send(response);
  }
}

function textDocumentPosition(params: unknown): [string, LspPosition] {
  const parsed = params as { textDocument: { uri: string }; position: LspPosition };
  return [parsed.textDocument.uri, parsed.position];
}

function textDocumentUri(params: unknown): string {
  return (params as { textDocument: { uri: string } }).textDocument.uri;
}

function fixmeDiagnostics(text: string): LspDiagnostic[] {
  return [...text.matchAll(FIXME_PATTERN)].map((match) => ({
    range: rangeForOffset(text, match.index, match[0].length),
    severity: 2,
    code: "cargo-lsp-fixme",
    source: "cargo-lsp",
    message: "FIXME marker requires attention."
  }));
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
