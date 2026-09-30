import {
  ABI_VERSION,
  decodeResponse,
  encodeRequest,
  ERROR_CODES,
  HEADER_LENGTH,
  MAX_PAYLOAD_LENGTH,
  STATUS,
  type DecodedFrame,
  type FramePayload,
  type Opcode
} from "../../../protocol/src/index.ts";

interface SystemWasmExports extends WebAssembly.Exports {
  memory: WebAssembly.Memory;
  nuriteo_abi_version(): number;
  nuriteo_dispatch(length: number): number;
  nuriteo_request_buffer(length: number): number;
  nuriteo_reset(): void;
  nuriteo_response_buffer(): number;
}

export class SystemWasmError extends Error {
  readonly code: number;

  constructor(code: number, message: string) {
    super(message);
    this.name = "SystemWasmError";
    this.code = code;
  }
}

export class SystemWasmClient {
  #exports: SystemWasmExports;
  #nextRequestId = 1;

  private constructor(exports: SystemWasmExports) {
    this.#exports = exports;
  }

  static async load(url: string | URL, fetcher: typeof fetch = fetch): Promise<SystemWasmClient> {
    const response = await fetcher(url);
    if (!response.ok) throw new SystemWasmError(ERROR_CODES.EIO, `system WASM fetch failed: ${response.status}`);
    const instantiated = await WebAssembly.instantiate(await response.arrayBuffer(), {});
    const exports = instantiated.instance.exports as unknown as SystemWasmExports;
    assertExports(exports);
    if (exports.nuriteo_abi_version() !== ABI_VERSION) {
      throw new SystemWasmError(ERROR_CODES.EBADMSG, "system WASM ABI version mismatch");
    }
    return new SystemWasmClient(exports);
  }

  reset(): void {
    this.#exports.nuriteo_reset();
    this.#nextRequestId = 1;
  }

  request(options: {
    generation: number;
    opcode: Opcode;
    payload?: FramePayload;
    pid: number;
  }): Uint8Array {
    const requestId = this.#nextRequestId++;
    const request = encodeRequest({ requestId, ...options });
    if (request.byteLength > HEADER_LENGTH + MAX_PAYLOAD_LENGTH) {
      throw new SystemWasmError(ERROR_CODES.E2BIG, "system WASM request exceeds the protocol limit");
    }
    const requestPointer = this.#exports.nuriteo_request_buffer(request.byteLength);
    if (requestPointer === 0) throw new SystemWasmError(ERROR_CODES.E2BIG, "system WASM rejected the request buffer");
    new Uint8Array(this.#exports.memory.buffer, requestPointer, request.byteLength).set(request);

    const responseLength = this.#exports.nuriteo_dispatch(request.byteLength);
    if (responseLength < HEADER_LENGTH || responseLength > HEADER_LENGTH + MAX_PAYLOAD_LENGTH) {
      throw new SystemWasmError(ERROR_CODES.EBADMSG, "system WASM response length is invalid");
    }
    const responsePointer = this.#exports.nuriteo_response_buffer();
    const responseBytes = new Uint8Array(this.#exports.memory.buffer, responsePointer, responseLength).slice();
    return unwrapResponse(decodeResponse(responseBytes), { ...options, requestId });
  }
}

function assertExports(exports: Partial<SystemWasmExports>): asserts exports is SystemWasmExports {
  if (!(exports.memory instanceof WebAssembly.Memory)
    || typeof exports.nuriteo_abi_version !== "function"
    || typeof exports.nuriteo_dispatch !== "function"
    || typeof exports.nuriteo_request_buffer !== "function"
    || typeof exports.nuriteo_reset !== "function"
    || typeof exports.nuriteo_response_buffer !== "function") {
    throw new SystemWasmError(ERROR_CODES.EIO, "system WASM exports are incomplete");
  }
}

function unwrapResponse(response: DecodedFrame, request: { generation: number; opcode: Opcode; pid: number; requestId: number }): Uint8Array {
  if (response.requestId !== request.requestId
    || response.generation !== request.generation
    || response.pid !== request.pid
    || response.opcode !== request.opcode) {
    throw new SystemWasmError(ERROR_CODES.EBADMSG, "system WASM response metadata mismatch");
  }
  if (response.status === STATUS.ok) return response.payload;
  if (response.payload.byteLength < 2) throw new SystemWasmError(ERROR_CODES.EBADMSG, "system WASM error payload is truncated");
  const view = new DataView(response.payload.buffer, response.payload.byteOffset, response.payload.byteLength);
  const code = view.getUint16(0, true);
  const message = new TextDecoder().decode(response.payload.subarray(2)) || "system WASM request failed";
  throw new SystemWasmError(code, message);
}
