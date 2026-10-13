import { ApiInvalidResponseError } from "./errors.ts";

export class OneTimeUrl {
  #value: string | undefined;

  private constructor(value: string) {
    this.#value = value;
  }

  static parse(
    value: unknown,
    expectedPath: string,
    status: number,
    requestId: string | undefined
  ): OneTimeUrl {
    if (typeof value !== "string" || value.length > 2_048) {
      throw new ApiInvalidResponseError(status, requestId);
    }
    try {
      const url = new URL(value);
      const pairs = [...url.searchParams.entries()];
      if (
        !["http:", "https:"].includes(url.protocol) ||
        url.username !== "" ||
        url.password !== "" ||
        url.pathname !== expectedPath ||
        url.hash !== "" ||
        pairs.length !== 1 ||
        pairs[0]?.[0] !== "token" ||
        !isTokenForPath(pairs[0][1], expectedPath)
      ) {
        throw new Error("invalid one-time URL");
      }
      return new OneTimeUrl(url.toString());
    } catch {
      throw new ApiInvalidResponseError(status, requestId);
    }
  }

  consume(): string {
    const value = this.#value;
    this.#value = undefined;
    if (value === undefined) {
      throw new Error("The one-time URL has already been consumed.");
    }
    return value;
  }

  toJSON(): string {
    return "[REDACTED]";
  }

  toString(): string {
    return "[REDACTED]";
  }
}

export function isTokenForPath(value: string, path: string): boolean {
  const prefix = path === "/activate"
    ? "nrt_inv_"
    : path === "/organization-invitations/accept"
      ? "nrt_org_inv_"
      : undefined;
  return prefix !== undefined &&
    value.length === prefix.length + 43 &&
    value.startsWith(prefix) &&
    /^[A-Za-z0-9_-]+$/u.test(value.slice(prefix.length));
}
