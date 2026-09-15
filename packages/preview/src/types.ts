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

export type PreviewErrorCode = "EBADMESSAGE" | "ENOCLIENT" | "ENOSERVER" | "ESTALESESSION" | "ETIMEOUT" | "EUNKNOWN" | (string & {});

export type HmrEventType = "open" | "message" | "close" | (string & {});
export type HmrListener<T = unknown> = (payload: T) => void;

export interface HmrClientError {
  code: "EBADMESSAGE" | (string & {});
  message: string;
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
