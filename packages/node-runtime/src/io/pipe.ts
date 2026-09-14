export class BrokenPipeError extends Error {
  constructor(message = "EPIPE: broken pipe") {
    super(message);
    this.name = "BrokenPipeError";
    this.code = "EPIPE";
  }
}

export class WouldBlockError extends Error {
  constructor(message = "EAGAIN: pipe buffer is full") {
    super(message);
    this.name = "WouldBlockError";
    this.code = "EAGAIN";
  }
}

export class BoundedPipe {
  constructor(capacity = 65536) {
    this.capacity = capacity;
    this.buffer = [];
    this.readerOpen = true;
    this.writerOpen = true;
  }

  write(bytes) {
    if (!this.readerOpen) throw new BrokenPipeError();
    const input = bytes instanceof Uint8Array ? bytes : new Uint8Array(bytes);
    const available = this.capacity - this.buffer.length;
    if (available <= 0) throw new WouldBlockError();
    const count = Math.min(available, input.byteLength);
    for (let index = 0; index < count; index += 1) this.buffer.push(input[index]);
    return count;
  }

  read(length = this.buffer.length) {
    const count = Math.min(length, this.buffer.length);
    const out = new Uint8Array(count);
    for (let index = 0; index < count; index += 1) {
      out[index] = this.buffer.shift();
    }
    return out;
  }

  closeReader() {
    this.readerOpen = false;
  }

  closeWriter() {
    this.writerOpen = false;
  }

  eof() {
    return !this.writerOpen && this.buffer.length === 0;
  }
}
