import assert from "node:assert/strict";

import { decodeRequest, encodeRequest, WireCodecError } from "../src/codec.ts";
import { ABI_VERSION, ERROR_CODES, GOLDEN_REQUEST, OPCODES } from "../src/generated.ts";
import type { ErrorCode } from "../src/types.ts";

function bytesFromHex(hex: string): Uint8Array {
  assert.equal(hex.length % 2, 0);
  const bytes = new Uint8Array(hex.length / 2);
  for (let index = 0; index < hex.length; index += 2) {
    bytes[index / 2] = Number.parseInt(hex.slice(index, index + 2), 16);
  }
  return bytes;
}

function hexFromBytes(bytes: Uint8Array): string {
  return [...bytes].map((byte) => byte.toString(16).padStart(2, "0")).join("");
}

function assertWireError(fn: () => unknown, code: ErrorCode): void {
  assert.throws(
    fn,
    (error) => error instanceof WireCodecError && error.code === code,
    `expected WireCodecError ${code}`
  );
}

const goldenBytes = bytesFromHex(GOLDEN_REQUEST.wireHex);
const encoded = encodeRequest({
  requestId: GOLDEN_REQUEST.requestId,
  generation: GOLDEN_REQUEST.generation,
  pid: GOLDEN_REQUEST.pid,
  opcode: OPCODES[GOLDEN_REQUEST.opcode],
  payload: bytesFromHex(GOLDEN_REQUEST.payloadHex)
});

assert.equal(ABI_VERSION, 1);
assert.equal(hexFromBytes(encoded), GOLDEN_REQUEST.wireHex);

const decoded = decodeRequest(goldenBytes);
assert.equal(decoded.requestId, GOLDEN_REQUEST.requestId);
assert.equal(decoded.generation, GOLDEN_REQUEST.generation);
assert.equal(decoded.pid, GOLDEN_REQUEST.pid);
assert.equal(decoded.opcode, OPCODES.ping);
assert.equal(hexFromBytes(decoded.payload), GOLDEN_REQUEST.payloadHex);

assertWireError(() => decodeRequest(goldenBytes.slice(0, -1)), ERROR_CODES.EBADMSG);

const badOpcode = goldenBytes.slice();
badOpcode[20] = 0xff;
badOpcode[21] = 0xff;
assertWireError(() => decodeRequest(badOpcode), ERROR_CODES.ENOSYS);

const badVersion = goldenBytes.slice();
badVersion[4] = 2;
assertWireError(() => decodeRequest(badVersion), ERROR_CODES.EINVAL);

const badPayloadLength = goldenBytes.slice();
badPayloadLength[24] = 0xff;
badPayloadLength[25] = 0xff;
badPayloadLength[26] = 0xff;
badPayloadLength[27] = 0x7f;
assertWireError(() => decodeRequest(badPayloadLength), ERROR_CODES.E2BIG);

console.log("protocol golden test ok");
