export class BrokenPipeError extends Error {
  code: "EPIPE";

  constructor(message = "EPIPE: broken pipe") {
    super(message);
    this.name = "BrokenPipeError";
    this.code = "EPIPE";
  }
}

export class WouldBlockError extends Error {
  code: "EAGAIN";

  constructor(message = "EAGAIN: pipe buffer is full") {
    super(message);
    this.name = "WouldBlockError";
    this.code = "EAGAIN";
  }
}

export class BoundedPipe {
  capacity: number;
  buffer: number[];
  readerOpen: boolean;
  writerOpen: boolean;

  constructor(capacity = 65536) {
    this.capacity = capacity;
    this.buffer = [];
    this.readerOpen = true;
    this.writerOpen = true;
  }

  write(bytes: ArrayBuffer | ArrayBufferView | Uint8Array): number {
    if (!this.readerOpen) throw new BrokenPipeError();
    const input = bytes instanceof Uint8Array
      ? bytes
      : ArrayBuffer.isView(bytes)
        ? new Uint8Array(bytes.buffer, bytes.byteOffset, bytes.byteLength)
        : new Uint8Array(bytes);
    const available = this.capacity - this.buffer.length;
    if (available <= 0) throw new WouldBlockError();
    const count = Math.min(available, input.byteLength);
    for (let index = 0; index < count; index += 1) this.buffer.push(input[index] ?? 0);
    return count;
  }

  read(length = this.buffer.length): Uint8Array {
    const count = Math.min(length, this.buffer.length);
    const out = new Uint8Array(count);
    for (let index = 0; index < count; index += 1) {
      out[index] = this.buffer.shift() ?? 0;
    }
    return out;
  }

  closeReader(): void {
    this.readerOpen = false;
  }

  closeWriter(): void {
    this.writerOpen = false;
  }

  eof(): boolean {
    return !this.writerOpen && this.buffer.length === 0;
  }
}
