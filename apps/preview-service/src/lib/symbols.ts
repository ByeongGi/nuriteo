export interface ProjectSymbol {
  name: string;
  path: string;
  line: number;
  column: number;
  kind: "function" | "class" | "const" | "type" | "default";
}

const PATTERNS: Array<{ kind: ProjectSymbol["kind"]; re: RegExp }> = [
  { kind: "function", re: /^\s*(?:export\s+)?(?:async\s+)?function\s+([A-Za-z_$][\w$]*)/ },
  { kind: "class", re: /^\s*(?:export\s+)?class\s+([A-Za-z_$][\w$]*)/ },
  { kind: "const", re: /^\s*(?:export\s+)?(?:const|let|var)\s+([A-Za-z_$][\w$]*)\s*=/ },
  { kind: "type", re: /^\s*(?:export\s+)?(?:type|interface)\s+([A-Za-z_$][\w$]*)/ },
  { kind: "default", re: /^\s*export\s+default\s+(?:function|class)\s+([A-Za-z_$][\w$]*)/ }
];

export function indexProjectSymbols(files: Array<{ path: string; data: string }>): ProjectSymbol[] {
  const out: ProjectSymbol[] = [];
  for (const file of files) {
    if (!/\.(?:[cm]?[jt]sx?|mjs|cjs)$/.test(file.path)) continue;
    const lines = file.data.split("\n");
    lines.forEach((line, index) => {
      for (const pattern of PATTERNS) {
        const match = line.match(pattern.re);
        if (!match?.[1]) continue;
        out.push({
          name: match[1],
          path: file.path,
          line: index + 1,
          column: Math.max(1, (match.index || 0) + 1 + match[0].indexOf(match[1])),
          kind: pattern.kind
        });
        break;
      }
    });
  }
  return out;
}

export function findSymbolDefinition(
  symbols: ProjectSymbol[],
  name: string,
  preferredPath?: string
): ProjectSymbol | null {
  if (!name) return null;
  const exactPreferred = preferredPath
    ? symbols.find((symbol) => symbol.name === name && symbol.path === preferredPath)
    : null;
  if (exactPreferred) return exactPreferred;
  return symbols.find((symbol) => symbol.name === name) || null;
}

export function wordAt(source: string, lineNumber: number, column: number): string {
  const line = source.split("\n")[lineNumber - 1] || "";
  const index = Math.max(0, column - 1);
  const left = line.slice(0, index).match(/[A-Za-z_$][\w$]*$/)?.[0] || "";
  const right = line.slice(index).match(/^[A-Za-z_$][\w$]*/)?.[0] || "";
  if (left && right) return `${left}${right}`;
  return left || right;
}
