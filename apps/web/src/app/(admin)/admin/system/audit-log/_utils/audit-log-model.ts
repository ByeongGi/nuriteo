export interface AuditEvent {
  readonly actionCode: string;
  readonly actorDisplayName: string | null;
  readonly actorId: string;
  readonly id: string;
  readonly occurredAt: string;
  readonly result: string;
  readonly targetId: string;
  readonly targetType: string;
}

export interface AuditEventPage {
  readonly items: readonly AuditEvent[];
  readonly nextCursor: string | null;
}

export function parseAuditEventCollection(value: unknown): AuditEventPage {
  if (!isRecord(value) || !Array.isArray(value.items) || value.items.length > 100) throw new TypeError("invalid audit event collection");
  const nextCursor = value.nextCursor;
  if (nextCursor !== null && (typeof nextCursor !== "string" || nextCursor.length === 0 || nextCursor.length > 2048)) throw new TypeError("invalid audit event cursor");
  return {
    items: value.items.map((item) => {
      if (!isRecord(item)) throw new TypeError("invalid audit event");
      return {
        id: text(item.id), occurredAt: text(item.occurredAt), actorDisplayName: nullableText(item.actorDisplayName),
        actorId: text(item.actorId), actionCode: text(item.actionCode), targetType: text(item.targetType),
        targetId: text(item.targetId), result: text(item.result)
      };
    }),
    nextCursor
  };
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === "object" && !Array.isArray(value);
}

function text(value: unknown): string {
  if (typeof value !== "string" || value.length === 0 || value.length > 2048) throw new TypeError("invalid audit event field");
  return value;
}

function nullableText(value: unknown): string | null {
  return value === null ? null : text(value);
}
