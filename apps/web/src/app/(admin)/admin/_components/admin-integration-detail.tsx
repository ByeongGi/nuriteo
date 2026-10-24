import Link from "next/link";
import type { ReactNode } from "react";
import { tv } from "tailwind-variants";

import { Badge } from "#src/components/ui/badge.tsx";
import { AdminSection, AdminSectionHeading } from "#src/app/(admin)/admin/_components/admin-surface.tsx";

const detailStyles = tv({
  slots: {
    backLink: "inline-flex w-fit items-center gap-2 text-xs font-medium text-muted-foreground hover:text-foreground",
    summary: "grid grid-cols-[minmax(0,1.25fr)_minmax(22rem,1fr)] border-t border-muted-border max-[48rem]:grid-cols-1",
    summaryCopy: "grid content-start gap-2 px-5 py-5 max-[37.5rem]:px-4",
    summaryTitle: "m-0 text-base font-semibold text-foreground",
    summaryDescription: "m-0 max-w-[40rem] text-sm leading-6 text-muted-foreground",
    metrics: "m-0 grid grid-cols-2 border-l border-muted-border max-[48rem]:border-l-0 max-[48rem]:border-t max-[32rem]:grid-cols-1",
    metric: "grid content-center gap-1 border-b border-muted-border px-5 py-3.5 even:border-l last:border-b-0 nth-last-2:border-b-0 max-[32rem]:border-l-0 max-[32rem]:nth-last-2:border-b max-[37.5rem]:px-4",
    metricLabel: "text-xs text-muted-foreground",
    metricValue: "m-0 min-w-0 text-sm font-semibold text-foreground [overflow-wrap:anywhere]",
    sectionBody: "border-t border-muted-border px-4 py-4",
    readOnlyGrid: "m-0 grid grid-cols-2 gap-x-8 gap-y-4 max-[40rem]:grid-cols-1",
    readOnlyItem: "grid min-w-0 gap-1",
    readOnlyLabel: "text-xs text-muted-foreground",
    readOnlyValue: "m-0 text-sm font-medium text-foreground [overflow-wrap:anywhere]",
    actionBar: "flex flex-wrap items-center justify-between gap-3 border-t border-muted-border px-4 py-3 max-[37.5rem]:flex-col max-[37.5rem]:items-stretch max-[37.5rem]:[&_[data-slot=button]]:w-full",
    actionNote: "m-0 max-w-[40rem] text-xs leading-5 text-muted-foreground",
    danger: "border-danger/30",
    dangerCopy: "text-danger"
  }
});

export interface IntegrationMetric {
  readonly label: string;
  readonly value: ReactNode;
}

export function AdminIntegrationBackLink({ href, children }: { readonly href: string; readonly children: ReactNode }) {
  return <Link className={detailStyles().backLink()} href={href}><span aria-hidden="true">←</span>{children}</Link>;
}

export function AdminIntegrationSummary({
  description,
  metrics,
  state,
  title
}: {
  readonly description: ReactNode;
  readonly metrics: readonly IntegrationMetric[];
  readonly state: "active" | "disabled";
  readonly title: ReactNode;
}) {
  const styles = detailStyles();
  return (
    <AdminSection aria-label="연동 상태 요약">
      <div className={styles.summary()}>
        <div className={styles.summaryCopy()}>
          <Badge className="justify-self-start" size="sm" tone={state === "active" ? "success" : "neutral"} variant="status">
            {state === "active" ? "서비스에서 사용 중" : "설정 및 검증 필요"}
          </Badge>
          <h2 className={styles.summaryTitle()}>{title}</h2>
          <p className={styles.summaryDescription()}>{description}</p>
        </div>
        <dl className={styles.metrics()}>
          {metrics.map((metric) => (
            <div className={styles.metric()} key={metric.label}>
              <dt className={styles.metricLabel()}>{metric.label}</dt>
              <dd className={styles.metricValue()}>{metric.value}</dd>
            </div>
          ))}
        </dl>
      </div>
    </AdminSection>
  );
}

export function AdminIntegrationSection({
  action,
  children,
  description,
  title
}: {
  readonly action?: ReactNode;
  readonly children: ReactNode;
  readonly description: ReactNode;
  readonly title: ReactNode;
}) {
  const styles = detailStyles();
  return (
    <AdminSection>
      <AdminSectionHeading>
        <div><h2>{title}</h2><p className="mt-1 text-xs leading-5 text-muted-foreground">{description}</p></div>
        {action}
      </AdminSectionHeading>
      <div className={styles.sectionBody()}>{children}</div>
    </AdminSection>
  );
}

export function AdminIntegrationReadOnlyGrid({ items }: { readonly items: readonly IntegrationMetric[] }) {
  const styles = detailStyles();
  return (
    <dl className={styles.readOnlyGrid()}>
      {items.map((item) => (
        <div className={styles.readOnlyItem()} key={item.label}>
          <dt className={styles.readOnlyLabel()}>{item.label}</dt>
          <dd className={styles.readOnlyValue()}>{item.value}</dd>
        </div>
      ))}
    </dl>
  );
}

export function AdminIntegrationActionBar({ children, note }: { readonly children: ReactNode; readonly note: ReactNode }) {
  const styles = detailStyles();
  return <div className={styles.actionBar()}><p className={styles.actionNote()}>{note}</p><div className="flex flex-wrap gap-2 max-[37.5rem]:contents">{children}</div></div>;
}

export function AdminIntegrationDangerSection({ children, description, title }: { readonly children: ReactNode; readonly description: ReactNode; readonly title: ReactNode }) {
  const styles = detailStyles();
  return (
    <AdminSection className={styles.danger()}>
      <AdminSectionHeading><div><h2 className={styles.dangerCopy()}>{title}</h2><p className="mt-1 text-xs leading-5 text-muted-foreground">{description}</p></div>{children}</AdminSectionHeading>
    </AdminSection>
  );
}
