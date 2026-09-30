import ts from "typescript";

import type {
  LspCodeAction,
  LspCompletionItem,
  LspContentChange,
  LspDiagnostic,
  LspDocumentSymbol,
  LspHover,
  LspLocation,
  LspPosition,
  LspRange,
  LspSemanticTokens,
  LspSignatureHelp,
  LspTextEdit,
  LspWorkspaceEdit
} from "./lspProtocol.ts";

interface ProjectDocument {
  fileName: string;
  languageId: string;
  text: string;
  uri: string;
  version: number;
}

const ROOT_PATH = "/workspace";
const VIRTUAL_LIB_PATH = "/__nuriteo__/lib.d.ts";
const FORMAT_OPTIONS: ts.FormatCodeSettings = {
  convertTabsToSpaces: true,
  indentSize: 2,
  newLineCharacter: "\n",
  semicolons: ts.SemicolonPreference.Insert,
  tabSize: 2
};
const USER_PREFERENCES: ts.UserPreferences = {
  includeCompletionsForModuleExports: true,
  includeCompletionsWithInsertText: true
};
const SEMANTIC_TOKEN_TYPES = [
  "class",
  "enum",
  "interface",
  "namespace",
  "typeParameter",
  "type",
  "parameter",
  "variable",
  "enumMember",
  "property",
  "function",
  "method"
] as const;

const VIRTUAL_LIB = `
interface Array<T> { readonly length: number; [index: number]: T; }
interface ReadonlyArray<T> { readonly length: number; [index: number]: T; }
interface String { readonly length: number; }
interface Number {}
interface Boolean {}
interface Function {}
interface Object {}
interface RegExp {}
interface IArguments { readonly length: number; [index: number]: any; }
interface PromiseLike<T> { then<TResult>(onfulfilled?: (value: T) => TResult | PromiseLike<TResult>): PromiseLike<TResult>; }
interface Promise<T> extends PromiseLike<T> {}
type Readonly<T> = { readonly [P in keyof T]: T[P] };
interface HTMLElement {}
declare const console: { log(...data: unknown[]): void; error(...data: unknown[]): void; warn(...data: unknown[]): void };
declare const document: { getElementById(id: string): HTMLElement | null };
declare namespace JSX { interface IntrinsicElements { [element: string]: any; } }
declare namespace React { type ReactNode = unknown; }
declare module "react" {
  export const StrictMode: (props: { children?: unknown }) => unknown;
  export type ReactNode = unknown;
  export function useState<T>(initial: T): [T, (value: T | ((previous: T) => T)) => void];
}
declare module "react/jsx-runtime" {
  export const Fragment: unknown;
  export function jsx(type: unknown, props: unknown, key?: unknown): unknown;
  export function jsxs(type: unknown, props: unknown, key?: unknown): unknown;
}
declare module "react-dom/client" {
  export function createRoot(container: HTMLElement): { render(node: unknown): void };
}
`;

export class TypeScriptProject {
  readonly #documents = new Map<string, ProjectDocument>();
  readonly #service: ts.LanguageService;
  #projectVersion = 0;

  constructor() {
    const host: ts.LanguageServiceHost = {
      fileExists: (fileName) => fileName === VIRTUAL_LIB_PATH || this.#documents.has(fileName),
      getCompilationSettings: () => ({
        allowJs: true,
        allowImportingTsExtensions: true,
        allowNonTsExtensions: true,
        checkJs: true,
        jsx: ts.JsxEmit.ReactJSX,
        module: ts.ModuleKind.ESNext,
        moduleResolution: ts.ModuleResolutionKind.Bundler,
        noLib: true,
        strict: true,
        target: ts.ScriptTarget.ES2022
      }),
      getCurrentDirectory: () => ROOT_PATH,
      getDefaultLibFileName: () => VIRTUAL_LIB_PATH,
      getNewLine: () => "\n",
      getProjectVersion: () => String(this.#projectVersion),
      getScriptFileNames: () => [VIRTUAL_LIB_PATH, ...this.#documents.keys()],
      getScriptKind: (fileName) => scriptKind(fileName),
      getScriptSnapshot: (fileName) => {
        const text = fileName === VIRTUAL_LIB_PATH ? VIRTUAL_LIB : this.#documents.get(fileName)?.text;
        return text === undefined ? undefined : ts.ScriptSnapshot.fromString(text);
      },
      getScriptVersion: (fileName) => fileName === VIRTUAL_LIB_PATH ? "1" : String(this.#documents.get(fileName)?.version ?? 0),
      readDirectory: () => [...this.#documents.keys()],
      readFile: (fileName) => fileName === VIRTUAL_LIB_PATH ? VIRTUAL_LIB : this.#documents.get(fileName)?.text,
      useCaseSensitiveFileNames: () => true
    };
    this.#service = ts.createLanguageService(host, ts.createDocumentRegistry(true, ROOT_PATH));
  }

  open(document: { uri: string; languageId: string; version: number; text: string }): void {
    const fileName = fileNameForUri(document.uri);
    this.#documents.set(fileName, { ...document, fileName });
    this.#projectVersion += 1;
  }

  change(uri: string, version: number, changes: LspContentChange[]): boolean {
    const fileName = fileNameForUri(uri);
    const document = this.#documents.get(fileName);
    if (!document || version <= document.version) return false;
    let text = document.text;
    for (const change of changes) text = applyContentChange(text, change);
    this.#documents.set(fileName, { ...document, text, version });
    this.#projectVersion += 1;
    return true;
  }

  close(uri: string): void {
    this.#documents.delete(fileNameForUri(uri));
    this.#projectVersion += 1;
  }

  dispose(): void {
    this.#documents.clear();
    this.#service.dispose();
  }

  version(uri: string): number | undefined {
    return this.#documents.get(fileNameForUri(uri))?.version;
  }

  text(uri: string): string | undefined {
    return this.#documents.get(fileNameForUri(uri))?.text;
  }

  uris(): string[] {
    return [...this.#documents.values()].map((document) => document.uri);
  }

  diagnostics(uri: string): LspDiagnostic[] {
    const document = this.#requiredDocument(uri);
    return [
      ...this.#service.getSyntacticDiagnostics(document.fileName),
      ...this.#service.getSemanticDiagnostics(document.fileName),
      ...this.#service.getSuggestionDiagnostics(document.fileName)
    ].filter((diagnostic) => !isUnavailableExternalTypeDiagnostic(diagnostic, document.text)).map((diagnostic) => ({
      range: rangeForTextSpan(document.text, { start: diagnostic.start ?? 0, length: diagnostic.length ?? 1 }),
      severity: diagnosticSeverity(diagnostic.category),
      code: diagnostic.code,
      source: "typescript",
      message: ts.flattenDiagnosticMessageText(diagnostic.messageText, "\n")
    }));
  }

  completion(uri: string, position: LspPosition): LspCompletionItem[] {
    const document = this.#requiredDocument(uri);
    const offset = offsetForPosition(document.text, position);
    const completion = this.#service.getCompletionsAtPosition(document.fileName, offset, USER_PREFERENCES);
    return (completion?.entries ?? []).slice(0, 500).map((entry) => {
      const details = this.#service.getCompletionEntryDetails(
        document.fileName,
        offset,
        entry.name,
        FORMAT_OPTIONS,
        entry.source,
        USER_PREFERENCES,
        entry.data
      );
      return {
        label: entry.name,
        kind: completionKind(entry.kind),
        ...(details?.displayParts ? { detail: ts.displayPartsToString(details.displayParts) } : {}),
        ...(details?.documentation ? { documentation: ts.displayPartsToString(details.documentation) } : {}),
        ...(entry.insertText ? { insertText: entry.insertText } : {})
      };
    });
  }

  definition(uri: string, position: LspPosition): LspLocation[] {
    const document = this.#requiredDocument(uri);
    return (this.#service.getDefinitionAtPosition(document.fileName, offsetForPosition(document.text, position)) ?? [])
      .flatMap((definition) => this.#location(definition.fileName, definition.textSpan));
  }

  references(uri: string, position: LspPosition): LspLocation[] {
    const document = this.#requiredDocument(uri);
    return (this.#service.getReferencesAtPosition(document.fileName, offsetForPosition(document.text, position)) ?? [])
      .flatMap((reference) => this.#location(reference.fileName, reference.textSpan));
  }

  hover(uri: string, position: LspPosition): LspHover | null {
    const document = this.#requiredDocument(uri);
    const info = this.#service.getQuickInfoAtPosition(document.fileName, offsetForPosition(document.text, position));
    if (!info) return null;
    const signature = ts.displayPartsToString(info.displayParts);
    const documentation = ts.displayPartsToString(info.documentation);
    return {
      contents: { kind: "markdown", value: [`\`\`\`typescript\n${signature}\n\`\`\``, documentation].filter(Boolean).join("\n\n") },
      range: rangeForTextSpan(document.text, info.textSpan)
    };
  }

  signatureHelp(uri: string, position: LspPosition): LspSignatureHelp | null {
    const document = this.#requiredDocument(uri);
    const help = this.#service.getSignatureHelpItems(document.fileName, offsetForPosition(document.text, position), undefined);
    if (!help) return null;
    return {
      signatures: help.items.map((item) => ({
        label: `${ts.displayPartsToString(item.prefixDisplayParts)}${item.parameters.map((parameter) => ts.displayPartsToString(parameter.displayParts)).join(ts.displayPartsToString(item.separatorDisplayParts))}${ts.displayPartsToString(item.suffixDisplayParts)}`,
        documentation: ts.displayPartsToString(item.documentation),
        parameters: item.parameters.map((parameter) => ({
          label: ts.displayPartsToString(parameter.displayParts),
          documentation: ts.displayPartsToString(parameter.documentation)
        }))
      })),
      activeSignature: help.selectedItemIndex,
      activeParameter: help.argumentIndex
    };
  }

  prepareRename(uri: string, position: LspPosition): { range: LspRange; placeholder: string } | null {
    const document = this.#requiredDocument(uri);
    const info = this.#service.getRenameInfo(document.fileName, offsetForPosition(document.text, position), USER_PREFERENCES);
    if (!info.canRename) return null;
    return { range: rangeForTextSpan(document.text, info.triggerSpan), placeholder: info.displayName };
  }

  rename(uri: string, position: LspPosition, newName: string): LspWorkspaceEdit {
    if (!ts.isIdentifierText(newName, ts.ScriptTarget.ESNext)) throw new Error("Rename target is not a valid identifier.");
    const document = this.#requiredDocument(uri);
    const locations = this.#service.findRenameLocations(
      document.fileName,
      offsetForPosition(document.text, position),
      false,
      false,
      USER_PREFERENCES
    ) ?? [];
    const changes: Record<string, LspTextEdit[]> = {};
    for (const location of locations) {
      const target = this.#documents.get(location.fileName);
      if (!target) continue;
      (changes[target.uri] ||= []).push({ range: rangeForTextSpan(target.text, location.textSpan), newText: newName });
    }
    return { changes };
  }

  documentSymbols(uri: string): LspDocumentSymbol[] {
    const document = this.#requiredDocument(uri);
    return this.#service.getNavigationTree(document.fileName).childItems?.map((item) => navigationSymbol(document.text, item)) ?? [];
  }

  workspaceSymbols(query: string): Array<LspDocumentSymbol & { location: LspLocation }> {
    return this.#service.getNavigateToItems(query, 200, undefined, true, true).flatMap((item) => {
      const document = this.#documents.get(item.fileName);
      if (!document) return [];
      const range = rangeForTextSpan(document.text, item.textSpan);
      return [{ name: item.name, kind: symbolKind(item.kind), range, selectionRange: range, location: { uri: document.uri, range } }];
    });
  }

  format(uri: string): LspTextEdit[] {
    const document = this.#requiredDocument(uri);
    return this.#service.getFormattingEditsForDocument(document.fileName, FORMAT_OPTIONS)
      .map((edit) => ({ range: rangeForTextSpan(document.text, edit.span), newText: edit.newText }));
  }

  codeActions(uri: string, range: LspRange, diagnosticCodes: number[]): LspCodeAction[] {
    const document = this.#requiredDocument(uri);
    const start = offsetForPosition(document.text, range.start);
    const end = offsetForPosition(document.text, range.end);
    return this.#service.getCodeFixesAtPosition(document.fileName, start, end, diagnosticCodes, FORMAT_OPTIONS, USER_PREFERENCES)
      .map((fix) => ({ title: fix.description, kind: "quickfix", edit: workspaceEdit(fix.changes, this.#documents) }));
  }

  semanticTokens(uri: string): LspSemanticTokens {
    const document = this.#requiredDocument(uri);
    const classifications = this.#service.getEncodedSemanticClassifications(
      document.fileName,
      { start: 0, length: document.text.length },
      ts.SemanticClassificationFormat.TwentyTwenty
    ).spans;
    const absolute: Array<{ line: number; character: number; length: number; tokenType: number; modifiers: number }> = [];
    for (let index = 0; index < classifications.length; index += 3) {
      const start = classifications[index] ?? 0;
      const length = classifications[index + 1] ?? 0;
      const encoded = classifications[index + 2] ?? 0;
      const tokenType = (encoded >> 8) - 1;
      if (tokenType < 0 || tokenType >= SEMANTIC_TOKEN_TYPES.length) continue;
      const position = positionForOffset(document.text, start);
      absolute.push({ line: position.line, character: position.character, length, tokenType, modifiers: encoded & 255 });
    }
    let previousLine = 0;
    let previousCharacter = 0;
    const data: number[] = [];
    for (const token of absolute) {
      const deltaLine = token.line - previousLine;
      const deltaCharacter = deltaLine === 0 ? token.character - previousCharacter : token.character;
      data.push(deltaLine, deltaCharacter, token.length, token.tokenType, token.modifiers);
      previousLine = token.line;
      previousCharacter = token.character;
    }
    return { data };
  }

  static semanticTokenTypes(): readonly string[] {
    return SEMANTIC_TOKEN_TYPES;
  }

  #requiredDocument(uri: string): ProjectDocument {
    const document = this.#documents.get(fileNameForUri(uri));
    if (!document) throw new Error(`Document is not open: ${uri}`);
    return document;
  }

  #location(fileName: string, span: ts.TextSpan): LspLocation[] {
    const document = this.#documents.get(fileName);
    return document ? [{ uri: document.uri, range: rangeForTextSpan(document.text, span) }] : [];
  }
}

function isUnavailableExternalTypeDiagnostic(diagnostic: ts.Diagnostic, source: string): boolean {
  if (diagnostic.code === 2688 || diagnostic.code === 2875) return true;
  if (diagnostic.code === 2882) {
    const specifier = source.slice(diagnostic.start ?? 0, (diagnostic.start ?? 0) + (diagnostic.length ?? 0));
    return /\.(?:css|scss|sass|less|svg|png|jpe?g|gif|webp|wasm)['"]?$/.test(specifier);
  }
  if (diagnostic.code !== 2307) return false;
  const message = ts.flattenDiagnosticMessageText(diagnostic.messageText, "\n");
  const specifier = /Cannot find module '([^']+)'/.exec(message)?.[1];
  return Boolean(specifier && !specifier.startsWith("."));
}

function fileNameForUri(uri: string): string {
  const parsed = new URL(uri);
  if (parsed.protocol !== "file:" || !parsed.pathname.startsWith(`${ROOT_PATH}/`)) {
    throw new Error(`Language server URI is outside the workspace: ${uri}`);
  }
  return decodeURIComponent(parsed.pathname);
}

function applyContentChange(text: string, change: LspContentChange): string {
  if (!change.range) return change.text;
  const start = offsetForPosition(text, change.range.start);
  const end = offsetForPosition(text, change.range.end);
  return `${text.slice(0, start)}${change.text}${text.slice(end)}`;
}

function offsetForPosition(text: string, position: LspPosition): number {
  const lines = text.split("\n");
  if (position.line < 0 || position.line >= lines.length) throw new Error("LSP position line is outside the document.");
  const line = lines[position.line] ?? "";
  if (position.character < 0 || position.character > line.length) throw new Error("LSP position character is outside the document.");
  let offset = position.character;
  for (let index = 0; index < position.line; index += 1) offset += (lines[index]?.length ?? 0) + 1;
  return offset;
}

function positionForOffset(text: string, offset: number): LspPosition {
  const before = text.slice(0, Math.max(0, Math.min(text.length, offset)));
  const lines = before.split("\n");
  return { line: lines.length - 1, character: lines.at(-1)?.length ?? 0 };
}

function rangeForTextSpan(text: string, span: ts.TextSpan): LspRange {
  return { start: positionForOffset(text, span.start), end: positionForOffset(text, span.start + span.length) };
}

function diagnosticSeverity(category: ts.DiagnosticCategory): 1 | 2 | 3 | 4 {
  if (category === ts.DiagnosticCategory.Error) return 1;
  if (category === ts.DiagnosticCategory.Warning) return 2;
  if (category === ts.DiagnosticCategory.Suggestion) return 4;
  return 3;
}

function completionKind(kind: ts.ScriptElementKind): number {
  if (kind === ts.ScriptElementKind.classElement) return 7;
  if (kind === ts.ScriptElementKind.interfaceElement || kind === ts.ScriptElementKind.typeElement) return 8;
  if (kind === ts.ScriptElementKind.functionElement) return 3;
  if (kind === ts.ScriptElementKind.memberFunctionElement || kind === ts.ScriptElementKind.memberGetAccessorElement || kind === ts.ScriptElementKind.memberSetAccessorElement) return 2;
  if (kind === ts.ScriptElementKind.constElement || kind === ts.ScriptElementKind.letElement || kind === ts.ScriptElementKind.variableElement) return 6;
  return 1;
}

function symbolKind(kind: ts.ScriptElementKind): number {
  if (kind === ts.ScriptElementKind.classElement) return 5;
  if (kind === ts.ScriptElementKind.interfaceElement) return 11;
  if (kind === ts.ScriptElementKind.functionElement) return 12;
  if (kind === ts.ScriptElementKind.memberFunctionElement) return 6;
  if (kind === ts.ScriptElementKind.moduleElement) return 3;
  return 13;
}

function navigationSymbol(text: string, item: ts.NavigationTree): LspDocumentSymbol {
  const span = item.spans[0] ?? { start: 0, length: 0 };
  const range = rangeForTextSpan(text, span);
  return {
    name: item.text,
    detail: item.kindModifiers,
    kind: symbolKind(item.kind),
    range,
    selectionRange: range,
    ...(item.childItems?.length ? { children: item.childItems.map((child) => navigationSymbol(text, child)) } : {})
  };
}

function workspaceEdit(changes: readonly ts.FileTextChanges[], documents: Map<string, ProjectDocument>): LspWorkspaceEdit {
  const edit: LspWorkspaceEdit = { changes: {} };
  for (const change of changes) {
    const document = documents.get(change.fileName);
    if (!document) continue;
    edit.changes![document.uri] = change.textChanges.map((entry) => ({
      range: rangeForTextSpan(document.text, entry.span),
      newText: entry.newText
    }));
  }
  return edit;
}

function scriptKind(fileName: string): ts.ScriptKind {
  const lower = fileName.toLowerCase();
  if (lower.endsWith(".tsx")) return ts.ScriptKind.TSX;
  if (lower.endsWith(".jsx")) return ts.ScriptKind.JSX;
  if (lower.endsWith(".js") || lower.endsWith(".mjs") || lower.endsWith(".cjs")) return ts.ScriptKind.JS;
  return ts.ScriptKind.TS;
}
