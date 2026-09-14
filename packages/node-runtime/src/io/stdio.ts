import { BoundedPipe } from "./pipe.ts";

export function createStdio(capacity = 65536) {
  return {
    stdin: new BoundedPipe(capacity),
    stdout: new BoundedPipe(capacity),
    stderr: new BoundedPipe(capacity)
  };
}
