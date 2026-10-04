import { createSecretChunkScanner } from "./secret-chunk-scanner.ts";

export type OutputStreamName = "stdout" | "stderr";

export function createSecretSafeOutputDiagnostics(values: Iterable<string>) {
  const scanners = {
    stderr: createSecretChunkScanner(values),
    stdout: createSecretChunkScanner(values)
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
      scanners[stream].scan(chunk.toString("utf8"));
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
