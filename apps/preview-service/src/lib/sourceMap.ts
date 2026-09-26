export interface SourceMapV3 {
  version: 3;
  file: string;
  sourceRoot?: string;
  sources: string[];
  names: string[];
  mappings: string;
}

export interface SourceLocation {
  uri: string;
  line: number;
  column: number;
}

type Mapping = { generatedLine: number; generatedColumn: number; sourceIndex: number; originalLine: number; originalColumn: number };

export class RuntimeSourceMap {
  readonly #map: SourceMapV3;
  readonly #mappings: Mapping[];

  constructor(map: SourceMapV3) {
    if (map.version !== 3 || map.sources.length === 0) throw new Error("Unsupported source map.");
    this.#map = map;
    this.#mappings = decodeMappings(map.mappings);
  }

  originalPositionFor(generatedLine: number, generatedColumn = 0): SourceLocation | null {
    const candidates = this.#mappings.filter(
      (mapping) => mapping.generatedLine === generatedLine && mapping.generatedColumn <= generatedColumn
    );
    const mapping = candidates.at(-1) || this.#mappings.find((entry) => entry.generatedLine === generatedLine);
    if (!mapping) return null;
    return {
      uri: resolveSourceUri(this.#map, mapping.sourceIndex),
      line: mapping.originalLine,
      column: mapping.originalColumn
    };
  }

  generatedPositionFor(sourceUri: string, originalLine: number): { line: number; column: number } | null {
    const mapping = this.#mappings.find(
      (entry) => resolveSourceUri(this.#map, entry.sourceIndex) === sourceUri && entry.originalLine === originalLine
    );
    return mapping ? { line: mapping.generatedLine, column: mapping.generatedColumn } : null;
  }
}

export const DEBUG_FIXTURE_SOURCE_URI = "file:///workspace/debug-fixture.ts";
export const DEBUG_FIXTURE_SOURCE_MAP: SourceMapV3 = {
  version: 3,
  file: "debug-fixture.js",
  sourceRoot: "file:///workspace/",
  sources: ["debug-fixture.ts"],
  names: [],
  mappings: ";;AAAA;AACA;AACA;AACA;AACA"
};

function decodeMappings(encoded: string): Mapping[] {
  const mappings: Mapping[] = [];
  let sourceIndex = 0;
  let originalLine = 0;
  let originalColumn = 0;
  for (const [lineIndex, line] of encoded.split(";").entries()) {
    let generatedColumn = 0;
    for (const segment of line.split(",")) {
      if (!segment) continue;
      const values = decodeVlq(segment);
      if (values.length < 4) continue;
      generatedColumn += values[0] || 0;
      sourceIndex += values[1] || 0;
      originalLine += values[2] || 0;
      originalColumn += values[3] || 0;
      mappings.push({
        generatedLine: lineIndex + 1,
        generatedColumn,
        sourceIndex,
        originalLine: originalLine + 1,
        originalColumn
      });
    }
  }
  return mappings;
}

function decodeVlq(segment: string): number[] {
  const alphabet = "ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789+/";
  const values: number[] = [];
  let value = 0;
  let shift = 0;
  for (const character of segment) {
    const digit = alphabet.indexOf(character);
    if (digit < 0) throw new Error("Invalid source-map VLQ segment.");
    value += (digit & 31) << shift;
    if (digit & 32) {
      shift += 5;
      continue;
    }
    const negative = value & 1;
    values.push(negative ? -(value >> 1) : value >> 1);
    value = 0;
    shift = 0;
  }
  return values;
}

function resolveSourceUri(map: SourceMapV3, sourceIndex: number): string {
  const source = map.sources[sourceIndex];
  if (!source) throw new Error("Source map references an unknown source.");
  return new URL(source, map.sourceRoot || "file:///").toString();
}
