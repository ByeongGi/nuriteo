export interface PreviewContainer {
  fetch?: (input: string, init?: RequestInit) => Promise<Response>;
}

export interface PreviewSession {
  sessionId: string;
  origin: string;
  projectId: string;
  port: number;
  baseUrl: string;
  serverState: "running" | "stopped";
  lastErrorCode: PreviewErrorCode | null;
  container: PreviewContainer;
  createdAt: number;
  touchedAt: number;
}

export interface PreviewSessionLookup {
  origin?: string;
  projectId?: string;
  port?: number;
}

export interface PreviewSessionCreateInput {
  origin: string;
  projectId: string;
  port: number;
  container: PreviewContainer;
}

export interface PreviewSessionRegistryOptions {
  now?: () => number;
  ttlMs?: number;
}

export interface PreviewRelayRequest {
  sessionId: string;
  origin: string;
  projectId: string;
  path?: string;
  method?: string;
  headers?: HeadersInit;
  body?: BodyInit | null;
}

export interface PreviewRelayLike {
  request(input: PreviewRelayRequest): Promise<Response>;
}

export interface PreviewTraceSink {
  startSpan(input: {
    category: "preview";
    name: string;
    requestId?: string | number;
    attributes?: Record<string, string | number | boolean | null>;
  }): {
    end(input?: {
      status?: "ok" | "error";
      errorCode?: string;
      attributes?: Record<string, string | number | boolean | null>;
    }): unknown;
  };
}

export type PreviewErrorCode = "EBADMESSAGE" | "ENOCLIENT" | "ENOSERVER" | "ESTALESESSION" | "ETIMEOUT" | "EUNKNOWN" | (string & {});

export interface PreviewDiagnostic {
  at: number;
  source: "build" | "console" | "hmr" | "relay" | "runtime" | "service-worker";
  level: "log" | "info" | "warn" | "error";
  message: string;
  clientId?: string;
  code?: PreviewErrorCode;
  column?: number;
  file?: string;
  line?: number;
  recoveryActions?: PreviewRecoveryAction[];
  stack?: string;
}

export interface PreviewRecoveryAction {
  kind: "open-file" | "restart-dev-server" | "rerun-build" | "show-terminal";
  label: string;
  command?: string;
  path?: string;
}

export type PreviewErrorStage = "build" | "hmr" | "runtime";

export interface PreviewErrorDiagnosticInput {
  source: PreviewErrorStage;
  message: string;
  clientId?: string;
  code?: PreviewErrorCode;
  column?: number;
  file?: string;
  line?: number;
  recoveryActions?: PreviewRecoveryAction[];
  stack?: string;
}

export interface PreviewOverlayState {
  diagnostics: PreviewDiagnostic[];
  lastError: PreviewDiagnostic | null;
}

export interface PreviewOverlayMessage {
  type: "preview:overlay";
  clientId?: string;
  state: PreviewOverlayState;
  diagnostic: PreviewDiagnostic;
}

export type HmrEventType = "open" | "message" | "close" | (string & {});
export type HmrListener<T = unknown> = (payload: T) => void;

export interface HmrClientError {
  code: "EBADMESSAGE" | (string & {});
  message: string;
}

export type HmrClientState = "idle" | "connected" | "reconnecting" | "closed" | "error";

export interface HmrClientSnapshot {
  state: HmrClientState;
  retryCount: number;
  maxRetries: number;
  lastError: HmrClientError | null;
}

export interface HmrSocket {
  onmessage?: (event: { data: string }) => void;
  onclose?: () => void;
  close?: () => void;
  sendMessage?: (payload: unknown) => void;
}

export interface HmrClientOptions {
  connect?: () => HmrSocket;
  maxRetries?: number;
  reconnectDelayMs?: number;
}
