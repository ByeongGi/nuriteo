import ts from "typescript";

export type RuntimeValue = string | number | boolean | null | undefined | RuntimeValue[] | { [key: string]: RuntimeValue };

export interface RuntimeInstruction {
  line: number;
  text: string;
  statement: ts.Statement;
}

const MAX_SOURCE_BYTES = 1_000_000;
const MAX_EXECUTION_STEPS = 100_000;

class ReturnSignal {
  readonly value: RuntimeValue;

  constructor(value: RuntimeValue) {
    this.value = value;
  }
}
class BreakSignal {}
class ContinueSignal {}

export class SafeJavaScriptRuntime {
  readonly uri: string;
  readonly source: string;
  readonly instructions: RuntimeInstruction[];
  readonly #sourceFile: ts.SourceFile;
  readonly #globals = new Map<string, RuntimeValue>();
  readonly #functions = new Map<string, ts.FunctionDeclaration>();
  readonly #output: (text: string) => void;
  #scopes: Array<Map<string, RuntimeValue>> = [this.#globals];
  #steps = 0;

  constructor(uri: string, source: string, output: (text: string) => void = () => undefined) {
    if (!uri.startsWith("file:///workspace/")) throw new Error("Debug program must be inside file:///workspace/.");
    if (new TextEncoder().encode(source).byteLength > MAX_SOURCE_BYTES) throw new Error("Debug source exceeds the 1 MB safety limit.");
    this.uri = uri;
    this.source = source;
    this.#output = output;
    const kind = uri.endsWith(".tsx") ? ts.ScriptKind.TSX
      : uri.endsWith(".jsx") ? ts.ScriptKind.JSX
        : uri.endsWith(".js") || uri.endsWith(".mjs") || uri.endsWith(".cjs") ? ts.ScriptKind.JS
          : ts.ScriptKind.TS;
    this.#sourceFile = ts.createSourceFile(uri, source, ts.ScriptTarget.ES2022, true, kind);
    const syntaxErrors = (this.#sourceFile as ts.SourceFile & { parseDiagnostics?: readonly ts.Diagnostic[] }).parseDiagnostics ?? [];
    if (syntaxErrors.length) throw new Error(ts.flattenDiagnosticMessageText(syntaxErrors[0]?.messageText ?? "Invalid source", "\n"));
    for (const statement of this.#sourceFile.statements) {
      if (ts.isFunctionDeclaration(statement) && statement.name) this.#functions.set(statement.name.text, statement);
    }
    this.instructions = this.#sourceFile.statements
      .filter(isExecutableTopLevelStatement)
      .map((statement) => ({
        line: this.#sourceFile.getLineAndCharacterOfPosition(statement.getStart(this.#sourceFile)).line + 1,
        text: statement.getText(this.#sourceFile),
        statement
      }));
    if (this.instructions.length === 0) throw new Error("Debug program has no executable top-level statements.");
  }

  execute(index: number): void {
    const instruction = this.instructions[index];
    if (!instruction) throw new Error("Debug instruction is outside the program.");
    this.#executeStatement(instruction.statement);
  }

  evaluate(expression: string, allowAssignment = false): RuntimeValue {
    const file = ts.createSourceFile("debug-evaluate.ts", `(${expression})`, ts.ScriptTarget.ES2022, true, ts.ScriptKind.TS);
    const statement = file.statements[0];
    if (!statement || !ts.isExpressionStatement(statement)) throw new Error("Debug expression is invalid.");
    return this.#evaluateExpression(statement.expression, allowAssignment);
  }

  variables(): Array<{ name: string; value: string; type: string; variablesReference: number }> {
    return [...this.#globals.entries()]
      .filter(([name]) => !name.startsWith("__"))
      .sort(([left], [right]) => left.localeCompare(right))
      .map(([name, value]) => ({ name, value: formatRuntimeValue(value), type: runtimeType(value), variablesReference: 0 }));
  }

  setVariable(name: string, expression: string): RuntimeValue {
    if (!this.#globals.has(name)) throw new Error(`Unknown variable: ${name}`);
    const value = this.evaluate(expression, false);
    this.#globals.set(name, value);
    return value;
  }

  #executeStatement(statement: ts.Statement): void {
    this.#tick();
    if (ts.isVariableStatement(statement)) {
      for (const declaration of statement.declarationList.declarations) {
        if (!ts.isIdentifier(declaration.name)) throw new Error("Destructuring declarations are not supported by the browser debugger.");
        this.#declare(declaration.name.text, declaration.initializer ? this.#evaluateExpression(declaration.initializer, true) : undefined);
      }
      return;
    }
    if (ts.isExpressionStatement(statement)) {
      this.#evaluateExpression(statement.expression, true);
      return;
    }
    if (ts.isBlock(statement)) {
      for (const child of statement.statements) this.#executeStatement(child);
      return;
    }
    if (ts.isIfStatement(statement)) {
      if (truthy(this.#evaluateExpression(statement.expression, false))) this.#executeStatement(statement.thenStatement);
      else if (statement.elseStatement) this.#executeStatement(statement.elseStatement);
      return;
    }
    if (ts.isWhileStatement(statement)) {
      while (truthy(this.#evaluateExpression(statement.expression, false))) {
        try {
          this.#executeStatement(statement.statement);
        } catch (signal) {
          if (signal instanceof BreakSignal) break;
          if (signal instanceof ContinueSignal) continue;
          throw signal;
        }
      }
      return;
    }
    if (ts.isForStatement(statement)) {
      if (statement.initializer) {
        if (ts.isVariableDeclarationList(statement.initializer)) {
          for (const declaration of statement.initializer.declarations) {
            if (!ts.isIdentifier(declaration.name)) throw new Error("Destructuring declarations are not supported.");
            this.#declare(declaration.name.text, declaration.initializer ? this.#evaluateExpression(declaration.initializer, true) : undefined);
          }
        } else this.#evaluateExpression(statement.initializer, true);
      }
      while (!statement.condition || truthy(this.#evaluateExpression(statement.condition, false))) {
        try {
          this.#executeStatement(statement.statement);
        } catch (signal) {
          if (signal instanceof BreakSignal) break;
          if (!(signal instanceof ContinueSignal)) throw signal;
        }
        if (statement.incrementor) this.#evaluateExpression(statement.incrementor, true);
      }
      return;
    }
    if (ts.isReturnStatement(statement)) throw new ReturnSignal(statement.expression ? this.#evaluateExpression(statement.expression, false) : undefined);
    if (ts.isThrowStatement(statement)) throw new Error(formatRuntimeValue(this.#evaluateExpression(statement.expression, false)));
    if (ts.isBreakStatement(statement)) throw new BreakSignal();
    if (ts.isContinueStatement(statement)) throw new ContinueSignal();
    if (ts.isEmptyStatement(statement) || ts.isFunctionDeclaration(statement) || ts.isImportDeclaration(statement)) return;
    throw new Error(`Unsupported debug statement: ${ts.SyntaxKind[statement.kind]}`);
  }

  #evaluateExpression(expression: ts.Expression, allowAssignment: boolean): RuntimeValue {
    this.#tick();
    if (ts.isParenthesizedExpression(expression)) return this.#evaluateExpression(expression.expression, allowAssignment);
    if (ts.isAsExpression(expression) || ts.isTypeAssertionExpression(expression) || ts.isNonNullExpression(expression)) {
      return this.#evaluateExpression(expression.expression, allowAssignment);
    }
    if (ts.isNumericLiteral(expression)) return Number(expression.text);
    if (ts.isStringLiteralLike(expression)) return expression.text;
    if (expression.kind === ts.SyntaxKind.TrueKeyword) return true;
    if (expression.kind === ts.SyntaxKind.FalseKeyword) return false;
    if (expression.kind === ts.SyntaxKind.NullKeyword) return null;
    if (ts.isIdentifier(expression)) {
      if (expression.text === "undefined") return undefined;
      return this.#read(expression.text);
    }
    if (ts.isArrayLiteralExpression(expression)) return expression.elements.map((element) => this.#evaluateExpression(element as ts.Expression, false));
    if (ts.isObjectLiteralExpression(expression)) {
      const value: { [key: string]: RuntimeValue } = {};
      for (const property of expression.properties) {
        if (!ts.isPropertyAssignment(property)) throw new Error("Only object property assignments are supported.");
        const name = propertyName(property.name);
        value[name] = this.#evaluateExpression(property.initializer, false);
      }
      return value;
    }
    if (ts.isConditionalExpression(expression)) {
      return truthy(this.#evaluateExpression(expression.condition, false))
        ? this.#evaluateExpression(expression.whenTrue, allowAssignment)
        : this.#evaluateExpression(expression.whenFalse, allowAssignment);
    }
    if (ts.isPrefixUnaryExpression(expression)) return this.#prefix(expression, allowAssignment);
    if (ts.isPostfixUnaryExpression(expression)) return this.#postfix(expression, allowAssignment);
    if (ts.isBinaryExpression(expression)) return this.#binary(expression, allowAssignment);
    if (ts.isPropertyAccessExpression(expression)) {
      const target = this.#evaluateExpression(expression.expression, false);
      if (expression.name.text === "length" && (typeof target === "string" || Array.isArray(target))) return target.length;
      if (target && typeof target === "object" && !Array.isArray(target)) return target[expression.name.text];
      throw new Error(`Unsupported property access: ${expression.getText(this.#sourceFile)}`);
    }
    if (ts.isElementAccessExpression(expression)) {
      const target = this.#evaluateExpression(expression.expression, false);
      const key = expression.argumentExpression ? this.#evaluateExpression(expression.argumentExpression, false) : undefined;
      if ((Array.isArray(target) || typeof target === "string") && typeof key === "number") return target[key];
      if (target && typeof target === "object" && typeof key === "string") return target[key];
      throw new Error("Unsupported element access.");
    }
    if (ts.isCallExpression(expression)) return this.#call(expression);
    if (ts.isTemplateExpression(expression)) {
      let value = expression.head.text;
      for (const span of expression.templateSpans) value += `${formatRuntimeValue(this.#evaluateExpression(span.expression, false))}${span.literal.text}`;
      return value;
    }
    throw new Error(`Unsupported debug expression: ${ts.SyntaxKind[expression.kind]}`);
  }

  #binary(expression: ts.BinaryExpression, allowAssignment: boolean): RuntimeValue {
    const operator = expression.operatorToken.kind;
    const assignment = assignmentOperator(operator);
    if (assignment) {
      if (!allowAssignment || !ts.isIdentifier(expression.left)) throw new Error("Assignment is not allowed in this debug expression.");
      const right = this.#evaluateExpression(expression.right, false);
      const value = assignment === "=" ? right : calculateBinary(assignment, this.#read(expression.left.text), right);
      this.#write(expression.left.text, value);
      return value;
    }
    if (operator === ts.SyntaxKind.AmpersandAmpersandToken) {
      const left = this.#evaluateExpression(expression.left, false);
      return truthy(left) ? this.#evaluateExpression(expression.right, false) : left;
    }
    if (operator === ts.SyntaxKind.BarBarToken) {
      const left = this.#evaluateExpression(expression.left, false);
      return truthy(left) ? left : this.#evaluateExpression(expression.right, false);
    }
    return calculateBinary(ts.tokenToString(operator) ?? "", this.#evaluateExpression(expression.left, false), this.#evaluateExpression(expression.right, false));
  }

  #prefix(expression: ts.PrefixUnaryExpression, allowAssignment: boolean): RuntimeValue {
    if (expression.operator === ts.SyntaxKind.ExclamationToken) return !truthy(this.#evaluateExpression(expression.operand, false));
    if (expression.operator === ts.SyntaxKind.PlusToken) return numberValue(this.#evaluateExpression(expression.operand, false));
    if (expression.operator === ts.SyntaxKind.MinusToken) return -numberValue(this.#evaluateExpression(expression.operand, false));
    if ((expression.operator === ts.SyntaxKind.PlusPlusToken || expression.operator === ts.SyntaxKind.MinusMinusToken) && ts.isIdentifier(expression.operand)) {
      if (!allowAssignment) throw new Error("Mutation is not allowed in this debug expression.");
      const value = numberValue(this.#read(expression.operand.text)) + (expression.operator === ts.SyntaxKind.PlusPlusToken ? 1 : -1);
      this.#write(expression.operand.text, value);
      return value;
    }
    throw new Error("Unsupported prefix expression.");
  }

  #postfix(expression: ts.PostfixUnaryExpression, allowAssignment: boolean): RuntimeValue {
    if (!allowAssignment || !ts.isIdentifier(expression.operand)) throw new Error("Mutation is not allowed in this debug expression.");
    const previous = numberValue(this.#read(expression.operand.text));
    this.#write(expression.operand.text, previous + (expression.operator === ts.SyntaxKind.PlusPlusToken ? 1 : -1));
    return previous;
  }

  #call(expression: ts.CallExpression): RuntimeValue {
    const args = expression.arguments.map((argument) => this.#evaluateExpression(argument, false));
    if (ts.isPropertyAccessExpression(expression.expression)
      && ts.isIdentifier(expression.expression.expression)
      && expression.expression.expression.text === "console"
      && ["log", "debug", "warn", "error"].includes(expression.expression.name.text)) {
      this.#output(args.map(formatRuntimeValue).join(" "));
      return undefined;
    }
    if (ts.isIdentifier(expression.expression)) {
      const declaration = this.#functions.get(expression.expression.text);
      if (!declaration?.body) throw new Error(`Unknown function: ${expression.expression.text}`);
      const scope = new Map<string, RuntimeValue>();
      declaration.parameters.forEach((parameter, index) => {
        if (!ts.isIdentifier(parameter.name)) throw new Error("Destructured function parameters are not supported.");
        scope.set(parameter.name.text, args[index]);
      });
      this.#scopes.push(scope);
      try {
        this.#executeStatement(declaration.body);
      } catch (signal) {
        if (signal instanceof ReturnSignal) return signal.value;
        throw signal;
      } finally {
        this.#scopes.pop();
      }
      return undefined;
    }
    throw new Error("Only workspace functions and console output are callable in the browser debugger.");
  }

  #declare(name: string, value: RuntimeValue): void {
    this.#scopes.at(-1)?.set(name, value);
  }

  #read(name: string): RuntimeValue {
    for (let index = this.#scopes.length - 1; index >= 0; index -= 1) {
      const scope = this.#scopes[index];
      if (scope?.has(name)) return scope.get(name);
    }
    throw new Error(`Unknown variable: ${name}`);
  }

  #write(name: string, value: RuntimeValue): void {
    for (let index = this.#scopes.length - 1; index >= 0; index -= 1) {
      const scope = this.#scopes[index];
      if (scope?.has(name)) {
        scope.set(name, value);
        return;
      }
    }
    throw new Error(`Unknown variable: ${name}`);
  }

  #tick(): void {
    this.#steps += 1;
    if (this.#steps > MAX_EXECUTION_STEPS) throw new Error("Debug program exceeded the 100,000 step safety limit.");
  }
}

export function formatRuntimeValue(value: RuntimeValue): string {
  if (value === undefined) return "undefined";
  if (typeof value === "string") return value;
  if (typeof value === "number" || typeof value === "boolean" || value === null) return String(value);
  return JSON.stringify(value);
}

function isExecutableTopLevelStatement(statement: ts.Statement): boolean {
  return !ts.isImportDeclaration(statement)
    && !ts.isExportDeclaration(statement)
    && !ts.isInterfaceDeclaration(statement)
    && !ts.isTypeAliasDeclaration(statement)
    && !ts.isFunctionDeclaration(statement)
    && !ts.isClassDeclaration(statement)
    && !ts.isModuleDeclaration(statement)
    && !ts.isEmptyStatement(statement);
}

function assignmentOperator(kind: ts.SyntaxKind): string | null {
  if (kind === ts.SyntaxKind.EqualsToken) return "=";
  if (kind === ts.SyntaxKind.PlusEqualsToken) return "+";
  if (kind === ts.SyntaxKind.MinusEqualsToken) return "-";
  if (kind === ts.SyntaxKind.AsteriskEqualsToken) return "*";
  if (kind === ts.SyntaxKind.SlashEqualsToken) return "/";
  if (kind === ts.SyntaxKind.PercentEqualsToken) return "%";
  return null;
}

function calculateBinary(operator: string, left: RuntimeValue, right: RuntimeValue): RuntimeValue {
  if (operator === "+") return typeof left === "string" || typeof right === "string"
    ? `${formatRuntimeValue(left)}${formatRuntimeValue(right)}`
    : numberValue(left) + numberValue(right);
  if (operator === "-") return numberValue(left) - numberValue(right);
  if (operator === "*") return numberValue(left) * numberValue(right);
  if (operator === "/") return numberValue(left) / numberValue(right);
  if (operator === "%") return numberValue(left) % numberValue(right);
  if (operator === "<") return comparable(left) < comparable(right);
  if (operator === "<=") return comparable(left) <= comparable(right);
  if (operator === ">") return comparable(left) > comparable(right);
  if (operator === ">=") return comparable(left) >= comparable(right);
  if (operator === "==" || operator === "===") return left === right;
  if (operator === "!=" || operator === "!==") return left !== right;
  throw new Error(`Unsupported binary operator: ${operator}`);
}

function numberValue(value: RuntimeValue): number {
  if (typeof value !== "number" || !Number.isFinite(value)) throw new Error("Debug arithmetic requires finite numbers.");
  return value;
}

function comparable(value: RuntimeValue): string | number {
  if (typeof value === "number" || typeof value === "string") return value;
  throw new Error("Debug comparison requires numbers or strings.");
}

function truthy(value: RuntimeValue): boolean {
  return Boolean(value);
}

function propertyName(name: ts.PropertyName): string {
  if (ts.isIdentifier(name) || ts.isStringLiteralLike(name) || ts.isNumericLiteral(name)) return name.text;
  throw new Error("Computed object property names are not supported.");
}

function runtimeType(value: RuntimeValue): string {
  if (value === null) return "null";
  if (Array.isArray(value)) return "array";
  return typeof value;
}
