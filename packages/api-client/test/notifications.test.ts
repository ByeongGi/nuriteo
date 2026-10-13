import assert from "node:assert/strict";

import {
  ApiInvalidResponseError,
  cancelEmailDelivery,
  createApiClient,
  getNotificationPreferences,
  listEmailDeliveries,
  listNotifications,
  retryEmailDelivery,
  updateNotificationPreferences,
  updateNotificationStatus
} from "../src/index.ts";

const NOTIFICATION_ID = "0199ee6c-c777-7000-8000-000000030001";
const DELIVERY_ID = "0199ee6c-c777-7000-8000-000000030002";
const CSRF = "nrt_csrf_notification_contract";
const IDEMPOTENCY = "notification-contract-retry-0001";

await notificationContracts();
await malformedPayloadsFailClosed();

async function notificationContracts() {
  const calls: Array<{ input: RequestInfo | URL; init?: RequestInit }> = [];
  const responses = [
    json(inbox()),
    json({ ...inbox().items[0], status: "read", version: 2 }),
    json(preferences()),
    json({ ...preferences(), collaboration: true, version: 2 }),
    json(deliveries()),
    json({ ...deliveries().items[0], id: "0199ee6c-c777-7000-8000-000000030003", state: "pending", attemptCount: 0, smtpCode: null, errorClass: null, version: 1 }),
    json({ ...deliveries().items[0], state: "canceled", version: 5 })
  ];
  const client = createApiClient({ fetch: async (input, init) => {
    calls.push({ input, ...(init === undefined ? {} : { init }) });
    const response = responses.shift();
    assert.ok(response);
    return response;
  } });

  const notifications = await listNotifications(client, { archived: false, limit: 25 });
  assert.equal(notifications.data.unreadCount, 1);
  await updateNotificationStatus(client, notifications.data.items[0]!, "read", { csrfToken: CSRF });
  const currentPreferences = await getNotificationPreferences(client);
  assert.equal(currentPreferences.data.criticalSecurity, true);
  await updateNotificationPreferences(client, { ...currentPreferences.data, collaboration: true }, { csrfToken: CSRF });
  const deliveryCollection = await listEmailDeliveries(client, { state: "dead_letter", limit: 25 });
  await retryEmailDelivery(client, deliveryCollection.data.items[0]!, { csrfToken: CSRF, idempotencyKey: IDEMPOTENCY });
  await cancelEmailDelivery(client, deliveryCollection.data.items[0]!, { csrfToken: CSRF, idempotencyKey: "notification-contract-cancel-0001" });

  assert.deepEqual(calls.map(({ input, init }) => [init?.method, String(input)]), [
    ["GET", "/api/v1/notifications?limit=25"],
    ["PATCH", `/api/v1/notifications/${NOTIFICATION_ID}`],
    ["GET", "/api/v1/notification-preferences"],
    ["PATCH", "/api/v1/notification-preferences"],
    ["GET", "/api/v1/admin/email-deliveries?limit=25&state=dead_letter"],
    ["POST", `/api/v1/admin/email-deliveries/${DELIVERY_ID}/retry`],
    ["POST", `/api/v1/admin/email-deliveries/${DELIVERY_ID}/cancel`]
  ]);
  assert.equal(new Headers(calls[1]?.init?.headers).get("if-match"), '"notification-v1"');
  assert.equal(new Headers(calls[3]?.init?.headers).get("if-match"), '"notification-preferences-v1"');
  assert.equal(new Headers(calls[5]?.init?.headers).get("if-match"), '"email-delivery-v4"');
  assert.equal(new Headers(calls[5]?.init?.headers).get("idempotency-key"), IDEMPOTENCY);
  assert.equal(new Headers(calls[5]?.init?.headers).get("x-csrf-token"), CSRF);
}

async function malformedPayloadsFailClosed() {
  await assert.rejects(() => listNotifications(single({ ...inbox(), secret: "leak" })), ApiInvalidResponseError);
  await assert.rejects(() => getNotificationPreferences(single({ ...preferences(), criticalSecurity: false })), ApiInvalidResponseError);
  await assert.rejects(() => listEmailDeliveries(single({ ...deliveries(), items: [{ ...deliveries().items[0], lastError: "provider response" }] })), ApiInvalidResponseError);
  await assert.rejects(() => retryEmailDelivery(single(deliveries().items[0]), deliveries().items[0]!, { csrfToken: CSRF, idempotencyKey: "short" }), /idempotency/u);
}

function inbox() {
  return {
    items: [{ id: NOTIFICATION_ID, classification: "account_access", eventCode: "identity.password.changed", title: "Account access updated", summary: "Review this account or access change.", status: "unread", actionState: "none", occurrenceCount: 1, occurredAt: "2026-10-08T00:00:00Z", version: 1 }],
    nextCursor: null,
    unreadCount: 1
  };
}

function preferences() {
  return { criticalSecurity: true, accountAccess: true, collaboration: false, operations: false, smtpConfigured: false, version: 1 };
}

function deliveries() {
  return {
    items: [{ id: DELIVERY_ID, recipientEmail: "user@example.test", classification: "account_access", templateId: "identity.password_changed", resourceType: "user", resourceId: NOTIFICATION_ID, state: "dead_letter", attemptCount: 8, smtpCode: 550, errorClass: "permanent", availableAt: "2026-10-08T00:00:00Z", updatedAt: "2026-10-08T01:00:00Z", version: 4 }],
    nextCursor: null,
    smtpConfigured: false
  };
}

function single(payload: unknown) { return createApiClient({ fetch: async () => json(payload) }); }
function json(payload: unknown) { return Response.json(payload, { headers: { "x-request-id": "notification-test" } }); }
