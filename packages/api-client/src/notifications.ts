import { mutationOptions } from "./browser-mutation.ts";
import type { BrowserMutationOptions } from "./browser-mutation.ts";
import {
  type ApiResult,
  type DomainRequestOptions,
  validatedResult
} from "./domain.ts";
import type { ApiClient } from "./types.ts";
import {
  readBoolean,
  readBoundedArray,
  readBoundedString,
  readEnum,
  readExactRecord,
  readPositiveInteger,
  readUtcTimestamp,
  readUuidV7
} from "./validation.ts";

const CLASSIFICATIONS = ["critical_security", "account_access", "collaboration", "operations"] as const;
const NOTIFICATION_STATUSES = ["unread", "read", "archived"] as const;
const ACTION_STATES = ["none", "pending", "resolved", "canceled"] as const;
const DELIVERY_STATES = ["pending", "sending", "retry_wait", "sent", "dead_letter", "canceled"] as const;
const ERROR_CLASSES = ["transient", "permanent", "ambiguous"] as const;
const CURSOR = /^[A-Za-z0-9_-]{1,2048}$/u;
const IDEMPOTENCY_KEY = /^[A-Za-z0-9._:-]{16,128}$/u;

export type NotificationStatus = (typeof NOTIFICATION_STATUSES)[number];
export type EmailDeliveryState = (typeof DELIVERY_STATES)[number];

export interface NotificationInboxItem {
  readonly id: string;
  readonly classification: (typeof CLASSIFICATIONS)[number];
  readonly eventCode: string;
  readonly title: string;
  readonly summary: string;
  readonly status: NotificationStatus;
  readonly actionState: (typeof ACTION_STATES)[number];
  readonly occurrenceCount: number;
  readonly occurredAt: string;
  readonly version: number;
}

export interface NotificationInbox {
  readonly items: readonly NotificationInboxItem[];
  readonly nextCursor: string | null;
  readonly unreadCount: number;
}

export interface NotificationPreferences {
  readonly criticalSecurity: true;
  readonly accountAccess: boolean;
  readonly collaboration: boolean;
  readonly operations: boolean;
  readonly smtpConfigured: boolean;
  readonly version: number;
}

export interface EmailDelivery {
  readonly id: string;
  readonly recipientEmail: string;
  readonly classification: (typeof CLASSIFICATIONS)[number];
  readonly templateId: string;
  readonly resourceType: string;
  readonly resourceId: string;
  readonly state: EmailDeliveryState;
  readonly attemptCount: number;
  readonly smtpCode: number | null;
  readonly errorClass: (typeof ERROR_CLASSES)[number] | null;
  readonly availableAt: string;
  readonly updatedAt: string;
  readonly version: number;
}

export interface EmailDeliveryCollection {
  readonly items: readonly EmailDelivery[];
  readonly nextCursor: string | null;
  readonly smtpConfigured: boolean;
}

export interface NotificationAdminMutationOptions extends BrowserMutationOptions {
  readonly idempotencyKey: string;
}

export async function listNotifications(
  client: ApiClient,
  input: { readonly archived?: boolean; readonly cursor?: string; readonly limit?: number } = {},
  options: DomainRequestOptions = {}
): Promise<ApiResult<NotificationInbox>> {
  const parameters = pageParameters(input.cursor, input.limit);
  if (input.archived === true) parameters.set("archived", "true");
  return validatedResult(
    await client.get<unknown>(`/notifications${query(parameters)}`, options),
    parseInbox
  );
}

export async function updateNotificationStatus(
  client: ApiClient,
  item: Pick<NotificationInboxItem, "id" | "version">,
  status: NotificationStatus,
  options: BrowserMutationOptions
): Promise<ApiResult<NotificationInboxItem>> {
  const id = readUuidV7({ id: item.id }, "id");
  const version = positiveInteger(item.version, "notification version");
  const headers = new Headers({ "if-match": `"notification-v${version}"` });
  return validatedResult(
    await client.patch<unknown, { readonly status: NotificationStatus }>(
      `/notifications/${id}`,
      { status },
      mutationOptions(options, headers)
    ),
    parseInboxItem
  );
}

export async function getNotificationPreferences(
  client: ApiClient,
  options: DomainRequestOptions = {}
): Promise<ApiResult<NotificationPreferences>> {
  return validatedResult(await client.get<unknown>("/notification-preferences", options), parsePreferences);
}

export async function updateNotificationPreferences(
  client: ApiClient,
  input: Pick<NotificationPreferences, "accountAccess" | "collaboration" | "operations" | "version">,
  options: BrowserMutationOptions
): Promise<ApiResult<NotificationPreferences>> {
  const version = positiveInteger(input.version, "notification preference version");
  const headers = new Headers({ "if-match": `"notification-preferences-v${version}"` });
  return validatedResult(
    await client.patch<unknown, Omit<typeof input, "version">>(
      "/notification-preferences",
      {
        accountAccess: input.accountAccess,
        collaboration: input.collaboration,
        operations: input.operations
      },
      mutationOptions(options, headers)
    ),
    parsePreferences
  );
}

export async function listEmailDeliveries(
  client: ApiClient,
  input: { readonly state?: EmailDeliveryState; readonly cursor?: string; readonly limit?: number } = {},
  options: DomainRequestOptions = {}
): Promise<ApiResult<EmailDeliveryCollection>> {
  const parameters = pageParameters(input.cursor, input.limit);
  if (input.state !== undefined) parameters.set("state", input.state);
  return validatedResult(
    await client.get<unknown>(`/admin/email-deliveries${query(parameters)}`, options),
    parseDeliveryCollection
  );
}

export function retryEmailDelivery(
  client: ApiClient,
  delivery: Pick<EmailDelivery, "id" | "version">,
  options: NotificationAdminMutationOptions
): Promise<ApiResult<EmailDelivery>> {
  return deliveryMutation(client, delivery, "retry", options);
}

export function cancelEmailDelivery(
  client: ApiClient,
  delivery: Pick<EmailDelivery, "id" | "version">,
  options: NotificationAdminMutationOptions
): Promise<ApiResult<EmailDelivery>> {
  return deliveryMutation(client, delivery, "cancel", options);
}

async function deliveryMutation(
  client: ApiClient,
  delivery: Pick<EmailDelivery, "id" | "version">,
  operation: "cancel" | "retry",
  options: NotificationAdminMutationOptions
): Promise<ApiResult<EmailDelivery>> {
  const id = readUuidV7({ id: delivery.id }, "id");
  const version = positiveInteger(delivery.version, "email delivery version");
  if (!IDEMPOTENCY_KEY.test(options.idempotencyKey)) throw new TypeError("invalid idempotency key");
  const headers = new Headers({
    "idempotency-key": options.idempotencyKey,
    "if-match": `"email-delivery-v${version}"`
  });
  return validatedResult(
    await client.post<unknown>(
      `/admin/email-deliveries/${id}/${operation}`,
      undefined,
      mutationOptions(options, headers)
    ),
    parseDelivery
  );
}

function parseInbox(value: unknown): NotificationInbox {
  const record = readExactRecord(value, ["items", "nextCursor", "unreadCount"]);
  return {
    items: readBoundedArray(record, "items", 100).map(parseInboxItem),
    nextCursor: nullableCursor(record.nextCursor),
    unreadCount: nonNegativeInteger(record.unreadCount, "unread count")
  };
}

function parseInboxItem(value: unknown): NotificationInboxItem {
  const record = readExactRecord(value, [
    "actionState", "classification", "eventCode", "id", "occurredAt", "occurrenceCount",
    "status", "summary", "title", "version"
  ]);
  return {
    id: readUuidV7(record, "id"),
    classification: readEnum(record, "classification", CLASSIFICATIONS),
    eventCode: readBoundedString(record, "eventCode", 128),
    title: readBoundedString(record, "title", 200),
    summary: readBoundedString(record, "summary", 500),
    status: readEnum(record, "status", NOTIFICATION_STATUSES),
    actionState: readEnum(record, "actionState", ACTION_STATES),
    occurrenceCount: positiveInteger(record.occurrenceCount, "occurrence count"),
    occurredAt: readUtcTimestamp(record, "occurredAt"),
    version: readPositiveInteger(record, "version")
  };
}

function parsePreferences(value: unknown): NotificationPreferences {
  const record = readExactRecord(value, [
    "accountAccess", "collaboration", "criticalSecurity", "operations", "smtpConfigured", "version"
  ]);
  if (record.criticalSecurity !== true) throw new TypeError("critical security preference cannot be disabled");
  return {
    criticalSecurity: true,
    accountAccess: readBoolean(record, "accountAccess"),
    collaboration: readBoolean(record, "collaboration"),
    operations: readBoolean(record, "operations"),
    smtpConfigured: readBoolean(record, "smtpConfigured"),
    version: readPositiveInteger(record, "version")
  };
}

function parseDeliveryCollection(value: unknown): EmailDeliveryCollection {
  const record = readExactRecord(value, ["items", "nextCursor", "smtpConfigured"]);
  return {
    items: readBoundedArray(record, "items", 100).map(parseDelivery),
    nextCursor: nullableCursor(record.nextCursor),
    smtpConfigured: readBoolean(record, "smtpConfigured")
  };
}

function parseDelivery(value: unknown): EmailDelivery {
  const record = readExactRecord(value, [
    "attemptCount", "availableAt", "classification", "errorClass", "id", "recipientEmail",
    "resourceId", "resourceType", "smtpCode", "state", "templateId", "updatedAt", "version"
  ]);
  return {
    id: readUuidV7(record, "id"),
    recipientEmail: readBoundedString(record, "recipientEmail", 320),
    classification: readEnum(record, "classification", CLASSIFICATIONS),
    templateId: readBoundedString(record, "templateId", 128),
    resourceType: readBoundedString(record, "resourceType", 64),
    resourceId: readBoundedString(record, "resourceId", 200),
    state: readEnum(record, "state", DELIVERY_STATES),
    attemptCount: nonNegativeInteger(record.attemptCount, "attempt count", 32_767),
    smtpCode: nullableInteger(record.smtpCode, "SMTP code", 999),
    errorClass: record.errorClass === null ? null : readEnum(record, "errorClass", ERROR_CLASSES),
    availableAt: readUtcTimestamp(record, "availableAt"),
    updatedAt: readUtcTimestamp(record, "updatedAt"),
    version: readPositiveInteger(record, "version")
  };
}

function pageParameters(cursor: string | undefined, limit: number | undefined): URLSearchParams {
  const parameters = new URLSearchParams();
  if (cursor !== undefined) {
    if (!CURSOR.test(cursor)) throw new TypeError("invalid notification cursor");
    parameters.set("cursor", cursor);
  }
  if (limit !== undefined) {
    if (!Number.isSafeInteger(limit) || limit < 1 || limit > 100) throw new TypeError("invalid page limit");
    parameters.set("limit", String(limit));
  }
  return parameters;
}

function query(parameters: URLSearchParams): string {
  const value = parameters.toString();
  return value.length === 0 ? "" : `?${value}`;
}

function nullableCursor(value: unknown): string | null {
  if (value === null) return null;
  const cursor = readBoundedString({ cursor: value }, "cursor", 2_048);
  if (!CURSOR.test(cursor)) throw new TypeError("invalid notification cursor");
  return cursor;
}

function positiveInteger(value: unknown, label: string): number {
  if (!Number.isSafeInteger(value) || (value as number) < 1) throw new TypeError(`invalid ${label}`);
  return value as number;
}

function nonNegativeInteger(value: unknown, label: string, maximum = Number.MAX_SAFE_INTEGER): number {
  if (!Number.isSafeInteger(value) || (value as number) < 0 || (value as number) > maximum) {
    throw new TypeError(`invalid ${label}`);
  }
  return value as number;
}

function nullableInteger(value: unknown, label: string, maximum: number): number | null {
  return value === null ? null : nonNegativeInteger(value, label, maximum);
}
