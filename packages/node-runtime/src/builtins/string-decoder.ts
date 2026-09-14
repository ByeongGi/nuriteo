import { Buffer } from "./buffer.ts";

export class StringDecoder {
  private decoder: TextDecoder;

  constructor(encoding = "utf8") {
    this.decoder = new TextDecoder(normalizeEncoding(encoding), { fatal: false });
  }

  write(buffer: Uint8Array | ArrayBuffer | string): string {
    if (typeof buffer === "string") return buffer;
    const bytes = buffer instanceof ArrayBuffer ? new Uint8Array(buffer) : buffer;
    return this.decoder.decode(bytes, { stream: true });
  }

  end(buffer?: Uint8Array | ArrayBuffer | string): string {
    return `${buffer ? this.write(buffer) : ""}${this.decoder.decode()}`;
  }
}

export const stringDecoderBuiltin = Object.freeze({
  StringDecoder
});

function normalizeEncoding(encoding: string): string {
  const normalized = encoding.toLowerCase().replace(/[-_]/g, "");
  if (normalized === "utf8" || normalized === "utf") return "utf-8";
  if (normalized === "utf16le" || normalized === "ucs2") return "utf-16le";
  if (normalized === "latin1" || normalized === "binary") return "latin1";
  if (normalized === "base64" || normalized === "hex") return "utf-8";
  Buffer.from("", "utf8");
  return encoding;
}
