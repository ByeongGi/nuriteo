"use client";

import { useDeferredValue, useMemo, useState } from "react";

import { readCsrfCredential } from "@/lib/api/browser-security.ts";
import { createBrowserApiClient } from "@/lib/api/browser-client.ts";
import { useExclusiveMutation } from "@/lib/use-exclusive-mutation.ts";
import { ApiError } from "@/services/http/api.ts";
import { listNotifications, updateNotificationStatus } from "@/services/notifications/api.ts";

import type { NotificationInbox, NotificationInboxItem, NotificationStatus } from "@nuriteo/api-client";

type View = "active" | "archived";
type ClassificationFilter = "all" | NotificationInboxItem["classification"];

export function useNotificationCenter(initialActive: NotificationInbox, initialArchived: NotificationInbox) {
  const mutation = useExclusiveMutation();
  const [view, setView] = useState<View>("active");
  const [active, setActive] = useState(initialActive);
  const [archived, setArchived] = useState(initialArchived);
  const [query, setQuery] = useState("");
  const deferredQuery = useDeferredValue(query);
  const [classification, setClassification] = useState<ClassificationFilter>("all");
  const [feedback, setFeedback] = useState<{ readonly error: boolean; readonly text: string }>();
  const collection = view === "active" ? active : archived;
  const normalizedQuery = deferredQuery.trim().toLocaleLowerCase("ko-KR");
  const visibleItems = useMemo(() => collection.items.filter((item) => (
    (classification === "all" || item.classification === classification)
    && (normalizedQuery === "" || `${item.title} ${item.summary}`.toLocaleLowerCase("ko-KR").includes(normalizedQuery))
  )), [classification, collection.items, normalizedQuery]);

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

  function selectView(value: unknown) {
    setView(value as View);
  }

  return {
    active,
    archived,
    changeStatus,
    classification,
    collection,
    feedback,
    isFiltering: query !== deferredQuery,
    isPending: mutation.isPending,
    loadMore,
    query,
    selectView,
    setClassification,
    setQuery,
    view,
    visibleItems
  };
}

function replaceOrPrepend(items: readonly NotificationInboxItem[], item: NotificationInboxItem) {
  const found = items.some((candidate) => candidate.id === item.id);
  if (!found) return [item, ...items];
  return items.map((candidate) => {
    if (candidate.id === item.id) return item;
    return candidate;
  });
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

function notificationFailure(error: unknown): { readonly error: true; readonly text: string } {
  if (error instanceof ApiError && error.code === "COMMIT_OUTCOME_UNKNOWN") {
    return { error: true, text: "서버가 변경사항을 저장했을 수 있습니다. 페이지를 새로고침해 최신 상태를 확인하세요." };
  }
  if (error instanceof ApiError && (error.status === 412 || error.status === 428)) {
    return { error: true, text: "이 알림이 다른 곳에서 변경되었습니다. 페이지를 새로고침해 최신 상태를 확인하세요." };
  }
  return { error: true, text: "알림 서비스를 일시적으로 사용할 수 없습니다. 이전 상태는 그대로 보존했습니다." };
}
