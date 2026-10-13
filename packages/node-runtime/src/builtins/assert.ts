import type { RuntimeValue } from "../types.ts";

export class AssertionError extends Error {
  actual: RuntimeValue;
  expected: RuntimeValue;
  operator: string;

  constructor(options: { actual?: RuntimeValue; expected?: RuntimeValue; message?: string | undefined; operator?: string } = {}) {
    super(options.message || `Expected values to be strictly ${options.operator || "equal"}`);
    this.name = "AssertionError";
    this.actual = options.actual;
    this.expected = options.expected;
    this.operator = options.operator || "strictEqual";
  }
}

export function ok(value: RuntimeValue, message?: string): asserts value {
  if (!value) throw new AssertionError({ actual: value, expected: true, message, operator: "==" });
}

export function equal(actual: RuntimeValue, expected: RuntimeValue, message?: string): void {
  if (actual != expected) throw new AssertionError({ actual, expected, message, operator: "==" });
}

export function strictEqual(actual: RuntimeValue, expected: RuntimeValue, message?: string): void {
  if (!Object.is(actual, expected)) throw new AssertionError({ actual, expected, message, operator: "strictEqual" });
}

export function deepEqual(actual: RuntimeValue, expected: RuntimeValue, message?: string): void {
  if (!deepCompare(actual, expected)) throw new AssertionError({ actual, expected, message, operator: "deepEqual" });
}

export const deepStrictEqual = deepEqual;
export const notStrictEqual = (actual: RuntimeValue, expected: RuntimeValue, message?: string): void => {
  if (Object.is(actual, expected)) throw new AssertionError({ actual, expected, message, operator: "notStrictEqual" });
};

export function throws(fn: () => RuntimeValue, expected?: RegExp | ((error: RuntimeValue) => boolean), message?: string): void {
  try {
    fn();
  } catch (error) {
    if (expected instanceof RegExp && !expected.test(String((error as Error).message || error))) throw error;
    if (typeof expected === "function" && !expected(error)) throw error;
    return;
  }
  throw new AssertionError({ message: message || "Missing expected exception", operator: "throws" });
}

export async function rejects(fn: (() => Promise<RuntimeValue>) | Promise<RuntimeValue>, expected?: RegExp | ((error: RuntimeValue) => boolean), message?: string): Promise<void> {
  try {
    await (typeof fn === "function" ? fn() : fn);
  } catch (error) {
    if (expected instanceof RegExp && !expected.test(String((error as Error).message || error))) throw error;
    if (typeof expected === "function" && !expected(error)) throw error;
    return;
  }
  throw new AssertionError({ message: message || "Missing expected rejection", operator: "rejects" });
}

export const strict = Object.freeze({
  AssertionError,
  deepEqual,
  deepStrictEqual,
  equal: strictEqual,
  notStrictEqual,
  ok,
  rejects,
  strictEqual,
  throws
});

export const assertBuiltin = Object.assign(ok, {
  AssertionError,
  deepEqual,
  deepStrictEqual,
  default: ok,
  equal,
  notStrictEqual,
  ok,
  rejects,
  strict,
  strictEqual,
  throws
});

function deepCompare(actual: RuntimeValue, expected: RuntimeValue): boolean {
  if (Object.is(actual, expected)) return true;
  if (!actual || !expected || typeof actual !== "object" || typeof expected !== "object") return false;
  if (Array.isArray(actual) !== Array.isArray(expected)) return false;
  const actualEntries = Object.entries(actual as Record<string, RuntimeValue>);
  const expectedEntries = Object.entries(expected as Record<string, RuntimeValue>);
  if (actualEntries.length !== expectedEntries.length) return false;
  return actualEntries.every(([key, value]) => deepCompare(value, (expected as Record<string, RuntimeValue>)[key]));
}
