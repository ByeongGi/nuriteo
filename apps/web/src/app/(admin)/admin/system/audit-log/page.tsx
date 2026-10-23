import type { Metadata } from "next";
import { tv } from "tailwind-variants";

import { EntryUnavailable } from "#src/app/_components/entry-unavailable.tsx";
import { Badge } from "#src/components/ui/badge.tsx";
import { PageHeader } from "#src/components/ui/page-header.tsx";
import { safeRequestReference } from "#src/lib/api/presentation-error.ts";
import { createServerApiClient } from "#src/lib/api/server-client.ts";

export const metadata: Metadata = { title: "감사 로그" };

interface AuditEvent {
  readonly id: string;
  readonly occurredAt: string;
  readonly actorDisplayName: string | null;
  readonly actorId: string;
  readonly actionCode: string;
  readonly targetType: string;
  readonly targetId: string;
  readonly result: string;
}

const styles = tv({
  slots: {
    root: "mx-auto grid w-full max-w-[82rem] content-start gap-6 px-[clamp(1rem,4vw,3rem)] py-[clamp(1.5rem,4vw,3rem)]",
    panel: "overflow-hidden rounded-xl border border-muted-border bg-surface shadow-xs",
    heading: "flex items-center justify-between gap-3 border-b border-muted-border px-5 py-4",
    list: "m-0 grid list-none divide-y divide-muted-border p-0",
    item: "grid grid-cols-[minmax(12rem,1fr)_minmax(12rem,1fr)_auto] items-center gap-4 px-5 py-4 max-[48rem]:grid-cols-1",
    primary: "grid min-w-0 gap-1",
    title: "truncate font-semibold text-foreground",
    detail: "truncate text-sm text-muted-foreground",
    time: "whitespace-nowrap text-xs text-subtle-foreground",
    empty: "m-0 px-5 py-10 text-center text-sm text-muted-foreground"
  }
});

export default async function AdminAuditLogPage() {
  try {
    const response = await (await createServerApiClient()).get<unknown>("/admin/audit-events?limit=50");
    const events = parseEvents(response.data);
    const css = styles();
    return <main id="main-content" className={css.root()} tabIndex={-1}>
      <PageHeader eyebrow="시스템" title="감사 로그" description="관리자와 시스템의 주요 변경 이력을 최신 순서로 확인합니다." />
      <section className={css.panel()} aria-labelledby="audit-events-title">
        <header className={css.heading()}><h2 id="audit-events-title">최근 이벤트</h2><Badge>{events.length}개 표시</Badge></header>
        {events.length === 0 ? <p className={css.empty()}>표시할 감사 이벤트가 없습니다.</p> : <ol className={css.list()}>{events.map((event) => <li className={css.item()} key={event.id}>
          <div className={css.primary()}><span className={css.title()}>{event.actionCode}</span><span className={css.detail()}>{event.actorDisplayName ?? event.actorId}</span></div>
          <div className={css.primary()}><span className={css.title()}>{event.targetType}</span><span className={css.detail()}>{event.targetId}</span></div>
          <div className={css.primary()}><Badge tone={event.result === "succeeded" ? "success" : "danger"}>{event.result}</Badge><time className={css.time()} dateTime={event.occurredAt}>{formatDate(event.occurredAt)}</time></div>
        </li>)}</ol>}
      </section>
    </main>;
  } catch (error) {
    return <EntryUnavailable title="감사 로그를 일시적으로 불러올 수 없습니다" description="감사 이벤트를 안전하게 조회하지 못했습니다. 변경되거나 삭제된 기록은 없습니다." reference={safeRequestReference(error)} retryHref="/admin/system/audit-log" />;
  }
}

function parseEvents(value: unknown): readonly AuditEvent[] {
  if (!isRecord(value) || !Array.isArray(value.items) || value.items.length > 100) throw new TypeError("invalid audit event collection");
  return value.items.map((item) => {
    if (!isRecord(item)) throw new TypeError("invalid audit event");
    return {
      id: text(item.id), occurredAt: text(item.occurredAt), actorDisplayName: nullableText(item.actorDisplayName),
      actorId: text(item.actorId), actionCode: text(item.actionCode), targetType: text(item.targetType),
      targetId: text(item.targetId), result: text(item.result)
    };
  });
}

function isRecord(value: unknown): value is Record<string, unknown> { return value !== null && typeof value === "object" && !Array.isArray(value); }
function text(value: unknown): string { if (typeof value !== "string" || value.length === 0 || value.length > 2048) throw new TypeError("invalid audit event field"); return value; }
function nullableText(value: unknown): string | null { return value === null ? null : text(value); }
function formatDate(value: string): string { const date = new Date(value); return Number.isNaN(date.valueOf()) ? value : new Intl.DateTimeFormat("ko-KR", { dateStyle: "medium", timeStyle: "short" }).format(date); }
