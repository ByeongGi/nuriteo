import { JsonRpcClient, WorkerJsonRpcTransport } from "./jsonRpcClient.ts";
import type {
  LspCompletionItem,
  LspLocation,
  LspPosition,
  LspPublishDiagnosticsParams,
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
  readonly #createWorker: () => Worker;
  #client: JsonRpcClient | null = null;
  #state: LanguageServerState = "stopped";
  #diagnosticsListener: (params: LspPublishDiagnosticsParams) => void = () => undefined;

  constructor(createWorker = () => new Worker(new URL("../workers/lsp.worker.ts", import.meta.url), { type: "module", name: "cargo-lsp" })) {
    this.#createWorker = createWorker;
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
      const client = new JsonRpcClient(new WorkerJsonRpcTransport(this.#createWorker()));
      this.#client = client;
      client.onNotification((message) => {
        if (message.method === "textDocument/publishDiagnostics") {
          this.#diagnosticsListener(message.params as LspPublishDiagnosticsParams);
        }
      });
      await client.request("initialize", {
        processId: null,
        rootUri,
        clientInfo: { name: "cargo-container-preview", version: "0.1" },
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

  change(document: LanguageServerDocument): void {
    this.#client?.notify("textDocument/didChange", {
      textDocument: { uri: document.uri, version: document.version },
      contentChanges: [{ text: document.text }]
    });
  }

  close(uri: string): void {
    this.#client?.notify("textDocument/didClose", { textDocument: { uri } });
  }

  completion(uri: string, position: LspPosition): Promise<LspCompletionItem[]> {
    return this.#request("textDocument/completion", { textDocument: { uri }, position });
  }

  definition(uri: string, position: LspPosition): Promise<LspLocation[]> {
    return this.#request("textDocument/definition", { textDocument: { uri }, position });
  }

  rename(uri: string, position: LspPosition, newName: string): Promise<LspWorkspaceEdit> {
    return this.#request("textDocument/rename", { textDocument: { uri }, position, newName });
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

  #request<T>(method: string, params: unknown): Promise<T> {
    if (!this.#client || this.#state !== "ready") {
      return Promise.reject(new Error("Language server is not ready."));
    }
    return this.#client.request<T>(method, params);
  }
}
