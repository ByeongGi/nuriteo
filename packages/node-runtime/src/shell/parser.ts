export class ShellSyntaxError extends Error {
  code: "ERR_NURITEO_UNSUPPORTED_SHELL_SYNTAX";

  constructor(message: string) {
    super(message);
    this.name = "ShellSyntaxError";
    this.code = "ERR_NURITEO_UNSUPPORTED_SHELL_SYNTAX";
  }
}

import type { ShellStep } from "./types.ts";

export function parseShell(input: string): ShellStep[] {
  assertSupportedSyntax(input);
  const tokens = tokenize(input);
  if (tokens.includes("||") || tokens.includes(";")) {
    throw new ShellSyntaxError("unsupported shell syntax: only pipelines (|), &&, and stdout overwrite (>) are supported");
  }
  const commands: ShellStep[] = [];
  let current: string[] = [];
  let op: ShellStep["op"] = null;

  for (const token of tokens) {
    if (token === "&&" || token === "|") {
      if (current.length === 0) throw new ShellSyntaxError("missing command");
      commands.push({ op, argv: current });
      current = [];
      op = token;
      continue;
    }
    current.push(token);
  }
  if (current.length === 0) throw new ShellSyntaxError("missing command");
  commands.push({ op, argv: current });
  return commands;
}

function assertSupportedSyntax(input: string): void {
  const syntax = unquotedSyntax(input);
  const unsupported: Array<[RegExp, string]> = [
    [/\$\(|`/, "command substitution"],
    [/(^|[^&])&($|[^&])/, "background jobs (&)"],
    [/>>|<</, "append and heredoc redirects"],
    [/(^|\s)<(?!<)/, "stdin file redirects"],
    [/\|\||;/, "OR and command-list operators"],
    [/[{}]/, "shell blocks and brace expansion"]
  ];
  for (const [pattern, feature] of unsupported) {
    if (pattern.test(syntax)) {
      throw new ShellSyntaxError(
        `unsupported shell syntax: ${feature}; supported forms are argv/quotes, pipelines (|), &&, and stdout overwrite (>)`
      );
    }
  }
}

function unquotedSyntax(input: string): string {
  let quote: "'" | "\"" | null = null;
  let result = "";
  for (const char of input) {
    if (quote) {
      if (char === quote) quote = null;
      result += " ";
    } else if (char === "'" || char === "\"") {
      quote = char;
      result += " ";
    } else {
      result += char;
    }
  }
  return result;
}

export function tokenize(input: string): string[] {
  const tokens: string[] = [];
  let current = "";
  let quote: "'" | "\"" | null = null;

  for (let index = 0; index < input.length; index += 1) {
    const char = input[index] ?? "";
    if (quote) {
      if (char === quote) quote = null;
      else current += char;
      continue;
    }
    if (char === "'" || char === "\"") {
      quote = char;
      continue;
    }
    if (/\s/.test(char)) {
      push();
      continue;
    }
    if (char === "&" && input[index + 1] === "&") {
      push();
      tokens.push("&&");
      index += 1;
      continue;
    }
    if (char === "|" || char === ">" || char === ";") {
      push();
      tokens.push(char);
      continue;
    }
    current += char;
  }
  if (quote) throw new ShellSyntaxError("unterminated quote");
  push();
  return tokens;

  function push(): void {
    if (current) {
      tokens.push(current);
      current = "";
    }
  }
}
