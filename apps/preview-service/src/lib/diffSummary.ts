export interface DiffLineChange {
  originalStartLineNumber: number;
  originalEndLineNumber: number;
  modifiedStartLineNumber: number;
  modifiedEndLineNumber: number;
}

export interface DiffSummary {
  added: number;
  removed: number;
  changed: number;
  hunks: number;
}

export function summarizeDiffChanges(changes: readonly DiffLineChange[]): DiffSummary {
  return changes.reduce<DiffSummary>((summary, change) => {
    const originalLines = lineCount(change.originalStartLineNumber, change.originalEndLineNumber);
    const modifiedLines = lineCount(change.modifiedStartLineNumber, change.modifiedEndLineNumber);
    const changed = Math.min(originalLines, modifiedLines);

    summary.added += modifiedLines - changed;
    summary.removed += originalLines - changed;
    summary.changed += changed;
    summary.hunks += 1;
    return summary;
  }, { added: 0, removed: 0, changed: 0, hunks: 0 });
}

export function createFallbackLineChanges(original: string, modified: string): DiffLineChange[] {
  if (original === modified) return [];
  const originalLines = original.split("\n");
  const modifiedLines = modified.split("\n");
  let prefixLength = 0;
  while (
    prefixLength < originalLines.length
    && prefixLength < modifiedLines.length
    && originalLines[prefixLength] === modifiedLines[prefixLength]
  ) {
    prefixLength += 1;
  }

  let suffixLength = 0;
  while (
    suffixLength < originalLines.length - prefixLength
    && suffixLength < modifiedLines.length - prefixLength
    && originalLines[originalLines.length - suffixLength - 1]
      === modifiedLines[modifiedLines.length - suffixLength - 1]
  ) {
    suffixLength += 1;
  }

  const originalCount = originalLines.length - prefixLength - suffixLength;
  const modifiedCount = modifiedLines.length - prefixLength - suffixLength;
  return [{
    originalStartLineNumber: prefixLength + 1,
    originalEndLineNumber: originalCount === 0 ? 0 : prefixLength + originalCount,
    modifiedStartLineNumber: prefixLength + 1,
    modifiedEndLineNumber: modifiedCount === 0 ? 0 : prefixLength + modifiedCount
  }];
}

function lineCount(start: number, end: number): number {
  if (end === 0 || start === 0) return 0;
  return Math.max(0, end - start + 1);
}
