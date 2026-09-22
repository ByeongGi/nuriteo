let seq = 0;

export function resetIdSequence(next = 0): void {
  seq = next;
}

export function createId(prefix: string, now: () => number = Date.now): string {
  seq += 1;
  return `${prefix}_${now().toString(16)}_${seq.toString(16)}`;
}

export function createToken(now: () => number = Date.now): string {
  return `tok_${now().toString(16)}_${Math.random().toString(16).slice(2, 10)}`;
}
