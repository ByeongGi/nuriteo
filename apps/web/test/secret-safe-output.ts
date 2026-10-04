import { StringDecoder } from "node:string_decoder";

import { createSecretChunkScanner } from "./secret-chunk-scanner.ts";

export type OutputStreamName = "stdout" | "stderr";
export type SecretSafeFailureCategory = "assertion" | "error" | "non-error" | "timeout";

export function secretSafeFailureCategory(error: unknown): SecretSafeFailureCategory {
  if (!(error instanceof Error)) return "non-error";
  if (error.name === "AssertionError") return "assertion";
  if (error.name === "TimeoutError") return "timeout";
  return "error";
}

export function createSecretSafeOutputDiagnostics(values: Iterable<string>) {
  const scanners = {
    stderr: createSecretChunkScanner(values),
    stdout: createSecretChunkScanner(values)
  };
  const decoders = {
    stderr: new StringDecoder("utf8"),
    stdout: new StringDecoder("utf8")
  };
  const counts = {
    stderr: { bytes: 0, chunks: 0 },
    stdout: { bytes: 0, chunks: 0 }
  };

  return {
    add(value: string) {
      scanners.stderr.add(value);
      scanners.stdout.add(value);
    },
    get detected() {
      return scanners.stderr.detected || scanners.stdout.detected;
    },
    record(stream: OutputStreamName, chunk: Buffer) {
      counts[stream].bytes += chunk.byteLength;
      counts[stream].chunks += 1;
      scanners[stream].scan(decoders[stream].write(chunk));
    },
    render() {
      return ["stdout", "stderr"]
        .map((stream) => {
          const count = counts[stream as OutputStreamName];
          return `${stream}=${count.bytes} bytes/${count.chunks} chunks`;
        })
        .join(", ");
    }
  };
}
