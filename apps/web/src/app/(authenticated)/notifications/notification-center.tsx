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
import { useDeferredValue, useMemo, useState } from "react";
import type { FormEvent } from "react";

import { Button } from "#src/components/ui/button.tsx";
import { SwitchField } from "#src/components/ui/switch.tsx";
import { SegmentedControl } from "#src/components/ui/segmented-control.tsx";
import { createBrowserApiClient } from "#src/lib/api/browser-client.ts";
import { readCsrfCredential } from "#src/lib/api/browser-security.ts";
import { useExclusiveMutation } from "#src/lib/use-exclusive-mutation.ts";

type View = "active" | "archived";
type ClassificationFilter = "all" | NotificationInboxItem["classification"];

export interface NotificationCenterProps {
  readonly initialActive: NotificationInbox;
  readonly initialArchived: NotificationInbox;
  readonly initialPreferences: NotificationPreferences;
}

export function NotificationCenter({
  initialActive,
  initialArchived,
  initialPreferences
}: NotificationCenterProps) {
  const mutation = useExclusiveMutation();
  const [view, setView] = useState<View>("active");
  const [active, setActive] = useState(initialActive);
  const [archived, setArchived] = useState(initialArchived);
  const [preferences, setPreferences] = useState(initialPreferences);
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
        setFeedback({ error: false, text: "이메일 알림 설정을 저장했습니다." });
      } catch (error) {
        setFeedback(notificationFailure(error));
      }
    });
  }

  return (
    <main id="main-content" className="workspace-page notification-page">
      <header className="workspace-page__intro">
        <p className="eyebrow">계정 알림함</p>
        <h1>알림</h1>
        <p>보안, 계정 접근, 협업 및 운영 변경 사항을 한곳에서 확인하세요.</p>
      </header>

      {feedback ? <p className={`notification-feedback notification-feedback--${feedback.error ? "error" : "success"}`} role={feedback.error ? "alert" : "status"} aria-live="polite">{feedback.text}</p> : null}

      <section className="product-metrics" aria-label="알림 요약">
        <article><span>읽지 않은 알림</span><strong>{active.unreadCount}</strong><small>우선 확인이 필요한 새 소식</small></article>
        <article><span>활성 알림</span><strong>{active.items.length}</strong><small>현재 목록에 불러온 항목</small></article>
        <article><span>보관한 알림</span><strong>{archived.items.length}</strong><small>필요할 때 다시 복원 가능</small></article>
      </section>

      <section className="product-toolbar notification-toolbar" aria-label="알림 검색 및 분류">
        <label className="product-search"><span aria-hidden="true">⌕</span><span className="sr-only">알림 검색</span><input value={query} onChange={(event) => setQuery(event.currentTarget.value)} placeholder="제목 또는 내용 검색" /></label>
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

      <div className="notification-layout">
        <aside className="notification-preferences" aria-labelledby="notification-preferences-title">
          <div>
            <p className="eyebrow">이메일 채널</p>
            <h2 id="notification-preferences-title">이메일 알림</h2>
            <p>{preferences.smtpConfigured ? "이메일 알림을 받을 수 있습니다." : "SMTP가 설정되지 않았습니다. 선택한 설정은 저장되며 앱 내 알림은 계속 사용할 수 있습니다."}</p>
          </div>
          <form onSubmit={savePreferences} aria-busy={mutation.isPending}>
            <Preference name="criticalSecurity" label="중요 보안" description="SMTP 사용 시 항상 발송됩니다." checked disabled />
            <Preference name="accountAccess" label="계정과 접근" description="비밀번호, MFA, 멤버십 및 권한 변경" checked={preferences.accountAccess} />
            <Preference name="collaboration" label="협업" description="초대와 공유 프로젝트 활동" checked={preferences.collaboration} />
            <Preference name="operations" label="운영" description="관리자를 위한 인스턴스 상태와 전달 장애" checked={preferences.operations} />
            <Button aria-label="알림 설정 저장" type="submit" variant="primary" disabled={mutation.isPending}>{mutation.isPending ? "저장 중…" : "설정 저장"}</Button>
          </form>
        </aside>

        <section className="notification-inbox" aria-labelledby="notification-inbox-title">
          <div className="notification-heading">
            <div>
              <p className="eyebrow">읽지 않음 {active.unreadCount}개</p>
              <h2 id="notification-inbox-title">최근 알림 <small>{visibleItems.length} / {collection.items.length}</small></h2>
            </div>
            <div className="notification-tabs" role="tablist" aria-label="알림 목록">
              <Button id="active-notifications-tab" aria-controls="notification-list-panel" aria-label="활성 알림" role="tab" aria-selected={view === "active"} variant={view === "active" ? "primary" : "secondary"} onClick={() => setView("active")}>활성</Button>
              <Button id="archived-notifications-tab" aria-controls="notification-list-panel" aria-label="보관된 알림" role="tab" aria-selected={view === "archived"} variant={view === "archived" ? "primary" : "secondary"} onClick={() => setView("archived")}>보관됨</Button>
            </div>
          </div>
          <div id="notification-list-panel" role="tabpanel" aria-busy={query !== deferredQuery} aria-labelledby={view === "active" ? "active-notifications-tab" : "archived-notifications-tab"}>
            {collection.nextCursor !== null ? <p className="notification-search-scope">현재 불러온 알림에서 검색합니다. 더 보기를 누르면 검색 범위가 넓어집니다.</p> : null}
            {visibleItems.length === 0 ? (
              <div className="notification-empty"><strong>{view === "active" ? "새 알림이 없습니다." : "보관된 알림이 없습니다."}</strong><p>{view === "active" ? "새로운 변경 사항이 생기면 이곳에 표시됩니다." : "보관한 알림을 다시 확인할 수 있습니다."}</p></div>
            ) : (
              <ol className="notification-list" aria-live="polite">
                {visibleItems.map((item) => (
                  <li key={item.id} className={`notification-item notification-item--${item.status}`}>
                    <span className="notification-item__indicator" aria-label={item.status === "unread" ? "읽지 않음" : "읽음"} />
                    <div className="notification-item__copy">
                      <p className="notification-item__meta"><span>{labelClassification(item.classification)}</span><time dateTime={item.occurredAt}>{formatDate(item.occurredAt)}</time></p>
                      <h3>{item.title}</h3>
                      <p>{item.summary}</p>
                      {item.occurrenceCount > 1 ? <small>{item.occurrenceCount}회 발생</small> : null}
                      {item.actionState !== "none" ? <small>처리 상태: {item.actionState}</small> : null}
                    </div>
                    <div className="notification-item__actions">
                      {item.status === "unread" ? <Button aria-label="읽음으로 표시" disabled={mutation.isPending} onClick={() => changeStatus(item, "read")}>읽음</Button> : null}
                      {item.status === "read" ? <Button aria-label="읽지 않음으로 표시" disabled={mutation.isPending} onClick={() => changeStatus(item, "unread")}>읽지 않음</Button> : null}
                      {item.status === "archived" ? <Button aria-label="알림 복원" disabled={mutation.isPending} onClick={() => changeStatus(item, "read")}>복원</Button> : <Button aria-label="알림 보관" variant="ghost" disabled={mutation.isPending} onClick={() => changeStatus(item, "archived")}>보관</Button>}
                    </div>
                  </li>
                ))}
              </ol>
            )}
            {collection.nextCursor !== null ? <Button aria-label="알림 더 보기" disabled={mutation.isPending} onClick={loadMore}>{mutation.isPending ? "불러오는 중…" : "더 보기"}</Button> : null}
          </div>
        </section>
      </div>
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
    <SwitchField appearance="card" name={name} label={label} description={description} defaultChecked={checked} disabled={disabled} />
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
