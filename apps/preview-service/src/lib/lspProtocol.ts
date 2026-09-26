export type JsonRpcId = number | string;

export interface JsonRpcRequest {
  jsonrpc: "2.0";
  id: JsonRpcId;
  method: string;
  params?: unknown;
}

export interface JsonRpcNotification {
  jsonrpc: "2.0";
  method: string;
  params?: unknown;
}

export interface JsonRpcResponse {
  jsonrpc: "2.0";
  id: JsonRpcId;
  result?: unknown;
  error?: { code: number; message: string; data?: unknown };
}

export type JsonRpcMessage = JsonRpcRequest | JsonRpcNotification | JsonRpcResponse;

export interface LspPosition {
  line: number;
  character: number;
}

export interface LspRange {
  start: LspPosition;
  end: LspPosition;
}

export interface LspDiagnostic {
  range: LspRange;
  severity?: 1 | 2 | 3 | 4;
  code?: string | number;
  source?: string;
  message: string;
}

export interface LspLocation {
  uri: string;
  range: LspRange;
}

export interface LspCompletionItem {
  label: string;
  kind?: number;
  detail?: string;
  insertText?: string;
}

export interface LspTextEdit {
  range: LspRange;
  newText: string;
}

export interface LspWorkspaceEdit {
  changes?: Record<string, LspTextEdit[]>;
}

export interface LspPublishDiagnosticsParams {
  uri: string;
  diagnostics: LspDiagnostic[];
}

export function isJsonRpcResponse(message: JsonRpcMessage): message is JsonRpcResponse {
  return "id" in message && !("method" in message);
}

export function isJsonRpcNotification(message: JsonRpcMessage): message is JsonRpcNotification {
  return "method" in message && !("id" in message);
}
