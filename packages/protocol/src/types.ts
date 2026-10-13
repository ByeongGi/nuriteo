import type { ERROR_CODES, OPCODES, STATUS } from "./generated.ts";

export type ErrorCode = (typeof ERROR_CODES)[keyof typeof ERROR_CODES];
export type Opcode = (typeof OPCODES)[keyof typeof OPCODES];
export type Status = (typeof STATUS)[keyof typeof STATUS];

export type RuntimeRole = "system" | "process" | "host" | (string & {});
export type MessageDetails = Record<string, unknown>;

export interface ReadyMessage {
  type: "ready";
  protocolVersion: number;
  role: RuntimeRole;
  details: MessageDetails;
}

export interface FailedMessage {
  type: "failed";
  protocolVersion: number;
  role: RuntimeRole;
  error: string;
}

export type RuntimeLifecycleMessage = ReadyMessage | FailedMessage;

export type FramePayload = string | ArrayBuffer | ArrayBufferView | Uint8Array;

export interface FrameFields {
  requestId: number;
  generation: number;
  pid: number;
  opcode: Opcode;
  status: Status;
}

export interface RequestFrameInput extends Omit<FrameFields, "status"> {
  payload?: FramePayload;
}

export interface ResponseFrameInput extends Omit<FrameFields, "status"> {
  status?: Status;
  payload?: FramePayload;
}

export interface DecodedFrame extends FrameFields {
  payload: Uint8Array;
}

export interface OpenedSyncChannel {
  buffer: SharedArrayBuffer;
  control: Int32Array;
  data: Uint8Array;
}

export interface SyncRequestOptions {
  timeoutMs?: number;
}

export type SyncRequestHandler = (request: DecodedFrame) => FramePayload;
