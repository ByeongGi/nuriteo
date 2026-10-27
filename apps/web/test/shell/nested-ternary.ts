import { readdirSync, readFileSync, statSync, writeFileSync } from "node:fs";
import path from "node:path";
import ts from "typescript";

export interface NestedTernaryHit {
  readonly file: string;
  readonly line: number;
}

export function listTypeScriptFiles(directory: string): string[] {
  const files: string[] = [];
  for (const name of readdirSync(directory)) {
    const fullPath = path.join(directory, name);
    if (statSync(fullPath).isDirectory()) {
      files.push(...listTypeScriptFiles(fullPath));
      continue;
    }
    if (name.endsWith(".ts") || name.endsWith(".tsx")) files.push(fullPath);
  }
  return files;
}

export function findNestedTernaries(filePath: string, text: string): NestedTernaryHit[] {
  const source = parse(filePath, text);
  const hits: NestedTernaryHit[] = [];
  const seen = new Set<number>();
  visit(source, 0, (node, depth) => {
    if (depth < 2 || seen.has(node.pos)) return;
    seen.add(node.pos);
    const { line } = source.getLineAndCharacterOfPosition(node.getStart(source));
    hits.push({ file: filePath, line: line + 1 });
  });
  return hits;
}

export function flattenNestedTernaries(filePath: string, text: string): string {
  let current = text;
  for (let pass = 0; pass < 400; pass += 1) {
    const source = parse(filePath, current);
    const target = deepestNestedTernary(source);
    if (target === undefined) return current;
    const printed = printFlattened(source, target);
    const start = target.getStart(source);
    const end = target.getEnd();
    current = `${current.slice(0, start)}${printed}${current.slice(end)}`;
  }
  throw new Error(`nested ternary flatten did not finish: ${filePath}`);
}

export function evaluatePureExpression(expression: string, bindings: Readonly<Record<string, unknown>> = {}): unknown {
  const names = Object.keys(bindings);
  return new Function(...names, `return (${expression});`)(...names.map((name) => bindings[name]));
}

function parse(filePath: string, text: string): ts.SourceFile {
  return ts.createSourceFile(
    filePath,
    text,
    ts.ScriptTarget.Latest,
    true,
    filePath.endsWith(".tsx") ? ts.ScriptKind.TSX : ts.ScriptKind.TS
  );
}

function visit(
  node: ts.Node,
  depth: number,
  onNested: (node: ts.ConditionalExpression, depth: number) => void
): void {
  if (ts.isConditionalExpression(node)) {
    const next = depth + 1;
    if (next >= 2) onNested(node, next);
    visit(node.condition, next, onNested);
    visit(node.whenTrue, next, onNested);
    visit(node.whenFalse, next, onNested);
    return;
  }
  ts.forEachChild(node, (child) => visit(child, depth, onNested));
}

function deepestNestedTernary(source: ts.SourceFile): ts.ConditionalExpression | undefined {
  let deepest: ts.ConditionalExpression | undefined;
  let depth = 1;
  visit(source, 0, (node, next) => {
    if (next < depth) return;
    deepest = node;
    depth = next;
  });
  return deepest;
}

function printFlattened(source: ts.SourceFile, node: ts.ConditionalExpression): string {
  const condition = expressionText(source, node.condition);
  const whenTrue = expressionText(source, node.whenTrue);
  const whenFalse = expressionText(source, node.whenFalse);
  return `(function () {\n    if (${condition}) {\n        return (${whenTrue});\n    }\n    return (${whenFalse});\n})()`;
}

function expressionText(source: ts.SourceFile, node: ts.Expression): string {
  return source.text.slice(node.getStart(source), node.getEnd());
}

export function rewriteTree(directory: string): number {
  let rewritten = 0;
  for (const filePath of listTypeScriptFiles(directory)) {
    const original = readFileSync(filePath, "utf8");
    const flattened = flattenNestedTernaries(filePath, original);
    if (flattened === original) continue;
    writeFileSync(filePath, flattened);
    rewritten += 1;
  }
  return rewritten;
}
