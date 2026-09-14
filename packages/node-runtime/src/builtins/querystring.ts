export interface QueryStringParseOptions {
  maxKeys?: number;
}

export function escape(value: string): string {
  return encodeURIComponent(value);
}

export function unescape(value: string): string {
  try {
    return decodeURIComponent(value.replace(/\+/g, "%20"));
  } catch {
    return value;
  }
}

export function parse(
  input: string,
  separator = "&",
  equals = "=",
  options: QueryStringParseOptions = {}
): Record<string, string | string[]> {
  const result: Record<string, string | string[]> = Object.create(null);
  if (!input) return result;

  const maxKeys = options.maxKeys ?? 1000;
  const pairs = input.split(separator, maxKeys > 0 ? maxKeys : undefined);
  for (const pair of pairs) {
    const index = pair.indexOf(equals);
    const rawKey = index === -1 ? pair : pair.slice(0, index);
    const rawValue = index === -1 ? "" : pair.slice(index + equals.length);
    const key = unescape(rawKey);
    const value = unescape(rawValue);
    const previous = result[key];
    if (Array.isArray(previous)) previous.push(value);
    else if (previous !== undefined) result[key] = [previous, value];
    else result[key] = value;
  }

  return result;
}

export function stringify(
  input: Record<string, string | number | boolean | readonly (string | number | boolean)[] | null | undefined>,
  separator = "&",
  equals = "="
): string {
  const pairs: string[] = [];
  for (const [key, rawValue] of Object.entries(input)) {
    const values = Array.isArray(rawValue) ? rawValue : [rawValue];
    for (const value of values) {
      pairs.push(`${escape(key)}${equals}${escape(value == null ? "" : String(value))}`);
    }
  }
  return pairs.join(separator);
}

export const encode = stringify;
export const decode = parse;

export const querystringBuiltin = Object.freeze({
  decode,
  encode,
  escape,
  parse,
  stringify,
  unescape
});
