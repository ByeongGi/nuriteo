import * as monaco from "monaco-editor";
import { BrowserLanguageServer, type LanguageServerState } from "./browserLanguageServer";
import type { LspDiagnostic, LspDocumentSymbol, LspPosition, LspPublishDiagnosticsParams, LspRange } from "./lspProtocol";
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
    server.onDiagnostics((params) => this.#publishDiagnostics(params));
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
      this.#server.change(
        { uri, languageId, version, text: file.data },
        [incrementalChange(current.text, file.data)]
      );
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
          provideCompletionItems: async (model, position, _context, token) => {
            if (!this.#isSynced(model)) return { suggestions: [] };
            const abort = abortSignalForToken(token);
            const items = await this.#server.completion(model.uri.toString(), toLspPosition(position), abort.signal);
            const word = model.getWordUntilPosition(position);
            const range = new monaco.Range(position.lineNumber, word.startColumn, position.lineNumber, word.endColumn);
            return {
              suggestions: items.map((item) => ({
                label: item.label,
                kind: toCompletionItemKind(item.kind),
                ...(item.detail === undefined ? {} : { detail: item.detail }),
                ...(item.documentation === undefined ? {} : { documentation: item.documentation }),
                insertText: item.insertText || item.label,
                range
              }))
            };
          }
        }),
        monaco.languages.registerDefinitionProvider(language, {
          provideDefinition: async (model, position) => {
            if (!this.#isSynced(model)) return [];
            const locations = await this.#server.definition(model.uri.toString(), toLspPosition(position));
            return locations.map((location) => ({
              uri: monaco.Uri.parse(location.uri),
              range: toMonacoRange(location.range)
            }));
          }
        }),
        monaco.languages.registerReferenceProvider(language, {
          provideReferences: async (model, position) => {
            if (!this.#isSynced(model)) return [];
            const locations = await this.#server.references(model.uri.toString(), toLspPosition(position));
            return locations.map((location) => ({ uri: monaco.Uri.parse(location.uri), range: toMonacoRange(location.range) }));
          }
        }),
        monaco.languages.registerHoverProvider(language, {
          provideHover: async (model, position) => {
            if (!this.#isSynced(model)) return null;
            const hover = await this.#server.hover(model.uri.toString(), toLspPosition(position));
            if (!hover) return null;
            return {
              contents: [{ value: hover.contents.value, isTrusted: false, supportHtml: false }],
              ...(hover.range ? { range: toMonacoRange(hover.range) } : {})
            };
          }
        }),
        monaco.languages.registerSignatureHelpProvider(language, {
          signatureHelpTriggerCharacters: ["(", ",", "<"],
          provideSignatureHelp: async (model, position) => {
            if (!this.#isSynced(model)) return null;
            const help = await this.#server.signatureHelp(model.uri.toString(), toLspPosition(position));
            if (!help) return null;
            return {
              value: {
                signatures: help.signatures.map((signature) => ({
                  label: signature.label,
                  documentation: signature.documentation,
                  parameters: signature.parameters?.map((parameter) => ({
                    label: parameter.label,
                    documentation: parameter.documentation
                  })) ?? []
                })),
                activeSignature: help.activeSignature,
                activeParameter: help.activeParameter
              },
              dispose: () => undefined
            };
          }
        }),
        monaco.languages.registerDocumentSymbolProvider(language, {
          provideDocumentSymbols: async (model) => {
            if (!this.#isSynced(model)) return [];
            const symbols = await this.#server.documentSymbols(model.uri.toString());
            return symbols.map(toMonacoDocumentSymbol);
          }
        }),
        monaco.languages.registerDocumentFormattingEditProvider(language, {
          provideDocumentFormattingEdits: async (model) => {
            if (!this.#isSynced(model)) return [];
            const edits = await this.#server.format(model.uri.toString());
            return edits.map((edit) => ({ range: toMonacoRange(edit.range), text: edit.newText }));
          }
        }),
        monaco.languages.registerCodeActionProvider(language, {
          provideCodeActions: async (model, range, context) => {
            if (!this.#isSynced(model)) return { actions: [], dispose: () => undefined };
            const actions = await this.#server.codeActions(
              model.uri.toString(),
              toLspRange(range),
              context.markers.map((marker) => ({ code: marker.code }))
            );
            return {
              actions: actions.map((action) => ({
                title: action.title,
                kind: action.kind,
                edit: toMonacoWorkspaceEdit(action.edit),
                diagnostics: context.markers
              })),
              dispose: () => undefined
            };
          }
        }, { providedCodeActionKinds: ["quickfix"] }),
        monaco.languages.registerDocumentSemanticTokensProvider(language, {
          getLegend: () => ({
            tokenTypes: ["class", "enum", "interface", "namespace", "typeParameter", "type", "parameter", "variable", "enumMember", "property", "function", "method"],
            tokenModifiers: ["declaration", "static", "async", "readonly", "defaultLibrary", "local"]
          }),
          provideDocumentSemanticTokens: async (model) => this.#isSynced(model)
            ? this.#server.semanticTokens(model.uri.toString())
            : { data: [] },
          releaseDocumentSemanticTokens: () => undefined
        }),
        monaco.languages.registerRenameProvider(language, {
          provideRenameEdits: async (model, position, newName) => {
            if (!this.#isSynced(model)) return { edits: [] };
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
          resolveRenameLocation: async (model, position) => {
            if (!this.#isSynced(model)) {
              return {
                range: new monaco.Range(position.lineNumber, position.column, position.lineNumber, position.column),
                text: "",
                rejectReason: "The document is still synchronizing with the language server."
              };
            }
            const prepared = await this.#server.prepareRename(model.uri.toString(), toLspPosition(position));
            if (!prepared) {
              return {
                range: new monaco.Range(position.lineNumber, position.column, position.lineNumber, position.column),
                text: "",
                rejectReason: "Place the cursor on an identifier."
              };
            }
            return { range: toMonacoRange(prepared.range), text: prepared.placeholder };
          }
        })
      );
    }
  }

  #isSynced(model: monaco.editor.ITextModel): boolean {
    return !this.#disposed && this.#documents.has(model.uri.toString());
  }

  #publishDiagnostics(params: LspPublishDiagnosticsParams): void {
    const current = this.#documents.get(params.uri);
    if (params.version !== undefined && current && params.version !== current.version) return;
    const model = monaco.editor.getModel(monaco.Uri.parse(params.uri));
    if (!model) return;
    monaco.editor.setModelMarkers(
      model,
      LSP_OWNER,
      params.diagnostics.map((diagnostic) => ({
        ...toMonacoRange(diagnostic.range),
        message: diagnostic.message,
        severity: toMarkerSeverity(diagnostic.severity),
        source: diagnostic.source || LSP_OWNER,
        code: diagnostic.code?.toString()
      }))
    );
  }
}

function incrementalChange(previous: string, next: string): { range: LspRange; rangeLength: number; text: string } {
  let prefix = 0;
  const commonLength = Math.min(previous.length, next.length);
  while (prefix < commonLength && previous.charCodeAt(prefix) === next.charCodeAt(prefix)) prefix += 1;
  let previousSuffix = previous.length;
  let nextSuffix = next.length;
  while (previousSuffix > prefix && nextSuffix > prefix
    && previous.charCodeAt(previousSuffix - 1) === next.charCodeAt(nextSuffix - 1)) {
    previousSuffix -= 1;
    nextSuffix -= 1;
  }
  return {
    range: { start: positionForOffset(previous, prefix), end: positionForOffset(previous, previousSuffix) },
    rangeLength: previousSuffix - prefix,
    text: next.slice(prefix, nextSuffix)
  };
}

function positionForOffset(text: string, offset: number): LspPosition {
  const lines = text.slice(0, offset).split("\n");
  return { line: lines.length - 1, character: lines.at(-1)?.length ?? 0 };
}

function toMonacoDocumentSymbol(symbol: LspDocumentSymbol): monaco.languages.DocumentSymbol {
  return {
    name: symbol.name,
    detail: symbol.detail ?? "",
    kind: Math.max(0, symbol.kind - 1) as monaco.languages.SymbolKind,
    range: toMonacoRange(symbol.range),
    selectionRange: toMonacoRange(symbol.selectionRange),
    children: symbol.children?.map(toMonacoDocumentSymbol) ?? [],
    tags: []
  };
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

function toLspRange(range: monaco.IRange): LspRange {
  return {
    start: { line: range.startLineNumber - 1, character: range.startColumn - 1 },
    end: { line: range.endLineNumber - 1, character: range.endColumn - 1 }
  };
}

function toMonacoWorkspaceEdit(edit: import("./lspProtocol").LspWorkspaceEdit | undefined): monaco.languages.WorkspaceEdit | undefined {
  if (!edit) return undefined;
  return {
    edits: Object.entries(edit.changes ?? {}).flatMap(([uri, entries]) => entries.map((entry) => ({
      resource: monaco.Uri.parse(uri),
      textEdit: { range: toMonacoRange(entry.range), text: entry.newText },
      versionId: undefined
    })))
  };
}

function abortSignalForToken(token: monaco.CancellationToken): AbortController {
  const controller = new AbortController();
  if (token.isCancellationRequested) controller.abort();
  else token.onCancellationRequested(() => controller.abort());
  return controller;
}

function toCompletionItemKind(kind: number | undefined): monaco.languages.CompletionItemKind {
  if (kind === undefined) return monaco.languages.CompletionItemKind.Variable;
  const value = kind - 1;
  return value >= monaco.languages.CompletionItemKind.Method && value <= monaco.languages.CompletionItemKind.Issue
    ? value as monaco.languages.CompletionItemKind
    : monaco.languages.CompletionItemKind.Variable;
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
