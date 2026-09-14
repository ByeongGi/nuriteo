const base64 = "ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789+/";

export function originalPositionFor(map, generatedLine, generatedColumn) {
  let sourceIndex = 0;
  let originalLine = 0;
  let originalColumn = 0;

  const lines = map.mappings.split(";");
  for (let lineIndex = 0; lineIndex < Math.min(generatedLine, lines.length); lineIndex += 1) {
    let generatedColumnCursor = 0;
    const segments = lines[lineIndex] ? lines[lineIndex].split(",") : [];
    let best = null;

    for (const segment of segments) {
      const values = decodeVlqSegment(segment);
      if (values.length === 0) continue;
      generatedColumnCursor += values[0];
      if (values.length >= 4) {
        sourceIndex += values[1];
        originalLine += values[2];
        originalColumn += values[3];
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

function decodeVlqSegment(segment) {
  const values = [];
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
