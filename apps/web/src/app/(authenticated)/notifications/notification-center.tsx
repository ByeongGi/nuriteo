"use client";

import {
  ApiError,
  listNotifications,
  updateNotificationStatus
} from "@nuriteo/api-client";
import type {
  NotificationInbox,
  NotificationInboxItem,
  NotificationStatus
} from "@nuriteo/api-client";
import { useDeferredValue, useMemo, useState } from "react";
import { tv } from "tailwind-variants";

import { Button } from "#src/components/ui/button.tsx";
import { MetricGrid, MetricItem } from "#src/components/ui/metric-grid.tsx";
import { PageHeader } from "#src/components/ui/page-header.tsx";
import { SegmentedControl } from "#src/components/ui/segmented-control.tsx";
import { SearchField } from "#src/components/ui/search-field.tsx";
import { TabsIndicator, TabsList, TabsPanel, TabsRoot, TabsTab } from "#src/components/ui/tabs.tsx";
import { createBrowserApiClient } from "#src/lib/api/browser-client.ts";
import { readCsrfCredential } from "#src/lib/api/browser-security.ts";
import { useExclusiveMutation } from "#src/lib/use-exclusive-mutation.ts";

type View = "active" | "archived";
type ClassificationFilter = "all" | NotificationInboxItem["classification"];

const notificationCenterStyles = tv({
  slots: {
    root: "mx-auto grid w-full max-w-[82rem] gap-6 px-[clamp(1.25rem,4vw,3.5rem)] py-[clamp(2rem,4vw,3.75rem)] outline-none max-[48rem]:px-4 max-[48rem]:py-5",
    feedback: "sticky top-3 z-[var(--n-z-sticky)] m-0 rounded-md border border-muted-border bg-raised px-4 py-3 text-sm shadow-md",
    feedbackError: "border-danger/40 text-danger",
    feedbackSuccess: "border-success/40 text-success",
    toolbar: "flex flex-wrap items-end justify-between gap-3 rounded-xl border border-muted-border bg-surface p-4",
    search: "min-w-[min(100%,18rem)] flex-1",
    inbox: "rounded-xl border border-muted-border bg-surface p-[clamp(1rem,3vw,2rem)]",
    heading: "flex flex-wrap items-center justify-between gap-3",
    headingCopy: "grid gap-1",
    eyebrow: "m-0 text-xs font-semibold text-accent-foreground",
    headingTitle: "m-0 text-lg font-semibold",
    headingCount: "text-xs font-medium text-muted-foreground",
    tabs: "flex flex-wrap gap-2",
    searchScope: "mt-4 mb-0 text-xs text-muted-foreground",
    list: "my-5 grid max-h-[42rem] list-none gap-3 overflow-auto p-0 [scrollbar-gutter:stable]",
    item: "grid grid-cols-[0.5rem_minmax(0,1fr)_auto] items-start gap-3 rounded-lg border border-muted-border bg-surface p-4 max-[48rem]:grid-cols-[0.5rem_minmax(0,1fr)]",
    itemUnread: "border-l-primary bg-selected",
    indicator: "mt-1.5 size-2 rounded-full bg-strong-border",
    indicatorUnread: "bg-primary",
    itemCopy: "grid min-w-0 gap-1",
    itemMeta: "m-0 flex flex-wrap items-center justify-between gap-2 text-xs text-muted-foreground",
    itemTitle: "m-0 text-sm font-semibold",
    itemSummary: "m-0 text-sm leading-relaxed text-muted-foreground",
    itemDetail: "text-xs text-muted-foreground",
    itemActions: "flex flex-wrap gap-2 max-[48rem]:col-start-2",
    empty: "grid min-h-48 place-content-center justify-items-center gap-2 rounded-lg border border-dashed border-muted-border p-6 text-center",
    emptyTitle: "font-semibold",
    emptyDescription: "m-0 text-sm text-muted-foreground"
  }
});

export interface NotificationCenterProps {
  readonly initialActive: NotificationInbox;
  readonly initialArchived: NotificationInbox;
}

export function NotificationCenter({
  initialActive,
  initialArchived
}: NotificationCenterProps) {
  const mutation = useExclusiveMutation();
  const [view, setView] = useState<View>("active");
  const [active, setActive] = useState(initialActive);
  const [archived, setArchived] = useState(initialArchived);
  const [query, setQuery] = useState("");
  const deferredQuery = useDeferredValue(query);
  const [classification, setClassification] = useState<ClassificationFilter>("all");
  const [feedback, setFeedback] = useState<{ readonly error: boolean; readonly text: string }>();
  const styles = notificationCenterStyles();
  const collection = view === "active" ? active : archived;
  const normalizedQuery = deferredQuery.trim().toLocaleLowerCase("ko-KR");
  const visibleItems = useMemo(() => collection.items.filter((item) => (
    (classification === "all" || item.classification === classification)
    && (normalizedQuery === "" || `${item.title} ${item.summary}`.toLocaleLowerCase("ko-KR").includes(normalizedQuery))
  )), [classification, collection.items, normalizedQuery]);

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

  return (
    <main id="main-content" className={styles.root()} tabIndex={-1}>
      <PageHeader eyebrow="활동" title="알림" description="보안, 계정 접근, 협업 및 운영 변경 사항을 한곳에서 확인하세요." />

      {feedback ? <p className={styles.feedback({ className: feedback.error ? styles.feedbackError() : styles.feedbackSuccess() })} role={feedback.error ? "alert" : "status"} aria-live="polite">{feedback.text}</p> : null}

      <MetricGrid className="mt-5" aria-label="알림 요약">
        <MetricItem label="읽지 않음" value={active.unreadCount} description="우선 확인이 필요한 새 소식" />
        <MetricItem label="활성" value={active.items.length} description="현재 목록에 불러온 항목" />
        <MetricItem label="보관됨" value={archived.items.length} description="필요할 때 다시 복원 가능" />
      </MetricGrid>

      <section className={styles.toolbar()} aria-label="알림 검색 및 분류">
        <SearchField className={styles.search()} label="알림 검색" value={query} onChange={(event) => setQuery(event.currentTarget.value)} placeholder="제목 또는 내용 검색" />
        <SegmentedControl
          aria-label="알림 분류"
          value={classification}
          onValueChange={setClassification}
          options={[
            { value: "all", label: "전체" },
            { value: "critical_security", label: "보안" },
            { value: "collaboration", label: "협업" },
            { value: "operations", label: "운영" },
            { value: "account_access", label: "계정" }
          ]}
        />
      </section>

      <div>
        <section className={styles.inbox()} aria-labelledby="notification-inbox-title"><TabsRoot value={view} onValueChange={(value) => setView(value as View)}>
          <div className={styles.heading()}>
            <div className={styles.headingCopy()}>
              <p className={styles.eyebrow()}>읽지 않음 {active.unreadCount}개</p>
              <h2 className={styles.headingTitle()} id="notification-inbox-title">최근 알림 <small className={styles.headingCount()}>{visibleItems.length} / {collection.items.length}</small></h2>
            </div>
            <TabsList className={styles.tabs()} aria-label="알림 목록">
              <TabsTab value="active" aria-label="활성 알림">활성</TabsTab>
              <TabsTab value="archived" aria-label="보관된 알림">보관됨</TabsTab>
              <TabsIndicator />
            </TabsList>
          </div>
          <TabsPanel value={view} aria-busy={query !== deferredQuery}>
            {collection.nextCursor !== null ? <p className={styles.searchScope()}>현재 불러온 알림에서 검색합니다. 더 보기를 누르면 검색 범위가 넓어집니다.</p> : null}
            {visibleItems.length === 0 ? (
              <div className={styles.empty()}><strong className={styles.emptyTitle()}>{view === "active" ? "새 알림이 없습니다." : "보관된 알림이 없습니다."}</strong><p className={styles.emptyDescription()}>{view === "active" ? "새로운 변경 사항이 생기면 이곳에 표시됩니다." : "보관한 알림을 다시 확인할 수 있습니다."}</p></div>
            ) : (
              <ol className={styles.list()} aria-live="polite">
                {visibleItems.map((item) => (
                  <li key={item.id} className={styles.item({ className: item.status === "unread" ? styles.itemUnread() : undefined })}>
                    <span className={styles.indicator({ className: item.status === "unread" ? styles.indicatorUnread() : undefined })} aria-label={item.status === "unread" ? "읽지 않음" : "읽음"} />
                    <div className={styles.itemCopy()}>
                      <p className={styles.itemMeta()}><span>{labelClassification(item.classification)}</span><time dateTime={item.occurredAt}>{formatDate(item.occurredAt)}</time></p>
                      <h3 className={styles.itemTitle()}>{item.title}</h3>
                      <p className={styles.itemSummary()}>{item.summary}</p>
                      {item.occurrenceCount > 1 ? <small className={styles.itemDetail()}>{item.occurrenceCount}회 발생</small> : null}
                      {item.actionState !== "none" ? <small className={styles.itemDetail()}>처리 상태: {item.actionState}</small> : null}
                    </div>
                    <div className={styles.itemActions()}>
                      {item.status === "unread" ? <Button aria-label="읽음으로 표시" disabled={mutation.isPending} onClick={() => changeStatus(item, "read")}>읽음</Button> : null}
                      {item.status === "read" ? <Button aria-label="읽지 않음으로 표시" disabled={mutation.isPending} onClick={() => changeStatus(item, "unread")}>읽지 않음</Button> : null}
                      {item.status === "archived" ? <Button aria-label="알림 복원" disabled={mutation.isPending} onClick={() => changeStatus(item, "read")}>복원</Button> : <Button aria-label="알림 보관" variant="ghost" disabled={mutation.isPending} onClick={() => changeStatus(item, "archived")}>보관</Button>}
                    </div>
                  </li>
                ))}
              </ol>
            )}
            {collection.nextCursor !== null ? <Button aria-label="알림 더 보기" disabled={mutation.isPending} onClick={loadMore}>{mutation.isPending ? "불러오는 중…" : "더 보기"}</Button> : null}
          </TabsPanel>
        </TabsRoot></section>
      </div>
    </main>
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
  const labels = {
    account_access: "계정과 접근",
    collaboration: "협업",
    critical_security: "중요 보안",
    operations: "운영"
  } satisfies Record<NotificationInboxItem["classification"], string>;
  return labels[value];
}

function formatDate(value: string) {
  return new Intl.DateTimeFormat("ko-KR", { dateStyle: "medium", timeStyle: "short" }).format(new Date(value));
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
