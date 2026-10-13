const base64 = "ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789+/";

export interface SourceMapLike {
  mappings: string;
  sources: string[];
}

export interface OriginalPosition {
  source: string | undefined;
  line: number;
  column: number;
}

export function originalPositionFor(map: SourceMapLike, generatedLine: number, generatedColumn: number): OriginalPosition | null {
  let sourceIndex = 0;
  let originalLine = 0;
  let originalColumn = 0;

  const lines = map.mappings.split(";");
  for (let lineIndex = 0; lineIndex < Math.min(generatedLine, lines.length); lineIndex += 1) {
    let generatedColumnCursor = 0;
    const line = lines[lineIndex] ?? "";
    const segments = line ? line.split(",") : [];
    let best: OriginalPosition | null = null;

    for (const segment of segments) {
      const values = decodeVlqSegment(segment);
      if (values.length === 0) continue;
      generatedColumnCursor += values[0] ?? 0;
      if (values.length >= 4) {
        sourceIndex += values[1] ?? 0;
        originalLine += values[2] ?? 0;
        originalColumn += values[3] ?? 0;
      }
      if (lineIndex + 1 === generatedLine && generatedColumnCursor <= generatedColumn && values.length >= 4) {
        best = {
          source: map.sources[sourceIndex],
          line: originalLine + 1,
          column: originalColumn + 1
        };
      }
    }

    if (best) return best;
  }

  return null;
}

function decodeVlqSegment(segment: string): number[] {
  const values: number[] = [];
  let value = 0;
  let shift = 0;

  for (const char of segment) {
    const digit = base64.indexOf(char);
    if (digit < 0) throw new Error(`invalid base64 VLQ character: ${char}`);
    const continuation = digit & 32;
    const chunk = digit & 31;
    value += chunk << shift;

    if (continuation) {
      shift += 5;
      continue;
    }

    const sign = value & 1 ? -1 : 1;
    values.push(sign * (value >> 1));
    value = 0;
    shift = 0;
  }

  return values;
}
