import { JsonRpcClient, type JsonRpcTransport } from "./jsonRpcClient.ts";
import { HostProcessJsonRpcTransport } from "./hostProcessJsonRpcTransport.ts";
import type {
  LspCodeAction,
  LspCompletionItem,
  LspDocumentSymbol,
  LspHover,
  LspLocation,
  LspPosition,
  LspPublishDiagnosticsParams,
  LspRange,
  LspSemanticTokens,
  LspSignatureHelp,
  LspTextEdit,
  LspWorkspaceEdit
} from "./lspProtocol.ts";

export type LanguageServerState = "stopped" | "starting" | "ready" | "failed";

export interface LanguageServerDocument {
  uri: string;
  languageId: string;
  version: number;
  text: string;
}

export class BrowserLanguageServer {
  readonly #createTransport: (rootUri: string) => Promise<JsonRpcTransport>;
  #client: JsonRpcClient | null = null;
  #state: LanguageServerState = "stopped";
  #diagnosticsListener: (params: LspPublishDiagnosticsParams) => void = () => undefined;

  constructor(createTransport = (rootUri: string) => HostProcessJsonRpcTransport.start(rootUri)) {
    this.#createTransport = createTransport;
  }

  get state(): LanguageServerState {
    return this.#state;
  }

  onDiagnostics(listener: (params: LspPublishDiagnosticsParams) => void): void {
    this.#diagnosticsListener = listener;
  }

  async start(rootUri: string): Promise<void> {
    if (this.#state === "starting" || this.#state === "ready") return;
    this.#state = "starting";
    try {
      const client = new JsonRpcClient(await this.#createTransport(rootUri));
      this.#client = client;
      client.onNotification((message) => {
        if (message.method === "textDocument/publishDiagnostics") {
          this.#diagnosticsListener(message.params as LspPublishDiagnosticsParams);
        }
      });
      await client.request("initialize", {
        processId: null,
        rootUri,
        clientInfo: { name: "nuriteo-preview", version: "0.1" },
        capabilities: { workspace: { workspaceEdit: { documentChanges: false } } }
      });
      client.notify("initialized", {});
      this.#state = "ready";
    } catch (error) {
      this.#state = "failed";
      this.#client?.dispose("Language server initialization failed.");
      this.#client = null;
      throw error;
    }
  }

  open(document: LanguageServerDocument): void {
    this.#client?.notify("textDocument/didOpen", { textDocument: document });
  }

  change(document: LanguageServerDocument, contentChanges: Array<{ range?: LspRange; text: string }> = [{ text: document.text }]): void {
    this.#client?.notify("textDocument/didChange", {
      textDocument: { uri: document.uri, version: document.version },
      contentChanges
    });
  }

  close(uri: string): void {
    this.#client?.notify("textDocument/didClose", { textDocument: { uri } });
  }

  completion(uri: string, position: LspPosition, signal?: AbortSignal): Promise<LspCompletionItem[]> {
    return this.#request("textDocument/completion", { textDocument: { uri }, position }, signal);
  }

  definition(uri: string, position: LspPosition): Promise<LspLocation[]> {
    return this.#request("textDocument/definition", { textDocument: { uri }, position });
  }

  references(uri: string, position: LspPosition): Promise<LspLocation[]> {
    return this.#request("textDocument/references", { textDocument: { uri }, position, context: { includeDeclaration: true } });
  }

  hover(uri: string, position: LspPosition): Promise<LspHover | null> {
    return this.#request("textDocument/hover", { textDocument: { uri }, position });
  }

  signatureHelp(uri: string, position: LspPosition): Promise<LspSignatureHelp | null> {
    return this.#request("textDocument/signatureHelp", { textDocument: { uri }, position });
  }

  prepareRename(uri: string, position: LspPosition): Promise<{ range: LspRange; placeholder: string } | null> {
    return this.#request("textDocument/prepareRename", { textDocument: { uri }, position });
  }

  rename(uri: string, position: LspPosition, newName: string): Promise<LspWorkspaceEdit> {
    return this.#request("textDocument/rename", { textDocument: { uri }, position, newName });
  }

  documentSymbols(uri: string): Promise<LspDocumentSymbol[]> {
    return this.#request("textDocument/documentSymbol", { textDocument: { uri } });
  }

  workspaceSymbols(query: string): Promise<Array<LspDocumentSymbol & { location: LspLocation }>> {
    return this.#request("workspace/symbol", { query });
  }

  format(uri: string): Promise<LspTextEdit[]> {
    return this.#request("textDocument/formatting", { textDocument: { uri }, options: { tabSize: 2, insertSpaces: true } });
  }

  codeActions(uri: string, range: LspRange, diagnostics: LspDiagnosticCode[]): Promise<LspCodeAction[]> {
    return this.#request("textDocument/codeAction", { textDocument: { uri }, range, context: { diagnostics } });
  }

  semanticTokens(uri: string): Promise<LspSemanticTokens> {
    return this.#request("textDocument/semanticTokens/full", { textDocument: { uri } });
  }

  async stop(): Promise<void> {
    const client = this.#client;
    this.#client = null;
    this.#state = "stopped";
    if (!client) return;
    try {
      await client.request("shutdown", undefined, 2_000);
      client.notify("exit");
    } finally {
      client.dispose();
    }
  }

  #request<T>(method: string, params: unknown, signal?: AbortSignal): Promise<T> {
    if (!this.#client || this.#state !== "ready") {
      return Promise.reject(new Error("Language server is not ready."));
    }
    return this.#client.request<T>(method, params, 10_000, signal);
  }
}

type LspDiagnosticCode = { code?: string | number };
