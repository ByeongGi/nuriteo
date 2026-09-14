export class ShellSyntaxError extends Error {
  constructor(message) {
    super(message);
    this.name = "ShellSyntaxError";
    this.code = "ERR_CARGO_CONTAINER_UNSUPPORTED_SHELL_SYNTAX";
  }
}

export function parseShell(input) {
  const tokens = tokenize(input);
  if (tokens.includes("||") || tokens.includes(";")) {
    throw new ShellSyntaxError("unsupported shell syntax");
  }
  const commands = [];
  let current = [];
  let op = null;

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

export function tokenize(input) {
  const tokens = [];
  let current = "";
  let quote = null;

  for (let index = 0; index < input.length; index += 1) {
    const char = input[index];
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

  function push() {
    if (current) {
      tokens.push(current);
      current = "";
    }
  }
}
