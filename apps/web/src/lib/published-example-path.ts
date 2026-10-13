const PUBLIC_ID = /^[A-Za-z0-9_-]{42}[AEIMQUYcgkosw048]$/u;
const VERSION_NUMBER = /^(?:[1-9]\d{0,15})$/u;

export function publicIdPathSegment(value: string): string | undefined {
  return PUBLIC_ID.test(value) ? value : undefined;
}

export function publicVersionPathSegment(value: string): number | undefined {
  if (!VERSION_NUMBER.test(value)) return undefined;
  const parsed = Number(value);
  return Number.isSafeInteger(parsed) ? parsed : undefined;
}
