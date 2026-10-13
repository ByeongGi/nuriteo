import { ABI_VERSION, ERROR_CODES, HEADER_LENGTH, MAGIC, MAX_PAYLOAD_LENGTH, OPCODES, STATUS } from "./generated.ts";
import type { DecodedFrame, ErrorCode, FrameFields, FramePayload, RequestFrameInput, ResponseFrameInput } from "./types.ts";

const knownOpcodes: Set<number> = new Set(Object.values(OPCODES));
const encoder = new TextEncoder();

export class WireCodecError extends Error {
  code: ErrorCode;

  constructor(code: ErrorCode, message: string) {
    super(message);
    this.name = "WireCodecError";
    this.code = code;
  }
}

function toPayloadBytes(payload: FramePayload = new Uint8Array()): Uint8Array {
  if (typeof payload === "string") {
    return encoder.encode(payload);
  }
  if (payload instanceof Uint8Array) {
    return payload;
  }
  if (ArrayBuffer.isView(payload)) {
    return new Uint8Array(payload.buffer, payload.byteOffset, payload.byteLength);
  }
  if (payload instanceof ArrayBuffer) {
    return new Uint8Array(payload);
  }
  throw new WireCodecError(ERROR_CODES.EINVAL, "payload must be bytes or a string");
}

function assertU32(name: string, value: number): void {
  if (!Number.isInteger(value) || value < 0 || value > 0xffffffff) {
    throw new WireCodecError(ERROR_CODES.EINVAL, `${name} must be a u32`);
  }
}

function assertU16(name: string, value: number): void {
  if (!Number.isInteger(value) || value < 0 || value > 0xffff) {
    throw new WireCodecError(ERROR_CODES.EINVAL, `${name} must be a u16`);
  }
}

function assertKnownOpcode(opcode: number): asserts opcode is RequestFrameInput["opcode"] {
  assertU16("opcode", opcode);
  if (!knownOpcodes.has(opcode)) {
    throw new WireCodecError(ERROR_CODES.ENOSYS, `unknown opcode ${opcode}`);
  }
}

function encodeFrame(fields: FrameFields, payload: Uint8Array): Uint8Array {
  if (payload.byteLength > MAX_PAYLOAD_LENGTH) {
    throw new WireCodecError(ERROR_CODES.E2BIG, "payload exceeds maxPayloadLength");
  }

  const bytes = new Uint8Array(HEADER_LENGTH + payload.byteLength);
  const view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
  view.setUint32(0, MAGIC, true);
  view.setUint16(4, ABI_VERSION, true);
  view.setUint16(6, HEADER_LENGTH, true);
  view.setUint32(8, fields.requestId, true);
  view.setUint32(12, fields.generation, true);
  view.setUint32(16, fields.pid, true);
  view.setUint16(20, fields.opcode, true);
  view.setUint16(22, fields.status, true);
  view.setUint32(24, payload.byteLength, true);
  view.setUint32(28, 0, true);
  bytes.set(payload, HEADER_LENGTH);
  return bytes;
}

export function encodeRequest({ requestId, generation, pid, opcode, payload = new Uint8Array() }: RequestFrameInput): Uint8Array {
  assertU32("requestId", requestId);
  assertU32("generation", generation);
  assertU32("pid", pid);
  assertKnownOpcode(opcode);
  return encodeFrame({ requestId, generation, pid, opcode, status: STATUS.request }, toPayloadBytes(payload));
}

export function encodeResponse({ requestId, generation, pid, opcode, status = STATUS.ok, payload = new Uint8Array() }: ResponseFrameInput): Uint8Array {
  assertU32("requestId", requestId);
  assertU32("generation", generation);
  assertU32("pid", pid);
  assertKnownOpcode(opcode);
  assertU16("status", status);
  if (status !== STATUS.ok && status !== STATUS.error) {
    throw new WireCodecError(ERROR_CODES.EINVAL, "response status must be ok or error");
  }
  return encodeFrame({ requestId, generation, pid, opcode, status }, toPayloadBytes(payload));
}

export function decodeFrame(bytes: ArrayBuffer | ArrayBufferView | Uint8Array): DecodedFrame {
  const frame = bytes instanceof Uint8Array
    ? bytes
    : ArrayBuffer.isView(bytes)
      ? new Uint8Array(bytes.buffer, bytes.byteOffset, bytes.byteLength)
      : new Uint8Array(bytes);
  if (frame.byteLength < HEADER_LENGTH) {
    throw new WireCodecError(ERROR_CODES.EBADMSG, "frame is shorter than header");
  }

  const view = new DataView(frame.buffer, frame.byteOffset, frame.byteLength);
  const magic = view.getUint32(0, true);
  const abiVersion = view.getUint16(4, true);
  const headerLength = view.getUint16(6, true);
  const payloadLength = view.getUint32(24, true);
  const reserved = view.getUint32(28, true);

  if (magic !== MAGIC) {
    throw new WireCodecError(ERROR_CODES.EBADMSG, "bad wire magic");
  }
  if (abiVersion !== ABI_VERSION) {
    throw new WireCodecError(ERROR_CODES.EINVAL, `unsupported ABI version ${abiVersion}`);
  }
  if (headerLength !== HEADER_LENGTH) {
    throw new WireCodecError(ERROR_CODES.EBADMSG, "bad header length");
  }
  if (payloadLength > MAX_PAYLOAD_LENGTH) {
    throw new WireCodecError(ERROR_CODES.E2BIG, "payload exceeds maxPayloadLength");
  }
  if (frame.byteLength !== HEADER_LENGTH + payloadLength) {
    throw new WireCodecError(ERROR_CODES.EBADMSG, "payload length does not match frame length");
  }
  if (reserved !== 0) {
    throw new WireCodecError(ERROR_CODES.EBADMSG, "reserved field must be zero");
  }

  const opcode = view.getUint16(20, true);
  assertKnownOpcode(opcode);

  return {
    requestId: view.getUint32(8, true),
    generation: view.getUint32(12, true),
    pid: view.getUint32(16, true),
    opcode,
    status: view.getUint16(22, true) as DecodedFrame["status"],
    payload: frame.slice(HEADER_LENGTH)
  };
}

export function decodeRequest(bytes: ArrayBuffer | ArrayBufferView | Uint8Array): DecodedFrame {
  const frame = decodeFrame(bytes);
  if (frame.status !== STATUS.request) {
    throw new WireCodecError(ERROR_CODES.EBADMSG, "request status must be request");
  }
  return frame;
}

export function decodeResponse(bytes: ArrayBuffer | ArrayBufferView | Uint8Array): DecodedFrame {
  const frame = decodeFrame(bytes);
  if (frame.status !== STATUS.ok && frame.status !== STATUS.error) {
    throw new WireCodecError(ERROR_CODES.EBADMSG, "response status must be ok or error");
  }
  return frame;
}
