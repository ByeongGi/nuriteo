export interface SecretChunkScanner {
  readonly detected: boolean;
  add(value: string): void;
  scan(chunk: string): boolean;
}

export function createSecretChunkScanner(values: Iterable<string>): SecretChunkScanner {
  const forbidden = new Set(values);
  let detected = false;
  let suffix = "";

  return {
    get detected() {
      return detected;
    },
    add(value: string) {
      forbidden.add(value);
    },
    scan(chunk: string) {
      const combined = `${suffix}${chunk}`;
      detected ||= [...forbidden].some((value) => combined.includes(value));
      const maximumLength = Math.max(0, ...[...forbidden].map((value) => value.length));
      suffix = maximumLength <= 1 ? "" : combined.slice(-(maximumLength - 1));
      return detected;
    }
  };
}
