export interface ProjectReplaceFile {
  readonly kind: string;
  readonly path: string;
}

export interface ProjectReplaceUpdate {
  readonly content: string;
  readonly path: string;
  readonly replacements: number;
}

export interface ProjectReplacePlan {
  readonly error?: string;
  readonly updates: readonly ProjectReplaceUpdate[];
}

interface PlanProjectContentReplaceInput {
  readonly files: readonly ProjectReplaceFile[];
  readonly matchCase: boolean;
  readonly query: string;
  readonly readText: (path: string) => string;
  readonly replacement: string;
  readonly selectedContent?: string | undefined;
  readonly selectedPath?: string | undefined;
  readonly useRegularExpression: boolean;
}

export function planProjectContentReplace(input: PlanProjectContentReplaceInput): ProjectReplacePlan {
  if (input.query.length === 0) return { updates: [] };
  if (input.useRegularExpression) return planRegularExpressionReplace(input);
  return planLiteralReplace(input);
}

function planLiteralReplace(input: PlanProjectContentReplaceInput): ProjectReplacePlan {
  const updates: ProjectReplaceUpdate[] = [];
  for (const file of textFiles(input)) {
    const content = readFile(input, file.path);
    if (content === undefined) continue;
    const replacements = countLiteral(content, input.query, input.matchCase);
    if (replacements === 0) continue;
    updates.push({
      content: replaceLiteral(content, input.query, input.replacement, input.matchCase),
      path: file.path,
      replacements
    });
  }
  return { updates };
}

function planRegularExpressionReplace(input: PlanProjectContentReplaceInput): ProjectReplacePlan {
  let expression: RegExp;
  try {
    expression = new RegExp(input.query, input.matchCase ? "gu" : "giu");
  } catch {
    return { error: "올바른 정규식을 입력하세요.", updates: [] };
  }
  if (new RegExp(input.query, input.matchCase ? "u" : "iu").exec("")?.[0] === "") {
    return { error: "빈 문자열에 일치하는 정규식은 바꿀 수 없습니다.", updates: [] };
  }
  const updates: ProjectReplaceUpdate[] = [];
  for (const file of textFiles(input)) {
    const content = readFile(input, file.path);
    if (content === undefined) continue;
    expression.lastIndex = 0;
    const replacements = [...content.matchAll(expression)].length;
    if (replacements === 0) continue;
    expression.lastIndex = 0;
    updates.push({
      content: content.replace(expression, input.replacement),
      path: file.path,
      replacements
    });
  }
  return { updates };
}

function textFiles(input: PlanProjectContentReplaceInput): readonly ProjectReplaceFile[] {
  return input.files.filter((file) => file.kind === "text");
}

function readFile(input: PlanProjectContentReplaceInput, path: string): string | undefined {
  try {
    return path === input.selectedPath && input.selectedContent !== undefined
      ? input.selectedContent
      : input.readText(path);
  } catch {
    return undefined;
  }
}

function replaceLiteral(content: string, query: string, replacement: string, matchCase: boolean): string {
  if (matchCase) return content.replaceAll(query, replacement);
  const expected = query.toLocaleLowerCase();
  const searchable = content.toLocaleLowerCase();
  let result = "";
  let index = 0;
  while (index < content.length) {
    const found = searchable.indexOf(expected, index);
    if (found < 0) {
      result += content.slice(index);
      break;
    }
    result += content.slice(index, found) + replacement;
    index = found + query.length;
  }
  return result;
}

function countLiteral(content: string, query: string, matchCase: boolean): number {
  const expected = matchCase ? query : query.toLocaleLowerCase();
  const searchable = matchCase ? content : content.toLocaleLowerCase();
  let count = 0;
  let index = searchable.indexOf(expected);
  while (index >= 0) {
    count += 1;
    index = searchable.indexOf(expected, index + Math.max(expected.length, 1));
  }
  return count;
}
