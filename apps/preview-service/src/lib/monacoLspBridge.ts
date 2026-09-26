import * as monaco from "monaco-editor";
import { BrowserLanguageServer, type LanguageServerState } from "./browserLanguageServer";
import type { LspDiagnostic, LspPosition, LspRange } from "./lspProtocol";
import { monacoModelPath } from "./monacoProjectSync";

const LSP_OWNER = "cargo-lsp";
const SUPPORTED_LANGUAGES = ["typescript", "javascript"] as const;

type SyncedDocument = { version: number; text: string; languageId: string };

export class MonacoLspBridge {
  readonly #server: BrowserLanguageServer;
  readonly #documents = new Map<string, SyncedDocument>();
  readonly #registrations: monaco.IDisposable[] = [];
  #statusListener: (state: LanguageServerState) => void = () => undefined;
  #startTask: Promise<void> | null = null;
  #disposed = false;

  constructor(server = new BrowserLanguageServer()) {
    this.#server = server;
    server.onDiagnostics(({ uri, diagnostics }) => this.#publishDiagnostics(uri, diagnostics));
  }

  get state(): LanguageServerState {
    return this.#server.state;
  }

  onStatus(listener: (state: LanguageServerState) => void): void {
    this.#statusListener = listener;
  }

  async start(rootUri: string): Promise<void> {
    if (this.#startTask) return this.#startTask;
    this.#statusListener("starting");
    this.#startTask = this.#start(rootUri);
    return this.#startTask;
  }

  async #start(rootUri: string): Promise<void> {
    try {
      await this.#server.start(rootUri);
      if (this.#disposed) return;
      this.#registerProviders();
      this.#statusListener("ready");
    } catch (error) {
      if (!this.#disposed) this.#statusListener("failed");
      throw error;
    }
  }

  sync(files: Array<{ path: string; data: string }>): void {
    if (this.#server.state !== "ready") return;
    const activeUris = new Set<string>();
    for (const file of files) {
      const languageId = languageIdForPath(file.path);
      if (!languageId) continue;
      const uri = monacoModelPath(file.path);
      activeUris.add(uri);
      const current = this.#documents.get(uri);
      if (!current) {
        const document = { uri, languageId, version: 1, text: file.data };
        this.#documents.set(uri, { languageId, version: 1, text: file.data });
        this.#server.open(document);
        continue;
      }
      if (current.text === file.data) continue;
      const version = current.version + 1;
      this.#documents.set(uri, { languageId, version, text: file.data });
      this.#server.change({ uri, languageId, version, text: file.data });
    }

    for (const uri of this.#documents.keys()) {
      if (activeUris.has(uri)) continue;
      this.#documents.delete(uri);
      this.#server.close(uri);
    }
  }

  async dispose(): Promise<void> {
    if (this.#disposed) return;
    this.#disposed = true;
    await this.#startTask?.catch(() => undefined);
    for (const registration of this.#registrations) registration.dispose();
    this.#registrations.length = 0;
    for (const model of monaco.editor.getModels()) monaco.editor.setModelMarkers(model, LSP_OWNER, []);
    this.#documents.clear();
    await this.#server.stop();
  }

  #registerProviders(): void {
    if (this.#registrations.length > 0) return;
    for (const language of SUPPORTED_LANGUAGES) {
      this.#registrations.push(
        monaco.languages.registerCompletionItemProvider(language, {
          provideCompletionItems: async (model, position) => {
            const items = await this.#server.completion(model.uri.toString(), toLspPosition(position));
            const word = model.getWordUntilPosition(position);
            const range = new monaco.Range(position.lineNumber, word.startColumn, position.lineNumber, word.endColumn);
            return {
              suggestions: items.map((item) => ({
                label: item.label,
                kind: monaco.languages.CompletionItemKind.Variable,
                ...(item.detail === undefined ? {} : { detail: item.detail }),
                insertText: item.insertText || item.label,
                range
              }))
            };
          }
        }),
        monaco.languages.registerDefinitionProvider(language, {
          provideDefinition: async (model, position) => {
            const locations = await this.#server.definition(model.uri.toString(), toLspPosition(position));
            return locations.map((location) => ({
              uri: monaco.Uri.parse(location.uri),
              range: toMonacoRange(location.range)
            }));
          }
        }),
        monaco.languages.registerRenameProvider(language, {
          provideRenameEdits: async (model, position, newName) => {
            const edit = await this.#server.rename(model.uri.toString(), toLspPosition(position), newName);
            return {
              edits: Object.entries(edit.changes || {}).flatMap(([uri, edits]) =>
                edits.map((entry) => ({
                  resource: monaco.Uri.parse(uri),
                  textEdit: { range: toMonacoRange(entry.range), text: entry.newText },
                  versionId: undefined
                }))
              )
            };
          },
          resolveRenameLocation: (model, position) => {
            const word = model.getWordAtPosition(position);
            if (!word) {
              return {
                range: new monaco.Range(position.lineNumber, position.column, position.lineNumber, position.column),
                text: "",
                rejectReason: "Place the cursor on an identifier."
              };
            }
            return { range: new monaco.Range(position.lineNumber, word.startColumn, position.lineNumber, word.endColumn), text: word.word };
          }
        })
      );
    }
  }

  #publishDiagnostics(uri: string, diagnostics: LspDiagnostic[]): void {
    const model = monaco.editor.getModel(monaco.Uri.parse(uri));
    if (!model) return;
    monaco.editor.setModelMarkers(
      model,
      LSP_OWNER,
      diagnostics.map((diagnostic) => ({
        ...toMonacoRange(diagnostic.range),
        message: diagnostic.message,
        severity: toMarkerSeverity(diagnostic.severity),
        source: diagnostic.source || LSP_OWNER,
        code: diagnostic.code?.toString()
      }))
    );
  }
}

function languageIdForPath(path: string): "typescript" | "javascript" | null {
  const lower = path.toLowerCase();
  if (lower.endsWith(".ts") || lower.endsWith(".tsx")) return "typescript";
  if (lower.endsWith(".js") || lower.endsWith(".jsx") || lower.endsWith(".mjs") || lower.endsWith(".cjs")) return "javascript";
  return null;
}

function toLspPosition(position: monaco.Position): LspPosition {
  return { line: position.lineNumber - 1, character: position.column - 1 };
}

function toMonacoRange(range: LspRange): monaco.IRange {
  return {
    startLineNumber: range.start.line + 1,
    startColumn: range.start.character + 1,
    endLineNumber: range.end.line + 1,
    endColumn: range.end.character + 1
  };
}

function toMarkerSeverity(severity: LspDiagnostic["severity"]): monaco.MarkerSeverity {
  if (severity === 1) return monaco.MarkerSeverity.Error;
  if (severity === 2) return monaco.MarkerSeverity.Warning;
  if (severity === 3) return monaco.MarkerSeverity.Info;
  return monaco.MarkerSeverity.Hint;
}
