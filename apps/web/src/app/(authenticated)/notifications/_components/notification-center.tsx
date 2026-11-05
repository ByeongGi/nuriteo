"use client";

import type { NotificationInbox, NotificationInboxItem } from "@nuriteo/api-client";
import Link from "next/link";
import { tv } from "tailwind-variants";

import { useNotificationCenter } from "@/app/(authenticated)/notifications/_hooks/use-notification-center.ts";
import { Button } from "@/components/ui/button.tsx";
import { PageHeader } from "@/components/ui/page-header.tsx";
import { SegmentedControl } from "@/components/ui/segmented-control.tsx";
import { SearchField } from "@/components/ui/search-field.tsx";
import { TabsIndicator, TabsList, TabsPanel, TabsRoot, TabsTab } from "@/components/ui/tabs.tsx";

const notificationCenterStyles = tv({
  slots: {
    root: "mx-auto grid w-full max-w-[68rem] gap-4 px-6 py-8 outline-none max-[48rem]:px-4 max-[48rem]:py-5",
    settingsLink: "inline-flex min-h-9 items-center justify-center rounded-md border border-strong-border bg-surface px-3 text-sm font-semibold text-foreground no-underline hover:bg-hover",
    feedback: "sticky top-3 z-[var(--n-z-sticky)] m-0 rounded-md border border-muted-border bg-raised px-4 py-3 text-sm shadow-md",
    feedbackError: "border-danger/40 text-danger",
    feedbackSuccess: "border-success/40 text-success",
    toolbar: "flex flex-wrap items-end justify-between gap-2 border-b border-muted-border px-4 py-3",
    search: "min-w-[min(100%,18rem)] flex-1",
    inbox: "overflow-hidden rounded-lg border border-muted-border bg-surface",
    heading: "flex flex-wrap items-center justify-between gap-3 border-b border-muted-border px-4 py-3",
    headingCopy: "grid gap-1",
    eyebrow: "m-0 text-xs font-semibold text-accent-foreground",
    headingTitle: "m-0 text-sm font-semibold",
    headingCount: "text-xs font-medium text-muted-foreground",
    tabs: "flex flex-wrap gap-2",
    searchScope: "m-0 border-b border-muted-border px-4 py-2 text-xs text-muted-foreground",
    list: "m-0 grid list-none p-0",
    item: "grid min-h-[5.75rem] grid-cols-[0.5rem_minmax(0,1fr)_auto] items-start gap-3 px-4 py-3 transition-colors [content-visibility:auto] [contain-intrinsic-size:0_5.75rem] hover:bg-hover [&+&]:border-t [&+&]:border-muted-border max-[48rem]:grid-cols-[0.5rem_minmax(0,1fr)]",
    itemUnread: "bg-selected/60",
    indicator: "mt-1.5 size-2 rounded-full bg-strong-border",
    indicatorUnread: "bg-primary",
    itemCopy: "grid min-w-0 gap-1",
    itemMeta: "m-0 flex flex-wrap items-center gap-2 text-xs text-muted-foreground [&_time]:ml-auto",
    classification: "rounded-full bg-subtle px-2 py-0.5 text-[var(--n-font-size-2xs)] font-medium text-muted-foreground",
    itemTitle: "m-0 text-sm font-semibold",
    itemSummary: "m-0 text-sm leading-relaxed text-muted-foreground",
    itemDetail: "text-xs text-muted-foreground",
    itemActions: "flex flex-wrap gap-2 max-[48rem]:col-start-2",
    empty: "grid min-h-64 place-content-center justify-items-center gap-2 p-8 text-center",
    emptyTitle: "font-semibold",
    emptyDescription: "m-0 max-w-md text-sm text-muted-foreground",
    more: "m-4"
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
  const styles = notificationCenterStyles();
  const {
    active,
    archived,
    changeStatus,
    classification,
    collection,
    feedback,
    isFiltering,
    isPending,
    loadMore,
    query,
    selectView,
    setClassification,
    setQuery,
    view,
    visibleItems
  } = useNotificationCenter(initialActive, initialArchived);

  return (
    <main id="main-content" className={styles.root()} tabIndex={-1}>
      <PageHeader
        density="compact"
        eyebrow="활동"
        title="알림"
        description="보안, 계정 접근, 협업 및 운영 변경 사항을 한곳에서 확인하세요."
        actions={<Link className={styles.settingsLink()} href="/account/notifications">알림 수신 설정</Link>}
      />

      {feedback ? <p className={styles.feedback({ className: (function () {
    if (feedback.error) {
        return (styles.feedbackError());
    }
    return (styles.feedbackSuccess());
})() })} role={(function () {
    if (feedback.error) {
        return ("alert");
    }
    return ("status");
})()} aria-live="polite">{feedback.text}</p> : null}

      <section className={styles.inbox()} aria-labelledby="notification-inbox-title"><TabsRoot value={view} onValueChange={selectView}>
          <div className={styles.heading()}>
            <div className={styles.headingCopy()}>
              <p className={styles.eyebrow()}>{active.unreadCount > 0 ? `읽지 않은 알림 ${active.unreadCount}개` : "모두 확인했습니다"}</p>
              <h2 className={styles.headingTitle()} id="notification-inbox-title">알림 인박스 <small className={styles.headingCount()}>{visibleItems.length} / {collection.items.length}</small></h2>
            </div>
            <TabsList className={styles.tabs()} aria-label="알림 목록">
              <TabsTab value="active" aria-label="활성 알림">받은 알림 {active.items.length}</TabsTab>
              <TabsTab value="archived" aria-label="보관된 알림">보관함 {archived.items.length}</TabsTab>
              <TabsIndicator />
            </TabsList>
          </div>
          <section className={styles.toolbar()} aria-label="알림 검색 및 분류">
            <SearchField density="compact" className={styles.search()} label="알림 검색" value={query} onChange={(event) => setQuery(event.currentTarget.value)} placeholder="제목 또는 내용 검색" />
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
          <TabsPanel value={view} aria-busy={isFiltering}>
            {collection.nextCursor !== null ? <p className={styles.searchScope()}>현재 불러온 알림에서 검색합니다. 더 보기를 누르면 검색 범위가 넓어집니다.</p> : null}
            {visibleItems.length === 0 ? (
              <div className={styles.empty()}><strong className={styles.emptyTitle()}>{(function () {
    if (view === "active") {
        return ("새 알림이 없습니다.");
    }
    return ("보관된 알림이 없습니다.");
})()}</strong><p className={styles.emptyDescription()}>{(function () {
    if (view === "active") {
        return ("새로운 변경 사항이 생기면 이곳에 표시됩니다.");
    }
    return ("보관한 알림을 다시 확인할 수 있습니다.");
})()}</p></div>
            ) : (
              <ol className={styles.list()} aria-live="polite">
                {visibleItems.map((item) => (
                  <li key={item.id} className={styles.item({ className: (function () {
    if (item.status === "unread") {
        return (styles.itemUnread());
    }
    return (undefined);
})() })}>
                    <span className={styles.indicator({ className: (function () {
    if (item.status === "unread") {
        return (styles.indicatorUnread());
    }
    return (undefined);
})() })} aria-label={(function () {
    if (item.status === "unread") {
        return ("읽지 않음");
    }
    return ("읽음");
})()} />
                    <div className={styles.itemCopy()}>
                      <p className={styles.itemMeta()}><span className={styles.classification()}>{labelClassification(item.classification)}</span><time dateTime={item.occurredAt}>{formatDate(item.occurredAt)}</time></p>
                      <h3 className={styles.itemTitle()}>{item.title}</h3>
                      <p className={styles.itemSummary()}>{item.summary}</p>
                      {(function () {
    if (item.occurrenceCount > 1) {
        return (<small className={styles.itemDetail()}>{item.occurrenceCount}회 발생</small>);
    }
    return (null);
})()}
                      {(function () {
    if (item.actionState !== "none") {
        return (<small className={styles.itemDetail()}>처리 상태: {item.actionState}</small>);
    }
    return (null);
})()}
                    </div>
                    <div className={styles.itemActions()}>
                      {(function () {
    if (item.status === "unread") {
        return (<Button aria-label="읽음으로 표시" disabled={isPending} onClick={() => changeStatus(item, "read")}>읽음</Button>);
    }
    return (null);
})()}
                      {(function () {
    if (item.status === "read") {
        return (<Button aria-label="읽지 않음으로 표시" disabled={isPending} onClick={() => changeStatus(item, "unread")}>읽지 않음</Button>);
    }
    return (null);
})()}
                      {(function () {
    if (item.status === "archived") {
        return (<Button aria-label="알림 복원" disabled={isPending} onClick={() => changeStatus(item, "read")}>복원</Button>);
    }
    return (<Button aria-label="알림 보관" variant="ghost" disabled={isPending} onClick={() => changeStatus(item, "archived")}>보관</Button>);
})()}
                    </div>
                  </li>
                ))}
              </ol>
            )}
            {collection.nextCursor !== null ? <Button className={styles.more()} aria-label="알림 더 보기" disabled={isPending} onClick={loadMore}>{(function () {
    if (isPending) {
        return ("불러오는 중…");
    }
    return ("알림 더 보기");
})()}</Button> : null}
          </TabsPanel>
        </TabsRoot></section>
    </main>
  );
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
