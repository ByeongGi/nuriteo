"use client";

import {
  ApiError,
  listNotifications,
  updateNotificationPreferences,
  updateNotificationStatus
} from "@nuriteo/api-client";
import type {
  NotificationInbox,
  NotificationInboxItem,
  NotificationPreferences,
  NotificationStatus
} from "@nuriteo/api-client";
import { useState } from "react";
import type { FormEvent } from "react";

import { Button } from "../../../components/ui/button.tsx";
import { createBrowserApiClient } from "../../../lib/api/browser-client.ts";
import { readCsrfCredential } from "../../../lib/api/browser-security.ts";
import { useExclusiveMutation } from "../../../lib/use-exclusive-mutation.ts";

type View = "active" | "archived";

export function NotificationCenter({
  initialActive,
  initialArchived,
  initialPreferences
}: {
  readonly initialActive: NotificationInbox;
  readonly initialArchived: NotificationInbox;
  readonly initialPreferences: NotificationPreferences;
}) {
  const mutation = useExclusiveMutation();
  const [view, setView] = useState<View>("active");
  const [active, setActive] = useState(initialActive);
  const [archived, setArchived] = useState(initialArchived);
  const [preferences, setPreferences] = useState(initialPreferences);
  const [feedback, setFeedback] = useState<{ readonly error: boolean; readonly text: string }>();
  const collection = view === "active" ? active : archived;

  async function changeStatus(item: NotificationInboxItem, status: NotificationStatus) {
    await mutation.run(async () => {
      setFeedback(undefined);
      try {
        const result = await updateNotificationStatus(
          createBrowserApiClient(),
          item,
          status,
          { csrfToken: readCsrfCredential() }
        );
        reconcileItem(result.data);
      } catch (error) {
        setFeedback(notificationFailure(error));
      }
    });
  }

  function reconcileItem(item: NotificationInboxItem) {
    setActive((current) => ({
      ...current,
      items: item.status === "archived"
        ? current.items.filter((candidate) => candidate.id !== item.id)
        : replaceOrPrepend(current.items, item),
      unreadCount: unreadAfter(current, item)
    }));
    setArchived((current) => ({
      ...current,
      items: item.status === "archived"
        ? replaceOrPrepend(current.items, item)
        : current.items.filter((candidate) => candidate.id !== item.id)
    }));
  }

  async function loadMore() {
    const cursor = collection.nextCursor;
    if (cursor === null) return;
    await mutation.run(async () => {
      try {
        const result = await listNotifications(createBrowserApiClient(), {
          archived: view === "archived",
          cursor,
          limit: 25
        });
        const update = (current: NotificationInbox): NotificationInbox => ({
          ...result.data,
          items: mergeUniqueNotifications(current.items, result.data.items)
        });
        if (view === "active") setActive(update);
        else setArchived(update);
      } catch (error) {
        setFeedback(notificationFailure(error));
      }
    });
  }

  async function savePreferences(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    const data = new FormData(event.currentTarget);
    await mutation.run(async () => {
      setFeedback(undefined);
      try {
        const result = await updateNotificationPreferences(
          createBrowserApiClient(),
          {
            accountAccess: data.get("accountAccess") === "on",
            collaboration: data.get("collaboration") === "on",
            operations: data.get("operations") === "on",
            version: preferences.version
          },
          { csrfToken: readCsrfCredential() }
        );
        setPreferences(result.data);
        setFeedback({ error: false, text: "Email preferences saved." });
      } catch (error) {
        setFeedback(notificationFailure(error));
      }
    });
  }

  return (
    <main id="main-content" className="workspace-page notification-page">
      <header className="workspace-page__intro">
        <p className="eyebrow">Account inbox</p>
        <h1>Notifications</h1>
        <p>Review security, account access, collaboration, and operations updates without exposing private payload data.</p>
      </header>

      <section className="notification-inbox" aria-labelledby="notification-inbox-title">
        <div className="notification-heading">
          <div>
            <p className="eyebrow">{active.unreadCount} unread</p>
            <h2 id="notification-inbox-title">Inbox</h2>
          </div>
          <div className="notification-tabs" role="tablist" aria-label="Notification lists">
            <Button role="tab" aria-selected={view === "active"} variant={view === "active" ? "primary" : "secondary"} onClick={() => setView("active")}>Active</Button>
            <Button role="tab" aria-selected={view === "archived"} variant={view === "archived" ? "primary" : "secondary"} onClick={() => setView("archived")}>Archived</Button>
          </div>
        </div>
        {collection.items.length === 0 ? (
          <p className="notification-empty">No {view} notifications.</p>
        ) : (
          <ol className="notification-list" aria-live="polite">
            {collection.items.map((item) => (
              <li key={item.id} className={`notification-item notification-item--${item.status}`}>
                <div className="notification-item__copy">
                  <p className="notification-item__meta"><span>{labelClassification(item.classification)}</span><time dateTime={item.occurredAt}>{formatDate(item.occurredAt)}</time></p>
                  <h3>{item.title}</h3>
                  <p>{item.summary}</p>
                  {item.occurrenceCount > 1 ? <small>Occurred {item.occurrenceCount} times</small> : null}
                  {item.actionState !== "none" ? <small>Action state: {item.actionState}</small> : null}
                </div>
                <div className="notification-item__actions">
                  {item.status === "unread" ? <Button disabled={mutation.isPending} onClick={() => changeStatus(item, "read")}>Mark read</Button> : null}
                  {item.status === "read" ? <Button disabled={mutation.isPending} onClick={() => changeStatus(item, "unread")}>Mark unread</Button> : null}
                  {item.status === "archived" ? <Button disabled={mutation.isPending} onClick={() => changeStatus(item, "read")}>Restore</Button> : <Button disabled={mutation.isPending} onClick={() => changeStatus(item, "archived")}>Archive</Button>}
                </div>
              </li>
            ))}
          </ol>
        )}
        {collection.nextCursor !== null ? <Button disabled={mutation.isPending} onClick={loadMore}>{mutation.isPending ? "Loading…" : "Load more"}</Button> : null}
      </section>

      <section className="notification-preferences" aria-labelledby="notification-preferences-title">
        <div>
          <p className="eyebrow">Email channels</p>
          <h2 id="notification-preferences-title">Preferences</h2>
          <p>{preferences.smtpConfigured ? "Email delivery is available." : "SMTP is not configured. Your choices are saved, and in-app notifications remain available."}</p>
        </div>
        <form onSubmit={savePreferences} aria-busy={mutation.isPending}>
          <Preference name="criticalSecurity" label="Critical security" description="Always attempted when SMTP is available." checked disabled />
          <Preference name="accountAccess" label="Account and access" description="Password, MFA, membership, and permission changes." checked={preferences.accountAccess} />
          <Preference name="collaboration" label="Collaboration" description="Invitations and shared project activity." checked={preferences.collaboration} />
          <Preference name="operations" label="Operations" description="Instance health and delivery incidents for administrators." checked={preferences.operations} />
          <Button type="submit" variant="primary" disabled={mutation.isPending}>{mutation.isPending ? "Saving…" : "Save preferences"}</Button>
        </form>
      </section>

      {feedback ? <p className={`notification-feedback notification-feedback--${feedback.error ? "error" : "success"}`} role={feedback.error ? "alert" : "status"}>{feedback.text}</p> : null}
    </main>
  );
}

function Preference({ name, label, description, checked, disabled = false }: {
  readonly name: string;
  readonly label: string;
  readonly description: string;
  readonly checked: boolean;
  readonly disabled?: boolean;
}) {
  return (
    <label className="notification-preference">
      <input type="checkbox" name={name} defaultChecked={checked} disabled={disabled} />
      <span><strong>{label}</strong><small>{description}</small></span>
    </label>
  );
}

function replaceOrPrepend(items: readonly NotificationInboxItem[], item: NotificationInboxItem) {
  const found = items.some((candidate) => candidate.id === item.id);
  return found ? items.map((candidate) => candidate.id === item.id ? item : candidate) : [item, ...items];
}

function mergeUniqueNotifications(
  current: readonly NotificationInboxItem[],
  incoming: readonly NotificationInboxItem[]
) {
  const known = new Set(current.map((item) => item.id));
  return [...current, ...incoming.filter((item) => !known.has(item.id))];
}

function unreadAfter(current: NotificationInbox, item: NotificationInboxItem) {
  const previous = current.items.find((candidate) => candidate.id === item.id)?.status;
  const removedUnread = previous === "unread" && item.status !== "unread" ? 1 : 0;
  const addedUnread = previous !== "unread" && item.status === "unread" ? 1 : 0;
  return Math.max(0, current.unreadCount - removedUnread + addedUnread);
}

function labelClassification(value: NotificationInboxItem["classification"]) {
  return value.split("_").map((word) => word[0]?.toUpperCase() + word.slice(1)).join(" ");
}

function formatDate(value: string) {
  return new Intl.DateTimeFormat(undefined, { dateStyle: "medium", timeStyle: "short" }).format(new Date(value));
}

function notificationFailure(error: unknown): { readonly error: true; readonly text: string } {
  if (error instanceof ApiError && error.code === "COMMIT_OUTCOME_UNKNOWN") {
    return { error: true, text: "The server may have saved this change. Reload the page to reconcile the latest state." };
  }
  if (error instanceof ApiError && (error.status === 412 || error.status === 428)) {
    return { error: true, text: "This notification changed elsewhere. Reload the page to reconcile the latest state." };
  }
  return { error: true, text: "The notification service is temporarily unavailable. Your previous state was preserved." };
}
