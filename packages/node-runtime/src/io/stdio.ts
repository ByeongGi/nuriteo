import { BoundedPipe } from "./pipe.ts";

export interface RuntimeStdio {
  stdin: BoundedPipe;
  stdout: BoundedPipe;
  stderr: BoundedPipe;
}

export function createStdio(capacity = 65536): RuntimeStdio {
  return {
    stdin: new BoundedPipe(capacity),
    stdout: new BoundedPipe(capacity),
    stderr: new BoundedPipe(capacity)
  };
}
