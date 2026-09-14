import { Readable, Writable } from "./stream.ts";

export function isatty(_fd: number): boolean {
  return false;
}

export class ReadStream extends Readable {
  isTTY = false;
}

export class WriteStream extends Writable {
  isTTY = false;
  columns = 80;
  rows = 24;

  clearLine(): boolean {
    return false;
  }

  clearScreenDown(): boolean {
    return false;
  }

  cursorTo(): boolean {
    return false;
  }

  getColorDepth(): number {
    return 1;
  }

  hasColors(): boolean {
    return false;
  }

  moveCursor(): boolean {
    return false;
  }
}

export const ttyBuiltin = Object.freeze({
  ReadStream,
  WriteStream,
  default: {
    ReadStream,
    WriteStream,
    isatty
  },
  isatty
});
