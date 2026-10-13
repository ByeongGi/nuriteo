"use client";

import {
  ApiError,
  cancelEmailDelivery,
  listEmailDeliveries,
  retryEmailDelivery
} from "@nuriteo/api-client";
import type { EmailDelivery, EmailDeliveryCollection, EmailDeliveryState } from "@nuriteo/api-client";
import { useState } from "react";

import { Button } from "../../../../components/ui/button.tsx";
import { createBrowserApiClient } from "../../../../lib/api/browser-client.ts";
import { readCsrfCredential } from "../../../../lib/api/browser-security.ts";
import { useExclusiveMutation } from "../../../../lib/use-exclusive-mutation.ts";

const FILTERS: readonly { readonly value: EmailDeliveryState; readonly label: string }[] = [
  { value: "dead_letter", label: "Dead letter" },
  { value: "retry_wait", label: "Retry wait" },
  { value: "pending", label: "Pending" },
  { value: "sending", label: "Sending" },
  { value: "sent", label: "Sent" },
  { value: "canceled", label: "Canceled" }
];

export function EmailDeliveryConsole({ initial }: { readonly initial: EmailDeliveryCollection }) {
  const mutation = useExclusiveMutation();
  const [state, setState] = useState<EmailDeliveryState>("dead_letter");
  const [collection, setCollection] = useState(initial);
  const [confirmation, setConfirmation] = useState<{ readonly id: string; readonly operation: "cancel" | "retry" }>();
  const [feedback, setFeedback] = useState<{ readonly error: boolean; readonly text: string }>();

  async function selectState(next: EmailDeliveryState) {
    setState(next);
    setConfirmation(undefined);
    await mutation.run(async () => {
      try {
        const result = await listEmailDeliveries(createBrowserApiClient(), { state: next, limit: 25 });
        setCollection(result.data);
        setFeedback(undefined);
      } catch (error) {
        setFeedback(deliveryFailure(error));
      }
    });
  }

  async function loadMore() {
    const cursor = collection.nextCursor;
    if (cursor === null) return;
    await mutation.run(async () => {
      try {
        const result = await listEmailDeliveries(createBrowserApiClient(), { state, cursor, limit: 25 });
        setCollection((current) => ({
          ...result.data,
          items: current === undefined
            ? result.data.items
            : mergeUniqueDeliveries(current.items, result.data.items)
        }));
      } catch (error) {
        setFeedback(deliveryFailure(error));
      }
    });
  }

  async function apply(delivery: EmailDelivery, operation: "cancel" | "retry") {
    if (confirmation?.id !== delivery.id || confirmation.operation !== operation) {
      setConfirmation({ id: delivery.id, operation });
      return;
    }
    await mutation.run(async () => {
      try {
        const options = {
          csrfToken: readCsrfCredential(),
          idempotencyKey: `notification-${operation}-${crypto.randomUUID()}`
        };
        const result = operation === "retry"
          ? await retryEmailDelivery(createBrowserApiClient(), delivery, options)
          : await cancelEmailDelivery(createBrowserApiClient(), delivery, options);
        setCollection((current) => ({
          ...current,
          items: current.items.filter((item) => item.id !== delivery.id)
        }));
        setConfirmation(undefined);
        setFeedback({
          error: false,
          text: operation === "retry"
            ? `A new pending delivery ${result.data.id} was created.`
            : "The delivery was discarded without changing its related domain resource."
        });
      } catch (error) {
        setConfirmation(undefined);
        setFeedback(deliveryFailure(error));
      }
    });
  }

  return (
    <main id="main-content" className="workspace-page email-delivery-page">
      <header className="workspace-page__intro">
        <p className="eyebrow">Instance administration</p>
        <h1>Email delivery</h1>
        <p>Inspect sanitized delivery metadata. Message bodies, tokens, credentials, and provider response text are never shown.</p>
      </header>
      {!collection.smtpConfigured ? <div className="notification-smtp-warning" role="status"><strong>SMTP unavailable</strong><span>Pending email cannot be sent until SMTP is configured. In-app notifications continue normally.</span></div> : null}
      <section className="email-delivery-console" aria-labelledby="delivery-list-title">
        <div className="notification-heading">
          <h2 id="delivery-list-title">Delivery queue</h2>
          <label>State<select value={state} disabled={mutation.isPending} onChange={(event) => selectState(event.currentTarget.value as EmailDeliveryState)}>{FILTERS.map((option) => <option key={option.value} value={option.value}>{option.label}</option>)}</select></label>
        </div>
        {collection.items.length === 0 ? <p className="notification-empty">No deliveries in this state.</p> : (
          <div className="email-delivery-list">
            {collection.items.map((delivery) => {
              const pending = confirmation?.id === delivery.id ? confirmation.operation : undefined;
              return (
                <article key={delivery.id} className="email-delivery-card">
                  <div className="email-delivery-card__heading"><h3>{delivery.recipientEmail}</h3><span>{delivery.state.replace("_", " ")}</span></div>
                  <dl>
                    <div><dt>Template</dt><dd>{delivery.templateId}</dd></div>
                    <div><dt>Resource</dt><dd>{delivery.resourceType}: {delivery.resourceId}</dd></div>
                    <div><dt>Attempts</dt><dd>{delivery.attemptCount}</dd></div>
                    <div><dt>Sanitized error</dt><dd>{delivery.errorClass ?? "None"}{delivery.smtpCode === null ? "" : ` · SMTP ${delivery.smtpCode}`}</dd></div>
                    <div><dt>Updated</dt><dd><time dateTime={delivery.updatedAt}>{formatDate(delivery.updatedAt)}</time></dd></div>
                    <div><dt>Available</dt><dd><time dateTime={delivery.availableAt}>{formatDate(delivery.availableAt)}</time></dd></div>
                  </dl>
                  <div className="email-delivery-card__actions">
                    {delivery.state === "dead_letter" ? <Button variant={pending === "retry" ? "danger" : "secondary"} disabled={mutation.isPending} onClick={() => apply(delivery, "retry")}>{pending === "retry" ? "Confirm retry" : "Retry now"}</Button> : null}
                    {(["pending", "retry_wait"] as const).includes(delivery.state as "pending" | "retry_wait") ? <Button variant={pending === "cancel" ? "danger" : "secondary"} disabled={mutation.isPending} onClick={() => apply(delivery, "cancel")}>{pending === "cancel" ? "Confirm discard" : "Discard"}</Button> : null}
                    {pending ? <Button disabled={mutation.isPending} onClick={() => setConfirmation(undefined)}>Keep delivery</Button> : null}
                  </div>
                  {pending ? <p className="email-delivery-card__confirmation" role="alert">{pending === "retry" ? "Retry creates a new attempt after revalidating current delivery eligibility." : "Discard is terminal for this delivery only."} This action requires recent administrator reauthentication.</p> : null}
                </article>
              );
            })}
          </div>
        )}
        {collection.nextCursor !== null ? <Button disabled={mutation.isPending} onClick={loadMore}>{mutation.isPending ? "Loading…" : "Load more"}</Button> : null}
      </section>
      {feedback ? <p className={`notification-feedback notification-feedback--${feedback.error ? "error" : "success"}`} role={feedback.error ? "alert" : "status"}>{feedback.text}</p> : null}
    </main>
  );
}

function mergeUniqueDeliveries(current: readonly EmailDelivery[], incoming: readonly EmailDelivery[]) {
  const known = new Set(current.map((item) => item.id));
  return [...current, ...incoming.filter((item) => !known.has(item.id))];
}

function formatDate(value: string) {
  return new Intl.DateTimeFormat(undefined, { dateStyle: "medium", timeStyle: "short" }).format(new Date(value));
}

function deliveryFailure(error: unknown): { readonly error: true; readonly text: string } {
  if (error instanceof ApiError && error.status === 403) return { error: true, text: "Recent administrator reauthentication or instance administrator access is required." };
  if (error instanceof ApiError && (error.status === 412 || error.status === 428 || error.code === "COMMIT_OUTCOME_UNKNOWN")) return { error: true, text: "Delivery state may have changed. Reload this queue before trying another action." };
  if (error instanceof ApiError && error.status === 409) return { error: true, text: "This delivery state no longer permits that action. Reload the queue." };
  return { error: true, text: "The delivery operation could not be completed safely." };
}
