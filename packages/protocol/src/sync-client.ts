import { decodeRequest, decodeResponse, encodeRequest, encodeResponse, WireCodecError } from "./codec.ts";
import { ERROR_CODES, HEADER_LENGTH, MAX_PAYLOAD_LENGTH, OPCODES, STATUS } from "./generated.ts";
import type { DecodedFrame, ErrorCode, FramePayload, OpenedSyncChannel, SyncRequestHandler, SyncRequestOptions, Status } from "./types.ts";

export const SYNC_CONTROL_INTS = 8;
export const SYNC_CONTROL_BYTES = SYNC_CONTROL_INTS * 4;
export const SYNC_STATE = Object.freeze({
  idle: 0,
  request: 1,
  response: 2,
  failed: 3,
  terminal: 4,
  writing: 5
});
export type SyncState = (typeof SYNC_STATE)[keyof typeof SYNC_STATE];

const INDEX_STATE = 0;
const INDEX_REQUEST_LENGTH = 1;
const INDEX_RESPONSE_LENGTH = 2;
const INDEX_GENERATION = 3;
const INDEX_ERROR_CODE = 4;

export class SyncChannelError extends Error {
  code: ErrorCode;

  constructor(code: ErrorCode, message: string) {
    super(message);
    this.name = "SyncChannelError";
    this.code = code;
  }
}

export function createSyncChannel(capacity = HEADER_LENGTH + MAX_PAYLOAD_LENGTH): SharedArrayBuffer {
  return new SharedArrayBuffer(SYNC_CONTROL_BYTES + capacity);
}

export function openSyncChannel(buffer: SharedArrayBuffer): OpenedSyncChannel {
  if (!(buffer instanceof SharedArrayBuffer)) {
    throw new SyncChannelError(ERROR_CODES.EINVAL, "sync channel requires SharedArrayBuffer");
  }
  if (buffer.byteLength <= SYNC_CONTROL_BYTES + HEADER_LENGTH) {
    throw new SyncChannelError(ERROR_CODES.EINVAL, "sync channel is too small");
  }
  return {
    buffer,
    control: new Int32Array(buffer, 0, SYNC_CONTROL_INTS),
    data: new Uint8Array(buffer, SYNC_CONTROL_BYTES)
  };
}

export function requestSync(channel: SharedArrayBuffer, request: Parameters<typeof encodeRequest>[0], options: SyncRequestOptions = {}): DecodedFrame {
  const opened = openSyncChannel(channel);
  const frame = encodeRequest(request);
  const generation = request.generation;
  const timeoutMs = options.timeoutMs ?? 1000;
  const deadline = Date.now() + timeoutMs;

  assertCapacity(opened, frame.byteLength);
  if (Atomics.compareExchange(opened.control, INDEX_STATE, SYNC_STATE.idle, SYNC_STATE.writing) !== SYNC_STATE.idle) {
    throw new SyncChannelError(ERROR_CODES.EBADMSG, "sync channel already has an in-flight request");
  }

  opened.data.set(frame);
  Atomics.store(opened.control, INDEX_REQUEST_LENGTH, frame.byteLength);
  Atomics.store(opened.control, INDEX_RESPONSE_LENGTH, 0);
  Atomics.store(opened.control, INDEX_GENERATION, generation);
  Atomics.store(opened.control, INDEX_ERROR_CODE, 0);
  const publishedState = Atomics.compareExchange(opened.control, INDEX_STATE, SYNC_STATE.writing, SYNC_STATE.request);
  if (publishedState !== SYNC_STATE.writing) {
    throw new SyncChannelError(ERROR_CODES.EBADMSG, "sync channel terminated while publishing request");
  }
  Atomics.notify(opened.control, INDEX_STATE);

  let state = Atomics.load(opened.control, INDEX_STATE);
  while (state === SYNC_STATE.request) {
    const remainingMs = deadline - Date.now();
    if (remainingMs <= 0) {
      Atomics.store(opened.control, INDEX_STATE, SYNC_STATE.idle);
      Atomics.notify(opened.control, INDEX_STATE);
      throw new SyncChannelError(ERROR_CODES.EBADMSG, "sync request timed out");
    }
    Atomics.wait(opened.control, INDEX_STATE, SYNC_STATE.request, remainingMs);
    state = Atomics.load(opened.control, INDEX_STATE);
  }

  if (state === SYNC_STATE.terminal) {
    throw new SyncChannelError(ERROR_CODES.EBADMSG, "sync channel terminated while waiting");
  }
  if (state === SYNC_STATE.failed) {
    const code = (Atomics.load(opened.control, INDEX_ERROR_CODE) || ERROR_CODES.EBADMSG) as ErrorCode;
    throw new SyncChannelError(code, "sync channel failed while waiting");
  }
  if (state !== SYNC_STATE.response) {
    throw new SyncChannelError(ERROR_CODES.EBADMSG, `unexpected sync channel state ${state}`);
  }

  if (Atomics.load(opened.control, INDEX_GENERATION) !== generation) {
    Atomics.store(opened.control, INDEX_STATE, SYNC_STATE.idle);
    Atomics.notify(opened.control, INDEX_STATE);
    throw new SyncChannelError(ERROR_CODES.EBADMSG, "stale sync channel generation");
  }

  const responseLength = Atomics.load(opened.control, INDEX_RESPONSE_LENGTH);
  const response = opened.data.slice(0, responseLength);
  Atomics.store(opened.control, INDEX_STATE, SYNC_STATE.idle);
  Atomics.notify(opened.control, INDEX_STATE);
  return decodeResponse(response);
}

export function waitForRequest(channel: SharedArrayBuffer, options: SyncRequestOptions = {}): DecodedFrame {
  const opened = openSyncChannel(channel);
  const timeoutMs = options.timeoutMs ?? 1000;
  const deadline = Date.now() + timeoutMs;
  let state = Atomics.load(opened.control, INDEX_STATE);

  while (state === SYNC_STATE.idle || state === SYNC_STATE.response || state === SYNC_STATE.writing) {
    const remainingMs = deadline - Date.now();
    if (remainingMs <= 0) break;
    Atomics.wait(opened.control, INDEX_STATE, state, remainingMs);
    state = Atomics.load(opened.control, INDEX_STATE);
  }

  if (state === SYNC_STATE.idle || state === SYNC_STATE.response || state === SYNC_STATE.writing) {
    throw new SyncChannelError(ERROR_CODES.EBADMSG, "timed out waiting for request");
  }
  if (state === SYNC_STATE.terminal) {
    throw new SyncChannelError(ERROR_CODES.EBADMSG, "sync channel terminated");
  }
  if (state !== SYNC_STATE.request) {
    throw new SyncChannelError(ERROR_CODES.EBADMSG, `expected request state, got ${state}`);
  }

  const requestLength = Atomics.load(opened.control, INDEX_REQUEST_LENGTH);
  const request = opened.data.slice(0, requestLength);
  try {
    return decodeRequest(request);
  } catch (error) {
    const code = error instanceof WireCodecError ? error.code : ERROR_CODES.EBADMSG;
    failSync(channel, code);
    throw error;
  }
}

export function respondSync(channel: SharedArrayBuffer, request: DecodedFrame, payload: FramePayload = new Uint8Array()): void {
  writeResponse(channel, request, STATUS.ok, payload);
}

export function respondErrorSync(channel: SharedArrayBuffer, request: DecodedFrame, payload: FramePayload = new Uint8Array()): void {
  writeResponse(channel, request, STATUS.error, payload);
}

function writeResponse(channel: SharedArrayBuffer, request: DecodedFrame, status: Status, payload: FramePayload): void {
  const opened = openSyncChannel(channel);
  const response = encodeResponse({
    requestId: request.requestId,
    generation: request.generation,
    pid: request.pid,
    opcode: request.opcode,
    status,
    payload
  });
  assertCapacity(opened, response.byteLength);
  opened.data.set(response);
  Atomics.store(opened.control, INDEX_RESPONSE_LENGTH, response.byteLength);
  Atomics.store(opened.control, INDEX_GENERATION, request.generation);
  Atomics.store(opened.control, INDEX_STATE, SYNC_STATE.response);
  Atomics.notify(opened.control, INDEX_STATE);
}

export function failSync(channel: SharedArrayBuffer, code: ErrorCode = ERROR_CODES.EBADMSG): void {
  const opened = openSyncChannel(channel);
  Atomics.store(opened.control, INDEX_ERROR_CODE, code);
  Atomics.store(opened.control, INDEX_STATE, SYNC_STATE.failed);
  Atomics.notify(opened.control, INDEX_STATE);
}

export function markTerminal(channel: SharedArrayBuffer): void {
  const opened = openSyncChannel(channel);
  Atomics.store(opened.control, INDEX_STATE, SYNC_STATE.terminal);
  Atomics.notify(opened.control, INDEX_STATE);
}

export function handleOneRequest(channel: SharedArrayBuffer, handler: SyncRequestHandler, options: SyncRequestOptions = {}): DecodedFrame {
  const request = waitForRequest(channel, options);
  const payload = handler(request);
  respondSync(channel, request, payload);
  return request;
}

export function handlePingRequest(channel: SharedArrayBuffer, options: SyncRequestOptions = {}): DecodedFrame {
  return handleOneRequest(channel, (request) => {
    if (request.opcode !== OPCODES.ping) {
      throw new SyncChannelError(ERROR_CODES.ENOSYS, `unsupported syscall opcode ${request.opcode}`);
    }
    return new TextEncoder().encode("pong");
  }, options);
}

function assertCapacity(opened: OpenedSyncChannel, byteLength: number): void {
  if (byteLength > opened.data.byteLength) {
    throw new SyncChannelError(ERROR_CODES.E2BIG, "frame exceeds sync channel capacity");
  }
}
